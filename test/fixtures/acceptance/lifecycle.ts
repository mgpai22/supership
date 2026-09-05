import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "../../../src/contracts.ts";
import { commands, dynamicScenarios, type Scenario } from "./scenarios.ts";
import { runScenario, type Evidence, type Snapshot } from "./runner.ts";

type RegisterTest = (name: string, run: () => Promise<void>, timeout?: number) => void;
type RecordEvidence = (scenario: Scenario, result: Evidence, assertions: string[]) => RunRecord;

function at(result: Evidence, label: string): Snapshot {
  const snapshot = result.snapshots.find(snapshot => snapshot.label === label);
  assert.ok(snapshot, `Missing observed ${label} boundary: ${result.root}`);
  return snapshot;
}
function inputs(result: Evidence): Array<{ time: number; text: string; reason: string }> {
  return readFileSync(join(result.root, "tui-inputs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function assertPreservedRestart(previous: Evidence, resumed: Evidence) {
  assert.notEqual(resumed.root, previous.root, "Each host needs a new logging root and HOME");
  assert.equal(resumed.cwd, previous.cwd, "Resume must reuse the original checkout");
  assert.equal(resumed.slug, previous.slug);
  assert.equal(resumed.state?.runId, previous.state?.runId, `Resume changed logical run identity: ${resumed.root}`);
  assert.notEqual(readFileSync(join(resumed.root, "parent-session.txt"), "utf8"), readFileSync(join(previous.root, "parent-session.txt"), "utf8"));
  const before = at(resumed, "before-resume"), stopped = at(previous, "host-ended");
  assert.deepEqual(before.files, stopped.files, "No setup step may rewrite retained effects or durable state");
  assert.ok(at(resumed, "host-ended").eventsLog.startsWith(stopped.eventsLog), "Resume must retain the complete event prefix");
  assert.ok(inputs(resumed).some(input => input.text === `/${resumed.state!.invocation.command} --resume ${previous.slug}\r`));
}
function assertNoReplay(result: Evidence) {
  assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write").length, 0, `Interrupted mutations replayed before a trusted choice: ${result.root}`);
  const before = at(result, "before-resume").state!;
  const resumed = result.state!;
  assert.equal(resumed.approvals.filter(approval => approval.kind === "recovery").length, before.approvals.filter(approval => approval.kind === "recovery").length, "The driver must leave recovery unanswered");
  assert.notEqual(resumed.lifecycle, "completed", "An ambiguous mutation cannot become successful on resume");
  assert.ok(resumed.recovery, `Resume must retain the recovery decision: ${result.root}`);
}

export function registerLifecycleTests(test: RegisterTest, record: RecordEvidence, run: typeof runScenario = runScenario) {
  test("a second actual host cannot take a live writer while its native mutation remains running", async () => {
    const scenario: Scenario = { id: "lifecycle-live-owner", command: "shipit", reportDelayMs: 45000, builds: [{ id: "mutation", path: "once.txt", content: "live-owner effect\n" }] };
    let refused: Evidence | undefined, owner: RunRecord["owner"] | undefined, stillRunning = false;
    const first = await run(scenario, { cancelAfterWrite: true, settleMs: 500, whileRunning: async live => {
      owner = live.state!.owner;
      refused = await run(scenario, { resume: live, timeout: 30000 });
      const current: RunRecord = JSON.parse(readFileSync(join(live.cwd, ".planning", live.slug, "state.json"), "utf8"));
      stillRunning = current.work.some(work => work.id === "mutation" && work.status === "running");
    } });
    record(scenario, first, ["actual native mutation live during competing startup", "normal slash cancellation after refusal", "retained mutation effects"]);
    assert.ok(refused, `No second native host observed: ${first.root}`);
    record(scenario, refused, ["same-checkout public resume", "live writer refusal", "unchanged durable owner", "no second worker"]);
    assert.ok(stillRunning, "The first native worker must remain live until the second host refuses ownership");
    assert.deepEqual(refused.state!.owner, owner);
    assert.ok(refused.events.some(event => event.event === "diagnostic" && /writer|owner|lease|locked/i.test(String(event.content))), `No live-owner refusal diagnostic: ${refused.root}`);
    assert.equal(refused.events.filter(event => event.event === "provider" && event.packet).length, 0);
    assert.equal(existsSync(join(first.root, "host-controls.jsonl")), false, "The first host must exit through native cancellation, without a forced crash");
    assert.equal(readFileSync(join(first.cwd, "once.txt"), "utf8"), "live-owner effect\n");
  }, 180000);

  for (const command of commands) test(`/${command} retains an interrupted mutation across actual host crash and fresh resume`, async () => {
    const scenario: Scenario = {
      id: `interrupted-${command}`, command, reportDelayMs: 2500,
      builds: command === "superreview" ? [] : [{ id: "mutation", path: "once.txt", content: "retained mutation\n" }],
      ...(command === "superreview" ? { findings: [["repair"], []], fixChanges: true } : {}),
    };
    const crashed = await run(scenario, { tui: true, crashWhen: "write" });
    record(scenario, crashed, ["actual native write before receipt", "actual host SIGKILL", "retained durable files and physical effects"]);
    const before = at(crashed, "before-crash");
    assert.ok(before.state?.work.some(work => work.mutation !== "read-only" && ["running", "awaiting-output"].includes(work.status)));
    assert.ok(crashed.events.some(event => event.event === "tool-result" && event.name === "write" && !event.error));
    assert.ok(existsSync(join(crashed.root, "host-controls.jsonl")));
    const path = command === "superreview" ? "baseline.txt" : "once.txt";
    const bytes = readFileSync(join(crashed.cwd, path), "utf8");
    const resumed = await run(scenario, { resume: crashed });
    record(scenario, resumed, ["public resume with same slug", "new HOME and session", "mandatory ambiguous mutation recovery", "no automatic mutation replay"]);
    assertPreservedRestart(crashed, resumed);
    assertNoReplay(resumed);
    assert.equal(readFileSync(join(resumed.cwd, path), "utf8"), bytes);
    assert.ok(resumed.state!.recovery!.affectedWork.some(item => before.state!.work.some(work => work.id === item.id && work.mutation !== "read-only")));
  }, 240000);

  function shownBeforeApproval(result: Evidence, approval: { createdAt: number } | undefined, marker: string) {
    return readFileSync(join(result.root, "tui-prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(prompt => (!approval || prompt.time <= approval.createdAt) && prompt.screen.replace(/[\s│]/g, "").includes(marker));
  }

  // Owners of a killed host never settle through a later snapshot; only stop remains until they do.
  for (const choice of ["retry", "discard", "stop"] as const) test(`after actual host loss the trusted ${choice} choice ${choice === "stop" ? "cancels with unresolved owners" : "is refused until the lost owner settles"}`, async () => {
    const scenario: Scenario = { id: `lost-owner-${choice}`, command: "shipit", reportDelayMs: 2500, builds: [{ id: "mutation", path: "once.txt", content: "retained bytes\n" }] };
    const crashed = await run(scenario, { tui: true, crashWhen: "write" });
    record(scenario, crashed, ["actual native write before receipt", "actual host SIGKILL"]);
    const resumed = await run(scenario, { resume: crashed, recoveryChoice: choice });
    const state = record(scenario, resumed, ["mandatory recovery prompt after resume", `trusted ${choice} attempt`, "no blind mutation replay", "unsettled owner never counts as complete"]);
    assertPreservedRestart(crashed, resumed);
    const prompt = at(resumed, "recovery-prompt").state!;
    assert.equal(prompt.lifecycle, "blocked"); assert.ok(prompt.recovery?.unresolvedOwners.length, "A killed host leaves its worker unresolved");
    assert.ok(shownBeforeApproval(resumed, undefined, `"kind":"${choice}"`), `The exact ${choice} disposition must display before the trusted key: ${resumed.root}`);
    assert.equal(resumed.events.filter(event => event.event === "tool-call" && event.name === "write").length, 0, "No disposition may replay the interrupted mutation");
    assert.equal(readFileSync(join(resumed.cwd, "once.txt"), "utf8"), "retained bytes\n");
    const mutation = state.work.find(work => work.id === "mutation")!;
    assert.equal(mutation.status, "awaiting-recovery");
    if (choice === "stop") {
      assert.equal(state.lifecycle, "cancelling", `Stop with an unsettled owner must wait for settlement: ${resumed.root}`);
      assert.equal(state.recovery?.intent, "cancel"); assert.ok(state.recovery?.unresolvedOwners.length);
      assert.equal(state.approvals.find(approval => approval.kind === "recovery")?.authority, "omp-tui");
    } else {
      assert.ok(resumed.events.some(event => event.event === "tool-result" && event.error && /unconfirmed-owner/.test(JSON.stringify(event.content))), `The engine must refuse ${choice} for an unsettled owner: ${resumed.root}`);
      assert.equal(state.lifecycle, "blocked"); assert.ok(state.recovery);
      assert.equal(state.approvals.some(approval => approval.kind === "recovery"), false, "A refused disposition records no approval");
    }
  }, 300000);

  for (const choice of ["adopt", "discard", "stop"] as const) test(`a trusted ${choice} choice disposes settled malformed mutation output without replay`, async () => {
    const scenario: Scenario = { id: `disposition-${choice}`, command: "shipit", builds: [{ id: "mutation", path: "once.txt", content: "single mutation\n" }], invalid: { work: "mutation", stages: 3 } };
    const result = await run(scenario, { tui: true, recoveryChoice: choice });
    const state = record(scenario, result, ["settled owner after exhausted corrections", `trusted ${choice} disposition`, "single physical mutation"]);
    const blocked = at(result, "recovery-prompt").state!;
    assert.equal(blocked.lifecycle, "blocked"); assert.equal(blocked.recovery?.primaryReason, "output-attempts-exhausted");
    const approval = state.approvals.find(approval => approval.kind === "recovery");
    assert.ok(approval, `The ${choice} disposition needs a recorded trusted approval: ${result.root}`);
    assert.equal(approval.authority, "omp-tui");
    assert.ok(shownBeforeApproval(result, approval, `"kind":"${choice}"`), `The exact ${choice} disposition must display before the trusted key: ${result.root}`);
    assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write").length, 1, "The mutation happens exactly once");
    assert.equal(readFileSync(join(result.cwd, "once.txt"), "utf8"), "single mutation\n");
    const mutation = state.work.find(work => work.id === "mutation" && work.context === undefined)!;
    if (choice === "adopt") {
      assert.equal(mutation.status, "succeeded"); assert.equal(mutation.result?.kind, "build");
      assert.ok(mutation.evidence.some(ref => /adoption/i.test(ref.summary)), "Adoption must retain the inspected report as evidence");
      assert.equal(state.lifecycle, "completed", `Adopted run stopped at ${state.phase}: ${result.root}`);
      assert.ok(state.verification.some(item => item.checkId === "check-mutation" && item.outcome === "passed" && item.verifier.kind === "runtime"), "Adopted bytes still need current runtime verification");
    } else {
      assert.equal(mutation.status, "cancelled");
      assert.ok(state.work.filter(work => work.id === "mutation").every(work => work.status !== "succeeded"), "A discarded or stopped mutation never counts as success");
      if (choice === "stop") assert.equal(state.lifecycle, "cancelled");
      else {
        assert.ok(["completed", "paused", "blocked"].includes(state.lifecycle), `Discard must leave a live or concluded run, not a stalled cancellation: ${state.lifecycle} at ${state.phase}: ${result.root}`);
        if (state.lifecycle === "completed") assert.notEqual(state.conclusion?.kind, "changed", "A discarded mutation cannot be reported as delivered change");
      }
    }
  }, 300000);

  test("a trusted retry re-runs a failed repository verification inside the same run", async () => {
    const scenario: Scenario = { id: "disposition-retry", command: "shipit", builds: [{ id: "single", path: "single.txt", content: "single output\n" }] };
    const result = await run(scenario, { tui: true, policyVerification: "first-fail", recoveryChoice: "retry" });
    const state = record(scenario, result, ["actual failed runtime verification", "trusted retry", "second actual verification"]);
    const paused = at(result, "recovery-prompt").state!;
    assert.equal(paused.lifecycle, "paused"); assert.equal(paused.recovery?.primaryReason, "verification-failed");
    const approval = state.approvals.find(approval => approval.kind === "recovery");
    assert.ok(approval); assert.equal(approval.authority, "omp-tui");
    assert.ok(shownBeforeApproval(result, approval, '"kind":"retry"'), `The retry disposition must display before the trusted key: ${result.root}`);
    const attempts = state.verification.filter(item => item.checkId === "policy-fixture").map(item => item.outcome);
    assert.deepEqual(attempts, ["failed", "passed"], `Retry must run the actual check again: ${result.root}`);
    assert.equal(state.lifecycle, "completed", `Retried run stopped at ${state.phase}: ${result.root}`);
    assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write").length, 1, "Retrying verification never replays the mutation");
  }, 300000);

  // Read-only workflow work has no mutation to protect, so a trusted discard drops the malformed report and reschedules a fresh attempt inside the same lens pool.
  test("a trusted discard reschedules a malformed reviewer inside its open review pool without replaying a mutation", async () => {
    const scenario: Scenario = { id: "reviewer-discard", command: "shipit", builds: [], invalid: { work: "review-1-correctness", stages: 2 } };
    const result = await run(scenario, { tui: true, recoveryChoice: "discard" });
    const state = record(scenario, result, ["malformed read-only pool item", "bounded correction without a named fallback", "trusted discard of the malformed report", "fresh attempt through the same pool", "round completes with every lens"]);
    const blocked = at(result, "recovery-prompt").state!;
    assert.equal(blocked.lifecycle, "blocked"); assert.equal(blocked.recovery?.primaryReason, "missing-named-fallback");
    assert.ok(blocked.pools.some(pool => pool.status === "running" && pool.items.some(item => item.key !== undefined)), `The reviewer pool must still be open at the prompt: ${result.root}`);
    assert.deepEqual(blocked.recovery?.requiredChoices, ["adopt", "discard", "stop"]);
    const approval = state.approvals.find(approval => approval.kind === "recovery");
    assert.ok(approval, `The discard needs a recorded trusted approval: ${result.root}`); assert.equal(approval.authority, "omp-tui");
    assert.ok(shownBeforeApproval(result, approval, '"kind":"discard"'), `The discard disposition must display before the trusted key: ${result.root}`);
    const corrections = state.work.filter(work => work.context?.kind === "correction");
    assert.equal(corrections.length, 1); assert.ok(corrections.every(work => work.mutation === "read-only" && work.status !== "succeeded"));
    const reviewer = state.work.find(work => work.context?.kind === "review" && work.context.lens === "correctness" && work.context.round === 1);
    assert.ok(reviewer); assert.equal(reviewer.status, "succeeded"); assert.equal(reviewer.attempt.number, 2, `The discarded item must be rescheduled as a fresh attempt: ${result.root}`);
    assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write").length, 0, "A read-only disposition never mutates the checkout");
    for (const lens of ["correctness", "simplicity"]) assert.ok(state.work.some(work => work.context?.kind === "review" && work.context.lens === lens && work.context.round === 1 && work.status === "succeeded"), `Round 1 must complete with the ${lens} lens: ${result.root}`);
    assert.ok(state.reviewRounds[0]?.completedAt, "The interrupted round must still complete");
    assert.equal(state.lifecycle, "completed", `Rescheduled review stopped at ${state.phase}: ${result.root}`);
    assert.ok(state.pools.every(pool => pool.status === "closed"), "Every lens pool must close after its rescheduled item settles");
  }, 300000);

  for (const disposition of ["success", "failed"] as const) test(`an uncertain native parent callback needs a trusted ${disposition} disposition before its bytes count`, async () => {
    const scenario: Scenario = { id: `uncertain-callback-${disposition}`, command: "shipit", dynamic: true, uncertainCallback: true, builds: [{ id: "granted-a", path: "child-a.txt", content: "a\n", isolated: true, tool: "acceptance_mosaic" }] };
    const result = await run(scenario, { tui: true, recoveryChoice: "continue", callbackDisposition: disposition });
    const state = record(scenario, result, ["actual callback wrote an undeclared parent path", "invocation settles uncertain, not success", "items-scope pause at the next safe boundary", `trusted ${disposition} disposition`, disposition === "success" ? "attributed delivered change" : "disowned bytes retained, never delivered"]);
    const paused = at(result, "recovery-prompt").state!;
    assert.equal(paused.recovery?.primaryReason, "uncertain-parent-effect", `Expected the uncertain-callback pause, got ${paused.recovery?.primaryReason}: ${result.root}`);
    assert.equal(paused.recovery?.scope, "items");
    const uncertain = paused.toolInvocations.find(invocation => invocation.outcome === "uncertain");
    assert.ok(uncertain, `No invocation settled uncertain: ${JSON.stringify(paused.toolInvocations.map(invocation => [invocation.version, invocation.outcome]))}`);
    assert.ok(paused.recovery?.affectedWork.some(ref => ref.id === "granted-a"));
    const evidenceDir = join(result.cwd, ".planning", scenario.id, "evidence");
    assert.ok(readdirSync(evidenceDir).some(name => name.startsWith("parent-effect-undeclared")), `The undeclared parent write must be captured as evidence: ${result.root}`);
    const approval = state.approvals.find(approval => approval.kind === "recovery");
    assert.ok(approval, `The disposition needs a recorded trusted approval: ${result.root}`); assert.equal(approval.authority, "omp-tui");
    const prompts = readFileSync(join(result.root, "tui-prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(prompts.some(prompt => prompt.requestId === "callback-disposition" && /undeclared\.txt|undeclared/.test(prompt.screen)), "The disposition prompt must name the undeclared effect before the trusted key");
    assert.ok(shownBeforeApproval(result, approval, `"outcome":"${disposition}"`), `The exact disposition must display before the confirmation: ${result.root}`);
    const invocation = state.toolInvocations.find(candidate => candidate.id === uncertain.id)!;
    assert.equal(invocation.outcome, disposition); assert.ok(invocation.parentAfter, "A settled disposition records the observed parent identity");
    assert.equal(readFileSync(join(result.cwd, "undeclared.txt"), "utf8"), "undeclared\n", "Observed bytes stay in the checkout for inspection under either disposition");
    assert.equal(readFileSync(join(result.cwd, "parent-effect.txt"), "utf8"), "22\n");
    assert.equal(state.lifecycle, "completed", `Run stopped at ${state.phase} (${state.recovery?.primaryReason}): ${result.root}`);
    // The granted builder's own isolated worktree output (child-a.txt) stays attributed under either disposition; the disposition governs only the callback's parent bytes.
    assert.equal(state.conclusion?.kind, "changed");
    assert.equal(readFileSync(join(result.cwd, "child-a.txt"), "utf8"), "a\n");
    assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "commit" || outcome.operation === "push"), false);
    assert.equal(state.toolInvocations.length, paused.toolInvocations.length, "A disposition never re-runs the callback");
  }, 300000);

  test("actual cancellation during an open review pool confirms the pool owner and reaches cancelled", async () => {
    const scenario: Scenario = { id: "lifecycle-pool-cancel", command: "shipit", builds: [], noChange: true, reviewDelayMs: 2500 };
    const result = await run(scenario, { cancelWhen: "pool" });
    const state = record(scenario, result, ["actual slash cancel while a native WorkPool is live", "pool owner confirmed through the runtime snapshot", "late pool results cannot commit", "cancelled without a control-error loop"]);
    assert.doesNotMatch(result.terminal.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), /Extension "command:shipit" error:/, `A lifecycle command failed: ${result.root}`);
    const before = at(result, "before-intervention").state!;
    assert.ok(before.pools.some(pool => pool.status === "running" && pool.items.some(item => item.key !== undefined)), `Cancellation must occur while a pool item is live: ${result.root}`);
    assert.ok(inputs(result).some(input => input.text === "/shipit cancel\r"));
    assert.equal(state.lifecycle, "cancelled", `Cancellation with an open pool ended as ${state.lifecycle}/${state.phase} (${state.recovery?.primaryReason}): ${result.root}`);
    assert.ok(state.pools.every(pool => pool.owner ? ["closed", "lost"].includes(pool.status) && pool.owner.status === "observed-terminal" : pool.status === "pending"), `A process-local pool owner must settle before cancellation completes: ${JSON.stringify(state.pools.map(pool => [pool.id, pool.status, pool.owner?.status]))}`);
    assert.equal(state.work.some(work => ["running", "awaiting-recovery"].includes(work.status)), false);
    const cancelledAt = inputs(result).find(input => input.text === "/shipit cancel\r")!.time;
    for (const work of state.work.filter(work => work.kind === "review" && work.status === "succeeded")) assert.ok(work.completedAt !== undefined && work.completedAt <= cancelledAt + 1000, `A reviewer result committed after the cancel request: ${work.id} at ${work.completedAt} vs ${cancelledAt}: ${result.root}`);
    const reviewer = result.events.findLast(event => event.event === "provider" && event.packet?.assignment.kind === "review" && event.time <= cancelledAt);
    assert.ok(reviewer, "An actual reviewer response must start before the cancel command");
    assert.equal(result.events.some(event => event.event === "provider-settled" && event.sessionId === reviewer.sessionId && event.time >= reviewer.time && event.time <= cancelledAt), false, "The actual reviewer response must still be running when cancellation is requested");
    assert.equal(readFileSync(join(result.cwd, "baseline.txt"), "utf8"), "user baseline\n");
  }, 240000);

  test("actual mid-write cancellation retains completed work, late output, and fresh-session recovery", async () => {
    const scenario: Scenario = { id: "lifecycle-cancel", command: "shipit", reportDelayMs: 2500, builds: [{ id: "mutation", path: "once.txt", content: "retained cancellation effect\n" }] };
    const cancelled = await run(scenario, { cancelAfterWrite: true, continueAfterBoundary: true });
    const state = record(scenario, cancelled, ["actual slash cancel during native work", "cancellation acknowledgment or unresolved owner", "late output cannot commit", "physical effects retained"]);
    assert.doesNotMatch(cancelled.terminal.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), /Extension "command:shipit" error:/, `A lifecycle command failed: ${cancelled.root}`);
    const intervention = at(cancelled, "before-intervention");
    assert.ok(inputs(cancelled).some(input => input.text === "/shipit cancel\r"));
    assert.ok(inputs(cancelled).some(input => input.text === "/shipit status\r"));
    assert.ok(inputs(cancelled).some(input => input.text === "/shipit continue\r"));
    assert.ok(["cancelled", "cancelling", "paused", "blocked"].includes(state.lifecycle), `Cancellation became ${state.lifecycle}: ${cancelled.root}`);
    if (state.lifecycle !== "cancelled") assert.ok(state.recovery?.unresolvedOwners.length, "Unconfirmed cancellation must retain unresolved owners");
    assert.equal(readFileSync(join(cancelled.cwd, "once.txt"), "utf8"), "retained cancellation effect\n");
    assert.equal(readFileSync(join(cancelled.cwd, "baseline.txt"), "utf8"), "user baseline\n");
    const mutations = intervention.state!.work.filter(work => work.mutation !== "read-only" && work.status === "running");
    assert.ok(mutations.length, "Cancellation must occur while a mutation is live");
    for (const mutation of mutations) assert.notEqual(state.work.find(work => work.id === mutation.id && work.revision === mutation.revision)?.status, "succeeded");
    const resumed = await run(scenario, { resume: cancelled });
    record(scenario, resumed, ["cancelled run public resume", "retained effects", "no blind mutation retry"]);
    assertPreservedRestart(cancelled, resumed);
    assert.equal(resumed.events.filter(event => event.event === "tool-call" && event.name === "write").length, 0);
    assert.equal(readFileSync(join(resumed.cwd, "once.txt"), "utf8"), "retained cancellation effect\n");
  }, 240000);

  test("mid-write user steering reaches a safe boundary and rejects late affected results without stopping independent work", async () => {
    const scenario: Scenario = {
      id: "lifecycle-steering", command: "shipit", concurrency: 2, reportDelayMs: 2500,
      builds: [
        { id: "affected", path: "affected.txt", content: "affected effect\n", isolated: true },
        { id: "independent", path: "independent.txt", content: "independent effect\n", isolated: true, delayMs: 350 },
      ],
    };
    const result = await run(scenario, { steerAfterWrite: "Change affected.txt only. Preserve the independent work.", continueAfterBoundary: true });
    const state = record(scenario, result, ["actual mid-run user input", "immediate durable instruction", "safe-boundary application", "independent work continues", "late affected result rejected"]);
    const before = at(result, "before-intervention").state!;
    const instruction = state.instructions.find(instruction => instruction.summary.includes("Change affected.txt only"));
    assert.ok(instruction, `Native user instruction was not recorded: ${result.root}`);
    assert.ok(at(result, "instruction-recorded").state!.work.some(work => work.id === "independent" && work.status === "running"), "Steering must arrive while independent work is live");
    assert.equal(at(result, "instruction-applied").state!.instructions.find(candidate => candidate.id === instruction.id)?.status, "applied");
    assert.equal(instruction.status, "applied", `Instruction did not reach its safe boundary: ${result.root}`);
    assert.ok(instruction.affectedWork.some(work => work.id === "affected"));
    assert.ok(!instruction.affectedWork.some(work => work.id === "independent"));
    const unaffected = state.work.find(work => work.id === "independent" && work.revision === before.work.find(work => work.id === "independent")?.revision);
    assert.equal(unaffected?.status, "succeeded", `Independent worker did not continue: ${result.root}`);
    assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write" && /(^|\/)independent\.txt$/.test(String((event.input as { path?: unknown })?.path))).length, 1, "Steering must not replay the unaffected mutation");
    const oldAffected = state.work.find(work => work.id === "affected" && work.revision === before.work.find(work => work.id === "affected")?.revision);
    assert.equal(oldAffected?.status, "superseded");
    const affectedSessions = result.events.filter(event => event.event === "provider" && event.packet?.work.id === "affected").map(event => event.sessionId);
    assert.ok(result.events.some(event => event.event === "tool-call" && event.name === "yield" && affectedSessions.includes(event.sessionId) && event.time > instruction.receivedAt), `No actual late result exercised the stale-result guard: ${result.root}`);
    assert.equal(readFileSync(join(result.cwd, "baseline.txt"), "utf8"), "user baseline\n");
  }, 180000);

  test("actual host loss preserves live WorkPool items for reconciliation before reconstruction", async () => {
    const scenario: Scenario = { id: "lifecycle-pool-loss", command: "shipit", builds: [], noChange: true };
    const lost = await run(scenario, { crashWhen: "pool" });
    record(scenario, lost, ["native WorkPool with live logical items", "actual process loss"]);
    const pools = at(lost, "before-crash").state!.pools.filter(pool => pool.status === "running" && pool.items.length);
    assert.ok(pools.length, `No live native pool at host loss: ${lost.root}`);
    const resumed = await run(scenario, { resume: lost });
    const state = record(scenario, resumed, ["pool loss reconciliation", "logical items survive", "no opaque handle replay"]);
    assertPreservedRestart(lost, resumed);
    for (const pool of pools) {
      const retained = state.pools.find(candidate => candidate.id === pool.id);
      assert.ok(retained);
      assert.deepEqual(retained.items.map(item => item.logicalId), pool.items.map(item => item.logicalId));
      assert.ok(["lost", "closed"].includes(retained.status), "A process-local pool handle cannot survive host loss");
    }
    assert.ok(state.recovery, `Pool recovery did not expose reconciliation: ${resumed.root}`);
    assert.deepEqual(state.pools.map(pool => pool.id), at(resumed, "before-resume").state!.pools.map(pool => pool.id), "Unreconciled pools must not respawn automatically");
  }, 240000);

  test("actual parent kernel loss keeps registered source unavailable until trusted recreation", async () => {
    const scenario: Scenario = { ...dynamicScenarios.find(scenario => scenario.command === "shipit")!, id: "lifecycle-kernel-loss", reportDelayMs: 2500 };
    const lost = await run(scenario, { crashWhen: (event, _events, state) => event.event === "tool-result" && event.name === "write" && !event.error && !!state?.tools.some(tool => tool.registration === "registered") });
    record(scenario, lost, ["registered native parent callback", "live work at actual kernel loss", "retained parent effects"]);
    const before = at(lost, "before-crash").state!;
    assert.ok(before.tools.some(tool => tool.registration === "registered"));
    const effects = readFileSync(join(lost.cwd, "parent-effect.txt"), "utf8");
    const resumed = await run(scenario, { resume: lost });
    const state = record(scenario, resumed, ["fresh parent kernel generation", "no automatic captured-source execution", "trusted recreation gate"]);
    assertPreservedRestart(lost, resumed);
    assertNoReplay(resumed);
    assert.ok(state.kernelGeneration > before.kernelGeneration);
    for (const tool of before.tools.filter(tool => tool.registration === "registered")) assert.equal(state.tools.find(candidate => candidate.name === tool.name && candidate.version === tool.version)?.registration, "unavailable");
    assert.equal(readFileSync(join(resumed.cwd, "parent-effect.txt"), "utf8"), effects);
    assert.equal(resumed.events.filter(event => event.event === "tool-call" && before.tools.some(tool => tool.registration === "registered" && !!tool.runtimeName && event.name?.startsWith(tool.runtimeName))).length, 0);
  }, 240000);
}
