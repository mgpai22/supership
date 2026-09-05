import { expect, test } from "bun:test";
import { digestJson, type ActionRecord, type CodeIdentity, type EngineInput, type Receipt, type RecoveryChoice, type RunRecord, type RuntimeOwner, type StartInput, type VerificationCheck, type WorkAssignment, type WorkerOutput, type WorkItem } from "../src/contracts.ts";
import { decide, selectNextAction } from "../src/engine.ts";
import { evidence, harness, hash, plan, startInput } from "./core-fixtures.ts";

const CODE: CodeIdentity = { head: "HEAD", indexTree: "tree", worktreeDigest: hash, scopeDigest: hash, parentEffectDigest: hash };
const CHECK: VerificationCheck = { id: "check", description: "Repository check", scenario: { kind: "command", command: ["bun", "test"], cwd: "/repository" }, scopePaths: [], required: true, source: [evidence] };
const builder = (id: string, path: string, isolated = false): WorkAssignment => ({ id, revision: 1, kind: "build", dependencies: [], seatId: "builder", expectedPaths: [path], expectedOutputs: [path], verificationCheckIds: [], mutation: "repository", isolation: isolated ? { kind: "worktree", base: CODE } : { kind: "active-checkout" }, toolGrants: [], outputSchema: { name: "build", version: 1 }, instructions: "Write " + path, evidence: [evidence] });

interface Scenario {
  topology?: StartInput["start"]["invocation"]["topology"];
  /** Review-only /superreview run over the fixture path with the given commit/push request. */
  reviewOnly?: { commit: boolean; push: boolean };
  items?: WorkAssignment[];
  scopePaths?: string[];
  noChangeReason?: string;
  ompCeiling?: number | null;
  concurrency?: number;
  /** Times the named build reports malformed output: the original attempt first, then each report correction. */
  invalid?: Record<string, number>;
  fallback?: string;
  /** The correctness reviewer reports one finding in round 1; the judge accepts it there and rejects it after the repair. */
  finding?: boolean;
  /** The repair worker proposes a scope expansion (a material amendment) with its report. */
  amend?: boolean;
  /** The named build's workspace call returns uncertain (effects outside its declared paths); the trusted answer names its outcome. */
  uncertainEffect?: { work: string; outcome: "success" | "failed" };
  /** The invocation requests commits (autonomous run). */
  commit?: boolean;
  /** The named build succeeds without changing anything: its report says no-change and its bridge return left the parent untouched. */
  noop?: string;
  /** Bytes outside any worker change once during the run (a user edit), observed by the next git observation. */
  drift?: boolean;
}
const TARGET = "src/target.ts";
function startup(scenario: Scenario) {
  const input = startInput();
  input.start.invocation.topology = scenario.topology ?? (scenario.reviewOnly ? "crossreview" : "normal");
  if (scenario.reviewOnly) { input.start.invocation = { ...input.start.invocation, command: "superreview", mode: "review-only", commitRequested: scenario.reviewOnly.commit, pushRequested: scenario.reviewOnly.push }; input.start.policy.verificationChecks = [CHECK]; }
  if (scenario.commit) input.start.invocation.commitRequested = true;
  input.start.seats = ["scout", "architect", "critic", "judge", "judge-secondary", "correctness", "simplicity", "builder", "sonic"].map(seatId => ({ ...input.start.seats[0], seatId, baseAgent: seatId, alias: `fixture-${seatId}`, fallbackSeatIds: seatId === "builder" && scenario.fallback ? [scenario.fallback] : [] }));
  input.start.preflight.seats = input.start.seats;
  return input;
}
function output(state: RunRecord, work: WorkItem, scenario: Scenario): WorkerOutput {
  const base = { schemaVersion: 1 as const, workId: work.id, workRevision: work.revision, attemptId: work.attempt.id };
  switch (work.outputSchema.name) {
    case "research": return { ...base, kind: "research", answers: [{ question: "Does the requested behavior exist?", answer: "The observed code already meets the request", citations: [evidence] }], gaps: [], proposedPaths: [] };
    case "plan": {
      const items = scenario.items ?? [];
      const proposed = { ...plan(items), revision: state.planRevision + 1, scope: { ...plan().scope, paths: scenario.scopePaths ?? ["src"] }, verificationChecks: items.length ? [CHECK] : [], ...(scenario.noChangeReason ? { noChangeReason: scenario.noChangeReason } : {}) };
      return { ...base, kind: "plan", plan: proposed };
    }
    case "critique": return { ...base, kind: "critique", targetPlanIds: work.dependencies.filter(dependency => state.work.find(candidate => candidate.id === dependency.id)?.result?.kind === "plan").map(dependency => dependency.id), issues: [], retainedDecisions: ["Observed behavior requires no changes"] };
    case "build": {
      const noop = scenario.noop === work.id;
      const report: WorkerOutput = { ...base, kind: "build", outcome: noop ? "no-change" : "changed", summary: noop ? "Nothing needed writing" : "Wrote the assigned path", changes: noop ? [] : work.expectedPaths.map(path => ({ path, description: "written" })), verificationClaims: [], evidence: [evidence], proposedTools: [] };
      if (scenario.amend && work.kind === "fix" && state.plan && !state.plan.scope.paths.includes("added.txt")) report.proposedAmendment = { schemaVersion: 1, baseRevision: state.planRevision, proposedPlan: { ...state.plan, revision: state.planRevision + 1, scope: { ...state.plan.scope, paths: [...state.plan.scope.paths, "added.txt"] } }, reason: "The repair needs one more path", evidence: [evidence] };
      return report;
    }
    case "review": {
      if (work.context?.kind !== "review") throw new Error("Review context missing");
      const findings = scenario.finding && work.context.round === 1 && work.context.lens === "correctness" ? [{ schemaVersion: 1 as const, id: "repair", fingerprint: hash, lens: "correctness", location: { path: TARGET }, condition: "The target returns the wrong value", claim: "Observed a wrong return", impact: "Callers misbehave", severity: "medium" as const, evidence: [evidence], fixTarget: { path: TARGET, description: "Return the right value" }, verdicts: [] }] : [];
      return { ...base, kind: "review", round: work.context.round, lens: work.context.lens, reviewedCodeIdentity: work.context.codeIdentity, findings, evidence: [evidence] };
    }
    case "judge": {
      if (work.context?.kind !== "judge") throw new Error("Judge context missing");
      const accept = work.context.round === 1;
      return { ...base, kind: "judge", round: work.context.round, judgeSeatId: work.seatId, reviewPacketHash: work.context.packetHash, verdicts: work.context.findingIds.map(findingId => ({ findingId, verdict: accept ? "accepted" as const : "rejected" as const, reason: accept ? "Reproduced" : "Repaired in the current code", evidence: [evidence] })) };
    }
    default: throw new Error(`Unexpected work ${work.kind}`);
  }
}
function driver(scenario: Scenario = {}) {
  const h = harness(startup(scenario));
  const snapshot = () => ({ ompCeiling: scenario.ompCeiling === undefined ? 8 : scenario.ompCeiling, activeOwners: [], knownCompletedOwners: [], unknownOwners: [], observedAt: h.context().now });
  h.accept({ kind: "record-runtime-snapshot", snapshot: snapshot() });
  if (scenario.concurrency) h.accept({ kind: "configure-limits", limits: { concurrency: scenario.concurrency }, rationale: "fixture run limit" });
  let receiptNumber = 0, revision = 0, code = CODE;
  const invalid = { ...scenario.invalid };
  const nextCode = (change: Partial<CodeIdentity>) => { code = { ...code, ...change }; return code; };
  const observe = (action: ActionRecord, receipt: Receipt, settledOwners?: RuntimeOwner[]) => h.accept({ kind: "observe-receipt", receipt, observation: { kind: "runtime-confirmed", toolCallId: action.claimToolCallId!, ...(action.programHash ? { verifiedProgramHash: action.programHash } : {}), evidence: [evidence], ...(settledOwners ? { settledOwners } : {}) } });
  const base = (action: ActionRecord) => ({ schemaVersion: 1 as const, receiptId: `receipt-${++receiptNumber}`, runId: h.state.runId, ownerEpoch: h.state.owner.epoch, actionId: action.id, planRevision: action.planRevision, inputHash: action.inputHash, evidence: [evidence] });
  const git = (action: ActionRecord, operation: "create_branch" | "integrate" | "commit", before: CodeIdentity, after: CodeIdentity, extra: Partial<Extract<ActionRecord["result"], { kind: "success" }>["output"] & object> = {}) => h.accept({ kind: "settle-action", actionId: action.id, result: { kind: "success", evidence: [evidence], output: { kind: "git", operation, before, after, branch: "supership/fixture", commits: [], ownershipEvidence: [evidence], ...extra } } });
  // Any settled active-checkout mutation, adopted or disowned, leaves its bytes in the worktree; only ownership decides attribution.
  let drifted = false;
  const observeCode = () => {
    const changed = h.state.work.some(work => work.mutation !== "read-only" && ["succeeded", "cancelled"].includes(work.status) && work.isolation.kind === "active-checkout" && work.id !== scenario.noop && (work.completedAt ?? 0) > (h.state.code?.observedAt ?? 0));
    const drift = scenario.drift && !drifted && !!h.state.code; if (drift) drifted = true;
    h.accept({ kind: "record-git-observation", observation: { identity: changed || drift ? nextCode({ worktreeDigest: String(++revision).padStart(64, "0") }) : code, paths: scenario.reviewOnly ? [{ path: TARGET, kind: "tracked", staged: false }] : [], observedAt: h.context().now, evidence: [evidence] } });
  };
  const execute = (action: ActionRecord) => {
    const input = action.input;
    if (input.kind === "observe_git") { observeCode(); h.accept({ kind: "settle-action", actionId: action.id, result: { kind: "success", evidence: [evidence] } }); return; }
    if (input.kind === "create_branch") { git(action, "create_branch", input.expectedCode, nextCode({ head: "branch" })); return; }
    if (input.kind === "integrate") { const work = h.state.work.find(work => work.id === input.work.id && work.revision === input.work.revision)!; git(action, "integrate", input.expectedBefore, nextCode({ worktreeDigest: String(++revision).padStart(64, "0") }), { work: { id: work.id, revision: work.revision, attemptId: work.attempt.id } }); return; }
    if (input.kind === "commit") { git(action, "commit", input.expectedCode, nextCode({ head: `commit-${input.group.id}` }), { commits: [`sha-${input.group.id}`], groupIds: [input.group.id] }); return; }
    if (input.kind === "prepare_push") { h.accept({ kind: "record-push-target", actionId: action.id, target: { remote: "origin", url: "/remote.git", branch: "supership/fixture", commits: input.commits, codeIdentity: input.expectedCode, scopeHash: digestJson({ remote: "origin", commits: input.commits }) } }); return; }
    if (input.kind === "collect_input" && input.request.kind === "approval") {
      const kind = input.request.approvalKind ?? (input.request.id === "push" ? "push" : undefined);
      if (!kind) throw new Error(`Approval request ${input.request.id} does not name its approval kind`);
      h.accept({ kind: "record-trusted-approval", approval: { id: `approval-${action.id}`, kind, decision: kind === "push" ? "decline" : "approve", authority: "omp-tui", scopeHash: input.scopeHash, planRevision: h.state.planRevision, toolVersions: [], ownerEpoch: 0, createdAt: h.context().now, rationale: "Fixture TUI decision", evidence: [evidence] } });
      h.accept({ kind: "settle-action", actionId: action.id, result: { kind: "success", evidence: [evidence] } });
      return;
    }
    if (input.kind === "collect_input" && input.request.kind === "recovery" && input.request.id === "uncertain-parent-effect") {
      // The trusted answer names each unsettled parent callback's outcome; every live owner is confirmed from the inspected snapshot.
      const toolResults = h.state.toolInvocations.filter(invocation => invocation.outcome === "uncertain").map(invocation => ({ id: invocation.id, outcome: scenario.uncertainEffect!.outcome, parentAfter: h.state.code!.identity, evidence: [evidence] }));
      const confirmed = h.state.work.flatMap(work => work.runtimeOwners).map(owner => ({ ...owner, status: "observed-terminal" as const }));
      h.accept(recover(h.state, { kind: "continue", affectedWork: h.state.recovery!.affectedWork, reason: "inspected parent effects", toolResults }, confirmed));
      return;
    }
    if (input.kind === "verify") {
      h.accept({ kind: "record-verification", verification: { schemaVersion: 1, id: `verification-${action.id}`, checkId: input.check.id, scenario: input.check.scenario, codeIdentity: input.expectedCode, scopePaths: input.check.scopePaths, startedAt: h.context().now, endedAt: h.context().now, outcome: "passed", exitCode: 0, evidence: [{ ...evidence, id: `artifact-${action.id}`, kind: "file", uri: `verification/${action.id}.log` }], verifier: { kind: "runtime", id: "bun" }, actionId: action.id } });
      h.accept({ kind: "settle-action", actionId: action.id, result: { kind: "success", evidence: [evidence] } });
      return;
    }
    if (input.kind === "pool_create") {
      const owner: RuntimeOwner = { kind: "pool", id: `runtime-${input.poolId}`, actionId: action.id, workId: input.poolId, workRevision: 0, attemptId: input.poolId, sessionId: h.state.owner.sessionId, ownerEpoch: h.state.owner.epoch, status: "observed-running" };
      observe(action, { ...base(action), kind: "created", owner });
      return;
    }
    if (input.kind === "pool_close") { observe(action, { ...base(action), kind: "pool-closed", poolId: input.poolId, queuedKeysCancelled: [], runningOwners: [] }); return; }
    if (input.kind === "run_finite" || input.kind === "pool_push") {
      if (input.kind === "run_finite") for (const assignment of input.assignments) if (assignment.isolation.kind === "worktree") expect(assignment.isolation.base).toEqual(h.state.code!.identity);
      if (input.kind === "pool_push") expect(input.items).toHaveLength(h.state.pools.find(pool => pool.id === input.poolId)!.items.length);
      const refs = input.kind === "run_finite" ? input.work : input.items.map(item => item.work);
      for (const [index, ref] of refs.entries()) {
        const work = h.state.work.find(work => work.id === ref.id && work.revision === ref.revision)!;
        const owner: RuntimeOwner = { kind: input.kind === "pool_push" ? "pool-item" : "task", id: `${action.id}-${work.id}`, ...(input.kind === "pool_push" ? { parentId: h.state.pools.find(pool => pool.id === input.poolId)!.owner!.id, logicalKey: `${input.poolId}#${index + 1}` } : {}), actionId: action.id, workId: work.id, workRevision: work.revision, attemptId: work.attempt.id, sessionId: h.state.owner.sessionId, ownerEpoch: h.state.owner.epoch, status: "observed-running" };
        observe(action, { ...base(action), kind: "created", work: ref, owner });
        // An active-checkout builder mutates through the workspace bridge; the adapter records the call and its parent effect.
        if (work.mutation !== "read-only" && work.isolation.kind === "active-checkout") {
          observe(action, { ...base(action), kind: "workspace-called", invocationId: `workspace-${work.attempt.id}`, caller: ref, parentBefore: code, manifestDigest: hash });
          const uncertain = scenario.uncertainEffect?.work === work.id;
          observe(action, { ...base(action), kind: "workspace-returned", invocationId: `workspace-${work.attempt.id}`, parentAfter: scenario.noop === work.id ? code : nextCode({ parentEffectDigest: String(++revision).padStart(64, "0") }), outcome: uncertain ? "uncertain" : "success", parentEffectEvidence: [evidence] });
        }
        const buildId = work.context?.kind === "correction" ? work.context.original.id : work.id;
        if (invalid[buildId]) {
          invalid[buildId]--;
          h.accept({ kind: "record-invalid-output", work: ref, actionId: action.id, outputRef: evidence, issues: [{ code: "schema", path: "", message: "Malformed output", evidence: [] }], observation: { kind: "runtime-confirmed", toolCallId: action.claimToolCallId!, verifiedProgramHash: action.programHash, evidence: [evidence], settledOwners: [{ ...owner, status: "observed-terminal" }] } });
          continue;
        }
        observe(action, { ...base(action), kind: "completed", work: ref, owner: { ...owner, status: "observed-terminal" }, output: output(h.state, work, scenario) });
        if (work.mutation !== "read-only" && work.isolation.kind === "worktree") h.accept({ kind: "record-patch", patch: { schemaVersion: 1, work: ref, actionId: action.id, patchRef: evidence, before: code, changedPaths: work.expectedPaths, ownershipEvidence: [evidence] }, observation: { kind: "runtime-confirmed", toolCallId: action.claimToolCallId!, evidence: [evidence] } });
        // The adapter observes the checkout as soon as it captures an active-checkout workspace, before any later approval gate.
        if (work.mutation !== "read-only" && work.isolation.kind === "active-checkout") observeCode();
      }
      return;
    }
    if (input.kind === "conclude") { h.accept({ kind: "conclude", conclusion: input.conclusion }); return; }
    throw new Error(`Unexpected action ${input.kind} in ${h.state.phase}`);
  };
  const step = () => {
    const advance = decide(h.state, { kind: "advance" }, h.context());
    if (advance.kind === "append") { h.accept({ kind: "advance" }); return; }
    if (advance.kind === "reject") throw new Error(advance.message);
    const draft = selectNextAction(h.state, h.state.runtime ?? snapshot());
    if (!draft) throw new Error(`No eligible operation in ${h.state.lifecycle}/${h.state.phase}`);
    h.accept({ kind: "issue-action", draft, programHash: hash });
    const action = h.state.actions.at(-1)!;
    h.accept({ kind: "claim-action", actionId: action.id, expectedStateRevision: action.expectedStateRevision, toolCallId: `call-${action.id}`, inputHash: action.inputHash, programHash: hash });
    execute(h.state.actions.at(-1)!);
  };
  const until = (done: (state: RunRecord) => boolean, limit = 200) => { for (let count = 0; count < limit && !done(h.state); count++) step(); expect(done(h.state)).toBe(true); };
  return { ...h, get state() { return h.state; }, step, until, snapshot };
}
function recover(state: RunRecord, choice: RecoveryChoice, confirmed: RuntimeOwner[] = []): EngineInput {
  return { kind: "resolve-recovery", choice, approval: { id: `recovery-${state.eventSequence}`, kind: "recovery", decision: "approve", authority: "omp-tui", scopeHash: digestJson(choice), planRevision: state.planRevision, toolVersions: [], ownerEpoch: 0, createdAt: state.updatedAt, rationale: "Inspected the retained output", evidence: [evidence] }, evidence: { writerExclusive: true, runtime: { confirmed, unresolved: [], candidateResults: [], requiredChoices: [] }, git: state.code!, evidence: [evidence] } };
}
const completed = (state: RunRecord) => state.lifecycle === "completed";
const settled = (state: RunRecord) => state.actions.every(action => ["settled", "superseded"].includes(action.status));
const recovery = (state: RunRecord) => state.lifecycle === "blocked" && !!state.recovery;

test("all planning topologies converge through fresh native-shaped review and complete no-change", () => {
  for (const [topology, planningCalls] of [["normal", 1], ["crossreview", 3], ["duel", 5], ["debate", 7]] as const) {
    const run = driver({ topology });
    run.until(completed, 120);
    expect(run.state.work.filter(work => work.context?.kind === "planning" && work.context.stage !== "shared-research")).toHaveLength(planningCalls);
    expect(run.state.reviewRounds[0].reviewerOwners).toHaveLength(2);
    expect(run.state.reviewRounds[0].judgeOwners).toHaveLength(topology === "normal" ? 1 : 2);
    expect(run.state.pools.every(pool => pool.status === "closed")).toBe(true);
    expect(settled(run.state)).toBe(true);
    expect(run.state.conclusion?.kind).toBe("no-change");
  }
});

test("isolated builders start from the currently observed code while the plan keeps its original base, and each lens pool receives one full push", () => {
  const run = driver({ items: [builder("a", "a", true), builder("b", "b", true), builder("c", "c", true)], scopePaths: ["a", "b", "c"], concurrency: 2, ompCeiling: 3 });
  run.until(completed);
  const waves = run.state.actions.filter(action => action.input.kind === "run_finite" && action.recipients.some(recipient => recipient.workId.length === 1));
  expect(waves.map(action => action.recipients.length)).toEqual([2, 1]);
  for (const action of waves) if (action.input.kind === "run_finite") for (const assignment of action.input.assignments) expect(assignment.isolation).not.toEqual({ kind: "worktree", base: CODE });
  for (const id of ["a", "b", "c"]) expect(run.state.work.find(work => work.id === id)!.isolation).toEqual({ kind: "worktree", base: CODE });
  expect(run.state.gitOutcomes.filter(outcome => outcome.operation === "integrate")).toHaveLength(3);
  const pushes = run.state.actions.filter(action => action.input.kind === "pool_push");
  expect(pushes).toHaveLength(2);
  for (const action of pushes) if (action.input.kind === "pool_push") expect(action.input.items).toHaveLength(3);
  expect(run.state.conclusion?.kind).toBe("changed");
});

test("a whole-pool push waits until the aggregate ceiling has room for the workers that pool can spawn", () => {
  const run = driver({ items: [builder("a", "a"), builder("b", "b"), builder("c", "c")], scopePaths: ["a", "b", "c"], concurrency: 2, ompCeiling: 3 });
  run.until(state => state.pools.some(pool => pool.status === "running" && pool.items.every(item => item.key === undefined)));
  const pool = run.state.pools.find(pool => pool.status === "running")!;
  const task = (id: string): RuntimeOwner => ({ kind: "task", id, actionId: "elsewhere", workId: "other", workRevision: 1, attemptId: "other:r1:1", sessionId: "session", ownerEpoch: 0, status: "observed-running" });
  const pick = (activeOwners: RuntimeOwner[], ompCeiling: number | null = 3) => selectNextAction(run.state, { ...run.snapshot(), ompCeiling, activeOwners })?.input;
  expect(pick([])).toMatchObject({ kind: "pool_push", poolId: pool.id });
  expect(pick([task("busy-1")])?.kind).not.toBe("pool_push");
  expect(pick([task("busy-1"), task("busy-2")])?.kind).not.toBe("pool_push");
  expect(pick([task("busy-1"), task("busy-2")], null)?.kind).not.toBe("pool_push");
  run.accept({ kind: "configure-limits", limits: {}, rationale: "unlimited run" });
  expect(pick([task("busy-1"), task("busy-2")], null)).toMatchObject({ kind: "pool_push", poolId: pool.id });
  expect(pick([task("busy-1"), task("busy-2")], 4)?.kind).not.toBe("pool_push");
  expect(pick([task("busy-1")], 4)).toMatchObject({ kind: "pool_push", poolId: pool.id });
});

test("a corrected report completes the run although its failed first correction stays recorded", () => {
  const run = driver({ items: [builder("mutation", "once.txt")], scopePaths: ["once.txt"], invalid: { mutation: 2 }, fallback: "sonic" });
  run.until(completed);
  const corrections = run.state.work.filter(work => work.context?.kind === "correction");
  expect(corrections.map(work => [work.seatId, work.status])).toEqual([["builder", "failed"], ["sonic", "succeeded"]]);
  expect(run.state.work.find(work => work.id === "mutation")!.status).toBe("succeeded");
  expect(run.state.work.filter(work => work.kind === "build")).toHaveLength(1);
  expect(run.state.conclusion?.kind).toBe("changed");
});

for (const disposition of ["adopt", "discard"] as const) test(`exhausted report corrections stop blocking conclusion after a trusted ${disposition}`, () => {
  const run = driver({ items: [builder("mutation", "once.txt")], scopePaths: ["once.txt"], invalid: { mutation: 3 }, fallback: "sonic" });
  run.until(recovery);
  expect(run.state.recovery?.primaryReason).toBe("output-attempts-exhausted");
  const original = run.state.work.find(work => work.id === "mutation")!;
  expect(run.state.work.filter(work => work.context?.kind === "correction").map(work => work.status)).toEqual(["failed", "failed"]);
  expect(decide(run.state, { kind: "conclude", conclusion: { kind: "changed", summary: "premature", evidence: [evidence], lessons: [], unresolvedDeferredFindingIds: [], completedAt: run.state.updatedAt } }, run.context())).toMatchObject({ kind: "reject", code: "incomplete-run" });
  run.accept(recover(run.state, { kind: disposition, affectedWork: [{ id: original.id, revision: original.revision }], reason: `trusted ${disposition}`, ...(disposition === "adopt" ? { adoptions: [{ work: { id: original.id, revision: original.revision, attemptId: original.attempt.id }, output: output(run.state, original, {}), effectEvidence: [evidence] }] } : {}) }));
  expect(run.state.work.find(work => work.id === "mutation")!.status).toBe(disposition === "adopt" ? "succeeded" : "cancelled");
  run.until(completed);
  expect(run.state.work.filter(work => work.context?.kind === "correction").map(work => work.status)).toEqual(["failed", "failed"]);
  expect(run.state.work.every(work => work.runtimeOwners.every(owner => owner.status === "observed-terminal"))).toBe(true);
  // The disowned bytes and their recorded parent effect stay observable in the checkout, yet attribution follows the disposition.
  expect(run.state.code!.identity.worktreeDigest).not.toBe(run.state.baselineCode!.worktreeDigest);
  expect(run.state.code!.identity.parentEffectDigest).not.toBe(run.state.baselineCode!.parentEffectDigest);
  expect(run.state.toolInvocations.some(invocation => invocation.outcome === "success" && invocation.caller.id === "mutation")).toBe(true);
  expect(run.state.conclusion?.kind).toBe(disposition === "adopt" ? "changed" : "no-change");
  if (disposition === "discard") expect(run.state.conclusion?.summary).toContain("discarded the mutation work mutation");
});

test("discarding a read-only review attempt reschedules the item so the round still completes with every lens", () => {
  const run = driver({ invalid: { "review-1-correctness": 2 } });
  run.until(recovery);
  expect(run.state.recovery?.primaryReason).toBe("missing-named-fallback");
  const review = run.state.work.find(work => work.id === "review-1-correctness")!;
  expect(review.status).toBe("awaiting-output");
  // The drained WorkPool job has settled natively; the inspected snapshot reports its owner terminal (the pool is not resumable).
  const pool = run.state.pools.find(pool => pool.lens === "correctness")!;
  run.accept(recover(run.state, { kind: "discard", affectedWork: [{ id: review.id, revision: review.revision }], reason: "drop the malformed review" }, [{ ...pool.owner!, status: "observed-terminal" }]));
  const rescheduled = run.state.work.find(work => work.id === review.id)!;
  expect([rescheduled.status, rescheduled.attempt.number]).toEqual(["pending", 2]);
  expect(run.state.pools.find(pool => pool.lens === "correctness")).toMatchObject({ status: "closed", items: [{ logicalId: review.id, work: { id: review.id, revision: review.revision, attemptId: rescheduled.attempt.id } }] });
  run.until(completed);
  expect(run.state.work.find(work => work.id === review.id)).toMatchObject({ status: "succeeded", attempt: { number: 2 } });
  expect(run.state.work.filter(work => work.context?.kind === "correction").map(work => work.status)).toEqual(["failed"]);
  expect(run.state.reviewRounds[0].reviewerOwners).toHaveLength(3);
});

test("a review-only repair commits as one attributable group and still needs the separate publication decision", () => {
  const run = driver({ reviewOnly: { commit: true, push: true }, finding: true });
  run.until(completed);
  const fix = run.state.work.find(work => work.kind === "fix")!;
  expect(fix.status).toBe("succeeded");
  const commit = run.state.actions.find(action => action.input.kind === "commit")!;
  expect(commit.input).toMatchObject({ kind: "commit", group: { id: "attributed-output", workIds: [fix.id], paths: [TARGET] } });
  expect("approvalId" in commit.input).toBe(false);
  expect(run.state.gitOutcomes.some(outcome => outcome.operation === "commit")).toBe(true);
  expect(run.state.gitOutcomes.some(outcome => outcome.operation === "push")).toBe(false);
  expect(run.state.approvals.map(approval => [approval.kind, approval.decision])).toEqual([["push", "decline"]]);
  expect(run.state.pushTarget?.commits).toEqual(["sha-attributed-output"]);
  // The commit moved HEAD without changing reviewed bytes; the passed verification stays current and is not re-run.
  expect(run.state.verification.map(result => result.outcome)).toEqual(["passed"]);
  expect(run.state.actions.filter(action => action.input.kind === "verify")).toHaveLength(1);
  expect(run.state.conclusion?.kind).toBe("changed");
});

test("a review-only scope expansion collects a material amendment decision, never an initial plan gate", () => {
  const run = driver({ reviewOnly: { commit: false, push: false }, finding: true, amend: true });
  run.until(state => state.actions.some(action => action.input.kind === "collect_input" && action.input.request.kind === "approval"));
  const request = run.state.actions.at(-1)!.input;
  expect(request).toMatchObject({ kind: "collect_input", request: { kind: "approval", id: "material-amendment", approvalKind: "material-amendment" } });
  expect(run.state.planChange).toMatchObject({ classification: "material" });
  run.until(completed);
  expect(run.state.planRevision).toBe(2);
  expect(run.state.plan?.scope.paths).toContain("added.txt");
  expect(run.state.approvals.map(approval => [approval.kind, approval.authority, approval.planRevision])).toEqual([["material-amendment", "omp-tui", 2]]);
  expect(run.state.conclusion?.kind).toBe("changed");
});

for (const phase of ["verify", "conclude"] as const) test(`verification evidence invalidated while the run stands in ${phase} forces a fresh runtime verification before completion`, () => {
  const run = driver({ items: [builder("verified", "result.txt")], scopePaths: ["result.txt"] });
  run.until(state => state.phase === phase && state.verification.some(result => result.outcome === "passed") && settled(state));
  const checked = run.state.verification.find(result => result.outcome === "passed")!;
  const audit = { ...evidence, id: "stale-audit", kind: "file" as const, uri: "recovery/stale-evidence.json" };
  expect(decide(run.state, { kind: "invalidate-verification", ids: [checked.id, "missing"], reason: "artifact changed", evidence: [audit] }, run.context())).toMatchObject({ kind: "reject", code: "unknown-verification" });
  expect(decide(run.state, { kind: "invalidate-verification", ids: [checked.id], reason: "artifact changed", evidence: [{ ...audit, availability: "unverified" }] }, run.context())).toMatchObject({ kind: "reject", code: "unproven-invalidation" });
  expect(decide(run.state, { kind: "invalidate-verification", ids: [checked.id], reason: "artifact changed", evidence: [] }, run.context())).toMatchObject({ kind: "reject", code: "unproven-invalidation" });
  expect(selectNextAction(run.state, run.state.runtime!)?.input.kind).not.toBe("verify");
  run.accept({ kind: "invalidate-verification", ids: [checked.id], reason: "artifact bytes differ from the recorded digest", evidence: [audit] });
  const old = run.state.verification.find(result => result.id === checked.id)!;
  expect(old.outcome).toBe("unavailable");
  expect(old.evidence.every(ref => ref.availability === "unavailable")).toBe(true);
  expect(decide(run.state, { kind: "invalidate-verification", ids: [checked.id], reason: "again", evidence: [audit] }, run.context())).toMatchObject({ kind: "duplicate" });
  expect(selectNextAction(run.state, run.state.runtime!)?.input).toMatchObject({ kind: "verify", check: { id: checked.checkId } });
  run.until(completed);
  const fresh = run.state.verification.filter(result => result.id !== checked.id && result.outcome === "passed");
  expect(fresh).toHaveLength(1);
  expect(fresh[0].evidence.every(ref => ref.availability === "available")).toBe(true);
  expect(run.state.verification.find(result => result.id === checked.id)!.outcome).toBe("unavailable");
});

for (const outcome of ["success", "failed"] as const) for (const commit of [false, true]) test(`an uncertain parent callback holds the phase for a trusted disposition; a ${outcome} answer decides attribution${commit ? " and the requested commit" : ""}`, () => {
  const run = driver({ items: [builder("mutation", "once.txt")], scopePaths: ["once.txt"], uncertainEffect: { work: "mutation", outcome }, commit });
  run.until(state => state.recovery?.primaryReason === "uncertain-parent-effect");
  expect(run.state.lifecycle).toBe("active");
  expect(run.state.recovery).toMatchObject({ scope: "items", affectedWork: [{ id: "mutation", revision: 1 }], requiredChoices: ["inspect", "continue", "stop"] });
  expect(decide(run.state, recover(run.state, { kind: "continue", affectedWork: [], reason: "without inspecting the callback" }), run.context())).toMatchObject({ kind: "reject", code: "unconfirmed-owner" });
  // The run holds its phase until the trusted answer settles attribution; review, verification and any commit see the decided owner.
  expect(run.state.phase).toBe("build");
  expect(decide(run.state, { kind: "advance-phase", phase: "review", reason: "premature", evidence: [] }, run.context())).toMatchObject({ kind: "reject", code: "invalid-phase" });
  run.until(completed);
  expect(run.state.toolInvocations.map(invocation => invocation.outcome)).toEqual([outcome]);
  expect(run.state.recovery).toBeUndefined();
  expect(run.state.actions.filter(action => action.input.kind === "collect_input")).toHaveLength(1);
  const resolved = run.events.find(event => event.facts.some(fact => fact.kind === "approval-recorded" && fact.approval.kind === "recovery"))!;
  expect(resolved.facts.find(fact => fact.kind === "lifecycle-changed")).toMatchObject({ to: "active", phase: "build" });
  expect(run.state.conclusion?.kind).toBe(outcome === "success" ? "changed" : "no-change");
  expect(run.state.gitOutcomes.filter(output => output.operation === "commit")).toHaveLength(commit && outcome === "success" ? 1 : 0);
  if (outcome === "failed") expect(run.state.conclusion?.summary).toContain("not attributable output");
});

test("a no-op builder beside independent external drift concludes no-change without attempting an empty commit", () => {
  const run = driver({ items: [builder("noop", "once.txt")], scopePaths: ["once.txt"], noop: "noop", drift: true, commit: true });
  run.until(completed);
  expect(run.state.work.find(work => work.id === "noop")).toMatchObject({ status: "succeeded", result: { outcome: "no-change" } });
  expect(run.state.code!.identity.worktreeDigest).not.toBe(run.state.baselineCode!.worktreeDigest);
  expect(run.state.actions.some(action => action.input.kind === "commit")).toBe(false);
  expect(run.state.gitOutcomes.filter(output => output.operation === "commit")).toHaveLength(0);
  expect(run.state.conclusion).toMatchObject({ kind: "no-change", summary: expect.stringContaining("not attributable output") });
});

test("external drift beside a delivering builder is committed only through the builder's attributed group and never relabels the drift", () => {
  const run = driver({ items: [builder("mutation", "once.txt")], scopePaths: ["once.txt"], drift: true, commit: true });
  run.until(completed);
  const commit = run.state.actions.find(action => action.input.kind === "commit")!.input;
  expect(commit).toMatchObject({ kind: "commit", group: { id: "attributed-output", workIds: ["mutation"], paths: ["once.txt"] } });
  expect(run.state.conclusion?.kind).toBe("changed");
});
