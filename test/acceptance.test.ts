import { afterAll, test as runTest } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSchema, RunEventSchema, RunRecordSchema } from "../src/contracts.ts";
import { amendmentScenarios, commands, commandScenarios, dynamicProposal, dynamicScenarios, mixedScenario, reviewScenarios, topologyScenarios, type Scenario } from "./fixtures/acceptance/scenarios.ts";
import { runScenario, type Evidence } from "./fixtures/acceptance/runner.ts";
import { registerLifecycleTests } from "./fixtures/acceptance/lifecycle.ts";

const evidence: Array<{ scenario: string; root: string; surface: string; lifecycle?: string; phase?: string; requiredAssertions: string[]; outcome: "observed" | "passed" | "failed"; error?: string }> = [];
function test(name: string, run: () => void | Promise<void>, timeout?: number) {
  runTest(name, async () => {
    const start = evidence.length;
    try { await run(); for (const row of evidence.slice(start)) row.outcome = "passed"; }
    catch (error) {
      if (evidence.length === start) evidence.push({ scenario: name, root: "See test failure", surface: "not-completed", requiredAssertions: [], outcome: "failed" });
      for (const row of evidence.slice(start)) { row.outcome = "failed"; row.error = String(error); }
      throw error;
    }
  }, timeout);
}
function record(scenario: Scenario, result: Evidence, requiredAssertions: string[]) {
  evidence.push({ scenario: scenario.id, root: result.root, surface: result.surface, lifecycle: result.state?.lifecycle, phase: result.state?.phase, requiredAssertions, outcome: "observed" });
  assert.ok(result.state, `No durable run. Inspect ${result.root}/provider.jsonl and terminal.txt`);
  assertSchema(RunRecordSchema, result.state);
  assert.deepEqual(result.events.filter(event => event.event === "fixture-error"), [], `Scripted provider failed: ${result.root}`);
  assert.equal(result.events.some(event => event.event === "tool-call" && event.name === "learn"), false, "Run-local lessons must not write durable OMP memory");
  return result.state;
}
afterAll(() => {
  const output = process.env.SUPERSHIP_ACCEPTANCE_EVIDENCE ?? ".planning/acceptance-evidence.json";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({
    kind: "scripted-software-integration", modelJudgmentProven: false,
    runtime: "Installed OMP, real extension/native task/eval/yield/hooks, inherited deny-network launcher",
    approvalSurfaces: "installed-tui records actual PTY keys; installed-print never supplies trusted approval",
    scenarios: evidence,
    focusedCoverage: {
      seatIsolationAndCrashReceipts: "test/phase-a.test.ts",
      offlineBoundary: "test/offline-boundary.test.ts",
      eventReplayAndWriters: "test/store.test.ts",
      gitOwnershipAndPublication: "test/git.test.ts",
      dashboardEscapingAndExports: "test/dashboard.test.ts",
      installationAndNamedMigration: ["test/cli.test.ts", "test/install.test.ts"],
    },
    limitations: ["Deterministic provider responses do not prove real-model judgment.", "Reviewed source and parent callbacks are not a JavaScript sandbox.", "No user installation or publication was changed."],
  }, null, 2));
});

for (const scenario of topologyScenarios) test(`installed OMP preserves ${scenario.topology} planning exchanges and blind seats`, async () => {
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["exact planning graph", "blind shared packet", "independent ultra judges", "strict native output"]);
  assert.equal(state.lifecycle, "completed", `Integration stopped at ${state.phase}: ${result.root}`);
  const planning = state.work.filter(work => work.context?.kind === "planning" && work.context.stage !== "shared-research");
  assert.equal(planning.length, scenario.topology === "normal" ? 1 : scenario.topology === "crossreview" ? 3 : scenario.topology === "duel" ? 5 : 7);
  const byStage = new Map<string, typeof planning[number]>(planning.map(work => [work.context?.kind === "planning" ? work.context.stage : "", work]));
  const edges: Record<string, string[]> = scenario.topology === "normal" ? { "blind-a": [] } : scenario.topology === "crossreview"
    ? { "blind-a": [], "critique-b": ["blind-a"], "revise-a": ["blind-a", "critique-b"] }
    : {
      "blind-a": [], "blind-b": [], "critique-a": ["blind-b"], "critique-b": ["blind-a"],
      ...(scenario.topology === "debate" ? { "revise-a": ["blind-a", "critique-b"], "revise-b": ["blind-b", "critique-a"] } : {}),
      synthesis: scenario.topology === "duel" ? ["blind-a", "blind-b", "critique-a", "critique-b"] : ["blind-a", "blind-b", "critique-a", "critique-b", "revise-a", "revise-b"],
    };
  for (const [stage, prerequisites] of Object.entries(edges)) {
    const work = byStage.get(stage)!;
    assert.ok(work, `Missing ${stage}: ${result.root}`);
    const input = JSON.parse(work.instructions);
    assert.deepEqual(input.priorOutputs.map((prior: { id: string }) => prior.id).sort(), prerequisites.map(stage => byStage.get(stage)!.id).sort());
    assert.ok(work.dependencies.every(dependency => state.work.some(previous => previous.id === dependency.id && previous.status === "succeeded")));
  }
  const blindA = byStage.get("blind-a")!, blindB = byStage.get("blind-b");
  if (blindB) {
    assert.notEqual(blindA.seatId, blindB.seatId);
    assert.deepEqual(JSON.parse(blindA.instructions).sharedPacket, JSON.parse(blindB.instructions).sharedPacket);
    const starts = result.events.filter(event => event.event === "provider" && event.packet && [blindA.id, blindB.id].includes(event.packet.work.id));
    const settled = result.events.filter(event => event.event === "provider-settled" && event.work && [blindA.id, blindB.id].includes(event.work.id));
    assert.ok(starts.length === 2 && settled.length === 2 && Math.max(...starts.map(event => event.time)) < Math.min(...settled.map(event => event.time)), "Blind planning seats must overlap in the real runtime");
  }
  const judges = state.work.filter(work => work.kind === "judge");
  assert.equal(judges.length, scenario.topology === "normal" ? 1 : 2);
  if (judges.length === 2) assert.notEqual(judges[0]!.runtimeOwners[0]!.id, judges[1]!.runtimeOwners[0]!.id);
  for (const stages of [["critique-a", "critique-b"], ["revise-a", "revise-b"]]) {
    const paired = stages.map(stage => byStage.get(stage)).filter(work => work !== undefined);
    if (paired.length !== 2) continue;
    const ids = paired.map(work => work.id);
    const starts = result.events.filter(event => event.event === "provider" && event.packet && ids.includes(event.packet.work.id));
    const settled = result.events.filter(event => event.event === "provider-settled" && event.work && ids.includes(event.work.id));
    assert.ok(starts.length === 2 && settled.length === 2 && Math.max(...starts.map(event => event.time)) < Math.min(...settled.map(event => event.time)), "Independent topology exchanges must overlap in the real runtime");
  }
  assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "commit" || outcome.operation === "push"), false, "No-change execution must not publish");
  for (const judge of judges) assert.equal(JSON.parse(judge.instructions).packet.judgeOutputs, undefined, "Neither judge receives the other judge's output");
}, 180000);

for (const scenario of commandScenarios) test(`/${scenario.command} reaches its review/fix/verification flow through real OMP`, async () => {
  const result = await runScenario(scenario, { tui: scenario.command === "supership" || scenario.command === "ultraship" });
  const state = record(scenario, result, ["command alias", "initial plan authority", "in-scope repair", "actual runtime verification"]);
  assert.equal(state.lifecycle, "completed", `Integration stopped at ${state.phase}: ${result.root}`);
  const initial = state.approvals.filter(approval => approval.kind === "initial-plan");
  if (scenario.command === "superreview") assert.equal(initial.length, 0);
  else assert.equal(initial[0]?.authority, scenario.command === "shipit" || scenario.command === "ultrashipit" ? "autonomous-policy" : "omp-tui");
  assert.ok(state.work.some(work => work.kind === "fix" && work.status === "succeeded"));
  assert.notEqual(state.reviewRounds[0]!.relevantCodeDigest, state.reviewRounds[1]!.relevantCodeDigest, "The accepted repair must change reviewed bytes");
  assert.equal(state.approvals.filter(approval => approval.kind === "material-amendment").length, 0, "An in-scope repair cannot create a material approval gate");
  assert.ok(state.findings.every(finding => !finding.verdicts.some(verdict => verdict.verdict === "accepted") || finding.resolution));
  for (const check of state.plan!.verificationChecks.filter(check => check.required)) {
    const verification = state.verification.find(item => item.checkId === check.id && item.outcome === "passed");
    assert.ok(verification, `Required runtime verification absent: ${result.root}`);
    assert.deepEqual(verification.codeIdentity, state.code!.identity);
    assert.equal(verification.verifier.kind, "runtime");
  }
}, 180000);

for (const scenario of reviewScenarios) test(`real fresh review contexts implement ${scenario.id}`, async () => {
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["fresh reviewer/judge runtime owners", "round-local/lens-local pools", scenario.id]);
  const expectedRounds = scenario.id === "unlimited-convergence" ? 4 : scenario.id.endsWith("resets-stall") ? 3 : scenario.disagree || scenario.id === "review-round-cap" ? 1 : 2;
  assert.equal(state.reviewRounds.filter(round => round.completedAt).length, expectedRounds, `Wrong review boundary: ${result.root}`);
  if (scenario.id === "unlimited-convergence") { assert.equal(state.lifecycle, "completed"); assert.equal(state.limits.reviewRounds, undefined); }
  else {
    assert.equal(state.lifecycle, "paused");
    assert.equal(state.recovery?.primaryReason, scenario.disagree ? "judge-disagreement" : scenario.id === "review-round-cap" ? "review-round-cap" : "no-progress");
    if (scenario.id === "stall-and-cap") assert.deepEqual(state.recovery?.triggers, ["no-progress", "review-round-cap"]);
  }
  if (scenario.id === "relevant-progress-resets-stall") {
    assert.notEqual(state.reviewRounds[0]!.relevantCodeDigest, state.reviewRounds[1]!.relevantCodeDigest);
    assert.equal(state.reviewRounds[1]!.relevantCodeDigest, state.reviewRounds[2]!.relevantCodeDigest);
  }
  const owners = state.work.filter(work => work.kind === "review" || work.kind === "judge").flatMap(work => work.runtimeOwners.map(owner => owner.id));
  assert.equal(new Set(owners).size, owners.length, "Runtime contexts must not cross rounds or review lenses");
  const providerContexts = result.events.filter(event => event.event === "provider" && event.packet && ["review", "judge"].includes(event.packet.assignment.kind));
  const sessions = new Map<string, Set<string>>();
  for (const event of providerContexts) {
    const context = event.packet!.assignment.context!;
    assert.ok(context.kind === "review" || context.kind === "judge");
    const identity = `${context.round}:${context.kind === "review" ? context.lens : event.packet!.assignment.seatId}`;
    const scopes = sessions.get(event.sessionId!) ?? new Set<string>(); scopes.add(identity); sessions.set(event.sessionId!, scopes);
    assert.ok(Array.isArray(event.privateMarkers), "The native context observation must record private markers");
    assert.deepEqual((event.privateMarkers as string[]).filter(marker => marker !== `ACCEPTANCE_PRIVATE_${event.sessionId}`), [], "A fresh worker must not inherit another worker conversation outside explicit findings");
  }
  for (const scopes of sessions.values()) assert.equal(scopes.size, 1, "Actual sessions must not cross review rounds or lenses");
  for (const pool of state.pools) for (const item of pool.items) {
    const work = state.work.find(work => work.id === item.work.id && work.revision === item.work.revision)!;
    assert.equal(work.context?.kind, "review");
    if (work.context?.kind === "review") { assert.equal(work.context.round, pool.round); assert.equal(work.context.lens, pool.lens); }
  }
}, 180000);

for (const scenario of [mixedScenario, { ...mixedScenario, id: "mixed-omp-ceiling", concurrency: 3, ompConcurrency: 2 }, { ...mixedScenario, id: "mixed-native-unlimited-run-limit", concurrency: 2, ompConcurrency: 0 }, { ...mixedScenario, id: "mixed-unlimited", concurrency: undefined, ompConcurrency: 0 }]) test(`mixed finite dependencies, isolated builders, and WorkPool review obey ${scenario.id} ceilings`, async () => {
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["mixed finite/pool scheduling", "dependent sequencing", "isolated builder capture", "aggregate ceilings"]);
  assert.equal(state.lifecycle, "completed", `Mixed run stopped at ${state.phase}: ${result.root}`);
  assert.ok(state.actions.some(action => action.input.kind === "run_finite"));
  assert.ok(state.actions.some(action => action.input.kind === "pool_push"));
  const finite = state.actions.filter(action => action.input.kind === "run_finite");
  const initialWave = finite.find(action => action.recipients.some(recipient => recipient.workId === "independent-a"))!;
  assert.deepEqual(initialWave.recipients.map(recipient => recipient.workId).sort(), ["independent-a", "independent-b", "independent-c"].slice(0, Math.min(scenario.concurrency ?? 3, scenario.ompConcurrency || 3)));
  assert.ok(finite.findIndex(action => action.recipients.some(recipient => recipient.workId === "dependent")) > finite.indexOf(initialWave));
  const workerEvents = result.events.filter(event => event.event === "session-start" && event.cwd !== result.cwd);
  assert.ok(workerEvents.length >= 2, "The actual child sessions must use isolated cwd values");
  assert.ok(state.worktrees.length >= 2);
  const log = readFileSync(join(result.cwd, ".planning", scenario.id, "events.jsonl"), "utf8").trim().split("\n").map(line => { const event: unknown = JSON.parse(line); assertSchema(RunEventSchema, event); return event; });
  const snapshots = log.flatMap(event => event.facts.filter(fact => fact.kind === "runtime-observed"));
  assert.ok(snapshots.some(fact => fact.snapshot.activeOwners.some(owner => owner.kind !== "pool")));
  for (const fact of snapshots) assert.equal(fact.snapshot.ompCeiling, scenario.ompConcurrency === 0 ? null : scenario.ompConcurrency);
  assert.equal(state.limits.concurrency, scenario.concurrency);
  for (const fact of snapshots) {
    const active = fact.snapshot.activeOwners.filter(owner => owner.kind !== "pool").length;
    if (scenario.concurrency !== undefined) assert.ok(active <= scenario.concurrency);
    if (scenario.ompConcurrency) assert.ok(active <= scenario.ompConcurrency);
  }
  assert.equal(state.reviewRounds.length, 2);
  assert.ok(state.pools.some(pool => pool.items.length >= 2), "One product lens/round pool must process repeated independent items");
  for (const pool of state.pools) {
    assert.equal(new Set(pool.items.map(item => item.key)).size, pool.items.length, "Native pool keys must distinguish logical items");
    for (const item of pool.items) assert.ok(state.work.some(work => work.id === item.work.id && work.status === "succeeded"));
  }
  const interval = (id: string) => ({ start: result.events.find(event => event.event === "provider" && event.packet?.work.id === id)!.time, end: Math.max(...result.events.filter(event => event.event === "tool-call" && event.name === "yield" && result.events.some(call => call.event === "provider" && call.packet?.work.id === id && call.sessionId === event.sessionId)).map(event => event.time)) });
  const a = interval("independent-a"), overlap = interval("overlap-a"), b = interval("independent-b");
  assert.ok(overlap.start >= a.end, "Same-path assignments without dependencies must not mutate concurrently");
  assert.ok(b.start < a.end && a.start < b.end, "Path safety must not stop unrelated concurrent work");
  assert.deepEqual(state.pools.map(pool => `${pool.round}:${pool.lens}`).sort(), ["1:correctness", "1:simplicity", "2:correctness", "2:simplicity"]);
  assert.equal(readFileSync(join(result.cwd, "a.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(result.cwd, "b.txt"), "utf8"), "b\n");
}, 180000);

test("non-Git startup refuses before durable run state", async () => {
  const scenario: Scenario = { id: "non-git", command: "shipit", builds: [] };
  const result = await runScenario(scenario, { nonGit: true });
  evidence.push({ scenario: scenario.id, root: result.root, surface: result.surface, requiredAssertions: ["non-Git refusal before state"], outcome: "observed" });
  assert.equal(result.state, undefined);
  assert.equal(existsSync(join(result.cwd, ".planning", scenario.id)), false);
  assert.ok(result.events.some(event => event.event === "diagnostic" && /git/i.test(String(event.content))), `Missing explicit non-Git diagnostic: ${result.root}`);
}, 180000);

test("the installed package contributes only its three authored personas and every alias", async () => {
  const source = process.env.SUPERSHIP_ACCEPTANCE_SOURCE ?? resolve(".");
  assert.deepEqual(readdirSync(join(source, "agents")).filter(file => file.endsWith(".md")).sort(), ["supership-architect.md", "supership-critic.md", "supership-judge.md"]);
  const scenario: Scenario = { id: "roster", command: "shipit", builds: [] };
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["three authored personas", "all aliases", "shared built-in bodies"]);
  assert.equal(state.lifecycle, "completed", `No-change roster run stopped at ${state.phase}: ${result.root}`);
  const registration = result.events.find(event => event.event === "registration");
  assert.ok(registration?.commands);
  for (const command of commands) assert.equal(registration.commands.filter((name: string) => name === command).length, 1);
  assert.ok(state.seats.filter(seat => !seat.baseAgent.startsWith("supership-")).every(seat => seat.source.kind === "bundled"));
}, 180000);

for (const scenario of dynamicScenarios) test(`real parent registry records source/schema/grants for ${scenario.command}`, async () => {
  const result = await runScenario(scenario, { tui: true });
  const state = record(scenario, result, ["arbitrary worker proposal", "source/schema/grant version approval", "parent callback attribution", "ungranted worker absence"]);
  assert.equal(state.lifecycle, "completed", `Dynamic run stopped at ${state.phase}: ${result.root}`);
  const versions = state.tools.filter(tool => tool.name === "acceptance_mosaic");
  assert.equal(versions.length, 4);
  assert.notEqual(versions[0]!.sourceHash, versions[1]!.sourceHash);
  assert.notEqual(versions[1]!.schemaHash, versions[2]!.schemaHash);
  assert.notDeepEqual(versions[2]!.grants, versions[3]!.grants);
  assert.equal(new Set(versions.map(tool => tool.approvalId)).size, 4);
  for (const tool of versions) {
    const approval = state.approvals.find(approval => approval.id === tool.approvalId)!;
    assert.equal(approval.authority, scenario.command === "supership" || tool.version === 1 ? "omp-tui" : "autonomous-policy");
    assert.equal(approval.scopeHash, tool.approvalScopeHash);
    if (approval.authority === "omp-tui") {
      const prompt = readFileSync(join(result.root, "tui-prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(prompt => prompt.requestId === `tool-${tool.name}-${tool.version}`);
      assert.ok(prompt && prompt.time <= approval.createdAt, "The exact proposal must display before the trusted choice");
      const compact = (text: string) => text.replace(/[\s│]/g, "");
      for (const shown of [dynamicProposal(tool.version).source, JSON.stringify(tool.parameters), JSON.stringify(tool.grants), "Worktree isolation with parent access"]) assert.ok(compact(prompt.screen).includes(compact(shown)), `Missing tool preview: ${shown}`);
    }
  }
  const ownership = JSON.parse(readFileSync(join(result.cwd, ".planning", scenario.id, "ownership.json"), "utf8"));
  assert.ok(ownership.patches.some((patch: { source: { kind: string } }) => patch.source.kind === "parent-callback"));
  assert.equal(readFileSync(join(result.cwd, "parent-effect.txt"), "utf8"), "22\n");
  // Workspace bridge receipts (supership_workspace) share the invocation ledger; the grant assertions concern the proposed callback only.
  const callbacks = state.toolInvocations.filter(invocation => invocation.name === "acceptance_mosaic");
  assert.deepEqual(callbacks.map(invocation => invocation.caller.id).sort(), ["granted-a", "granted-b"]);
  assert.ok(callbacks.every(invocation => invocation.outcome === "success" && invocation.parentAfter));
  assert.equal(state.toolInvocations.some(invocation => invocation.name === "acceptance_mosaic" && invocation.caller.id === "ungranted"), false);
  const ungranted = state.work.find(work => work.id === "ungranted")!;
  assert.deepEqual(ungranted.toolGrants, []);
  assert.ok(result.events.some(event => event.event === "worker-grants" && event.work?.id === "ungranted"));
}, 180000);

for (const stages of [1, 2, 3]) test(`strict malformed mutation output uses ${stages} bounded reporting stages without replay`, async () => {
  const scenario: Scenario = { id: `strict-report-${stages}`, command: "shipit", builds: [{ id: "mutation", path: "once.txt", content: "single mutation\n" }], invalid: { work: "mutation", stages } };
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["strict correction", "named fallback", "no mutation replay"]);
  assert.equal(readFileSync(join(result.cwd, "once.txt"), "utf8"), "single mutation\n");
  assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write").length, 1);
  const corrections = state.work.filter(work => work.context?.kind === "correction");
  assert.equal(corrections.length, Math.min(stages, 2));
  assert.equal(corrections[0]?.seatId, "builder");
  if (stages >= 2) assert.equal(corrections[1]?.seatId, "fallback");
  assert.ok(corrections.every(work => work.mutation === "read-only"));
  if (stages === 3) { assert.equal(state.lifecycle, "blocked"); assert.equal(state.recovery?.primaryReason, "output-attempts-exhausted"); }
  else assert.equal(state.lifecycle, "completed");
}, 180000);

for (const scenario of amendmentScenarios) test(`/${scenario.command} enforces ${scenario.amendment} amendment authority`, async () => {
  const interactive = scenario.command === "supership" || scenario.command === "ultraship";
  const result = await runScenario(scenario, { tui: interactive || scenario.amendment === "safety" || scenario.command === "superreview" });
  const state = record(scenario, result, ["actual worker amendment", "scope classification", "trusted approval boundary", "prior effects retained"]);
  assert.equal(state.planRevision, 2, `Worker amendment was not consumed: ${result.root}`);
  assert.equal(state.planChange?.classification, scenario.amendment);
  assert.equal(readFileSync(join(result.cwd, "destructive-target.txt"), "utf8"), "protected fixture bytes\n");
  if (scenario.amendment === "safety") {
    const decision = state.approvals.find(approval => approval.kind === "safety" && approval.planRevision === 2);
    assert.ok(decision, `Missing actual safety decision: ${result.root}`);
    assert.equal(decision.authority, "omp-tui"); assert.equal(decision.decision, "decline");
    assert.notEqual(state.lifecycle, "completed");
    assert.equal(state.actions.some(action => action.recipients.some(recipient => recipient.workId === "added")), false);
    return;
  }
  assert.equal(state.lifecycle, "completed", `Amendment run stopped at ${state.phase}: ${result.root}`);
  const material = state.approvals.filter(approval => approval.kind === "material-amendment");
  if (scenario.amendment === "ordinary") assert.deepEqual(material, [], "In-scope work must retain its existing authority");
  else {
    assert.equal(material.length, 1);
    assert.equal(material[0]!.authority, interactive || scenario.command === "superreview" ? "omp-tui" : "autonomous-policy");
    assert.equal(readFileSync(join(result.cwd, "added.txt"), "utf8"), "added\n");
    const added = state.work.find(work => work.id === "added")!;
    assert.equal(added.status, "succeeded");
    assert.ok(added.dependencies.every(dependency => state.work.some(work => work.id === dependency.id && work.status === "succeeded")));
    assert.ok(state.verification.some(result => result.outcome === "passed" && result.scopePaths.includes("added.txt")));
  }
}, 180000);

for (const command of commands) test(`/${command} requires a separate final publication decision`, async () => {
  const scenario: Scenario = { id: `push-${command}`, command, builds: command === "superreview" ? [] : [{ id: "initial", path: "result.txt", content: "reviewed output\n" }], findings: command === "superreview" ? [["repair"], []] : [], fixChanges: true, push: true };
  const result = await runScenario(scenario, { tui: true });
  const state = record(scenario, result, ["exact remote/branch/commits approval", "no automatic publication", "decline preserves local work"]);
  const decision = state.approvals.find(approval => approval.kind === "push");
  assert.ok(decision, `No separate final push prompt: ${result.root}`);
  assert.equal(decision.authority, "omp-tui"); assert.equal(decision.decision, "decline");
  assert.equal(decision.scopeHash, state.pushTarget?.scopeHash);
  assert.ok(state.pushTarget?.commits.length);
  assert.ok(state.pushTarget?.branch);
  assert.notEqual(state.pushTarget.branch, "main", "The default branch must not receive generated commits");
  assert.equal(readFileSync(join(result.cwd, ".git", "HEAD"), "utf8").trim(), `ref: refs/heads/${state.pushTarget.branch}`);
  assert.equal(state.pushTarget?.url, join(result.root, "remote.git"));
  const prompt = readFileSync(join(result.root, "tui-prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(prompt => prompt.requestId === "push");
  assert.ok(prompt && prompt.time <= decision.createdAt, "Publication target must display before the trusted choice");
  for (const shown of [state.pushTarget.remote, state.pushTarget.url, state.pushTarget.branch, ...state.pushTarget.commits]) assert.ok(prompt.screen.replace(/[\s│]/g, "").includes(shown), `Missing publication preview: ${shown}`);
  assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "push"), false);
  assert.ok(state.gitOutcomes.some(outcome => outcome.operation === "commit"));
  assert.equal(state.lifecycle, "completed");
}, 180000);

test("a publishing review over an uncommitted same-file user hunk pauses before staging and never commits user bytes", async () => {
  const scenario: Scenario = { id: "publish-ambiguous", command: "superreview", builds: [], findings: [["repair"], []], fixChanges: true, push: true, dirtyBaseline: true };
  const result = await runScenario(scenario, { tui: true });
  const state = record(scenario, result, ["repair overlaps an uncommitted user hunk", "ownership ambiguity pauses before staging", "no commit or push", "user and repaired bytes retained"]);
  assert.ok(["blocked", "paused"].includes(state.lifecycle), `Ambiguous ownership must pause, not ${state.lifecycle}/${state.phase}: ${result.root}`);
  assert.equal(state.phase, "commit");
  assert.equal(state.recovery?.primaryReason, "operation-failed");
  const failed = state.actions.find(action => action.input.kind === "commit" && action.result?.kind === "failure");
  assert.ok(failed && failed.result?.kind === "failure", `The commit must settle as a failed operation, not throw inside the host: ${result.root}`);
  assert.match(failed.result.diagnostic.message, /overlap|ambigu/i);
  assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "commit" || outcome.operation === "push"), false);
  assert.equal(state.approvals.some(approval => approval.kind === "push"), false, "No publication decision may be requested before a commit exists");
  assert.equal(readFileSync(join(result.cwd, "baseline.txt"), "utf8"), "user baseline\nreview target repaired\n", "The repair stays in the checkout for inspection");
  const committed = spawnSync("git", ["show", "HEAD:baseline.txt"], { cwd: result.cwd, encoding: "utf8" });
  assert.equal(committed.stdout, "user baseline\n", "HEAD must not receive user or generated bytes");
  assert.equal(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: result.cwd, encoding: "utf8" }).stdout.trim(), "", "Nothing may stay staged after the pause");
}, 180000);

test("native PlanMode refuses Supership before durable run creation", async () => {
  const scenario: Scenario = { id: "native-planmode", command: "shipit", builds: [] };
  const result = await runScenario(scenario, { tui: true, nativePlanMode: true, extraArgs: ["--plan", "openai-codex/acceptance-parent"] });
  evidence.push({ scenario: scenario.id, root: result.root, surface: result.surface, requiredAssertions: ["actual native /plan control", "native context marker", "refusal before durable state or worker"], outcome: "observed" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, undefined);
  assert.equal(existsSync(join(result.cwd, ".planning", scenario.id)), false);
  assert.ok(result.events.some(event => event.event === "diagnostic" && /Plan Mode|Plan mode/.test(String(event.content))), `Missing explicit native PlanMode refusal: ${result.root}`);
  assert.ok(result.events.some(event => event.event === "preflight-context" && event.messages?.some(message => message.customType === "plan-mode-context")));
  assert.equal(result.events.some(event => event.event === "provider" && event.model !== "acceptance-parent"), false);
  const inputs = readFileSync(join(result.root, "tui-inputs.jsonl"), "utf8");
  assert.ok(inputs.includes("Enable actual native PlanMode"));
}, 180000);

registerLifecycleTests(test, record);

test("native unpriced usage remains unknown while cached tokens count once", async () => {
  const scenario: Scenario = { id: "unpriced-usage", command: "shipit", builds: [], reportUsage: "unpriced" };
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["real per-message usage", "cached tokens included", "unknown pricing never becomes free"]);
  assert.equal(state.lifecycle, "completed");
  assert.ok(state.usageSources.some(source => source.tokens === 23 && source.costAmount === null));
  assert.equal(state.usage.cost.amount, null); assert.ok(state.usage.cost.unpricedModels.length);
  assert.equal(new Set(state.usageSources.map(source => source.id)).size, state.usageSources.length);
  assert.equal(state.usage.tokens, state.usageSources.reduce((sum, source) => sum + source.tokens, 0));
}, 180000);

test("a native worker recursive-registration proposal is refused before a nested registry exists", async () => {
  const scenario: Scenario = { id: "recursive-proposal", command: "shipit", builds: [], recursiveProposal: true };
  const result = await runScenario(scenario);
  const state = record(scenario, result, ["actual worker proposal", "workflow recursive registration refusal", "no nested tool effect"]);
  assert.ok(result.events.some(event => event.event === "tool-call" && event.name === "yield" && JSON.stringify(event.input).includes("acceptance_recursive")));
  assert.equal(state.tools.some(tool => tool.name === "acceptance_recursive" || tool.name === "nested_acceptance"), false);
  assert.equal(state.toolInvocations.length, 0);
  const research = state.work.find(work => work.id === "research-shared")!;
  assert.equal(research.status, "awaiting-output", `The proposing output must be refused, not accepted: ${result.root}`);
  assert.ok(research.evidence.some(ref => /invalid or failed structured result/i.test(ref.summary)), "The refused output must be recorded as invalid evidence");
  assert.equal(state.lifecycle, "blocked"); assert.ok(["missing-named-fallback", "output-attempts-exhausted", "invalid-output"].includes(state.recovery?.primaryReason ?? ""), `Refusal must block without a nested registry: ${state.recovery?.primaryReason}`);
  assert.equal(state.work.some(work => work.kind === "build"), false, "No builder may start behind a refused proposal");
}, 180000);

for (const command of ["supership", "shipit"] as const) test(`/${command} records the trivial single-worker choice and still verifies`, async () => {
  const scenario: Scenario = { id: `fast-${command}`, command, fastPath: true, builds: [{ id: "single", path: "single.txt", content: "single output\n" }] };
  const result = await runScenario(scenario, { tui: command === "supership" });
  const state = record(scenario, result, ["recorded fast path", "mode-specific downgrade authority", "runtime verification"]);
  assert.equal(state.lifecycle, "completed");
  assert.equal(state.plan?.fastPath?.workerId, "single");
  assert.equal(state.approvals.find(approval => approval.kind === "fast-path")?.authority, command === "supership" ? "omp-tui" : "autonomous-policy");
  assert.equal(state.work.filter(work => work.kind === "build").length, 1);
  assert.ok(state.verification.some(result => result.checkId === "check-single" && result.outcome === "passed" && result.verifier.kind === "runtime"));
}, 180000);

for (const outcome of ["pass", "fail"] as const) test(`risk-selected native security review honors a repository ${outcome} check`, async () => {
  const scenario: Scenario = { id: `risk-policy-${outcome}`, command: "shipit", builds: [], securityRisk: true };
  const result = await runScenario(scenario, { policyVerification: outcome });
  const state = record(scenario, result, ["actual required security lens", "repository check from explicit shared policy", "real verification outcome"]);
  for (const lens of ["correctness", "simplicity", "security"]) assert.ok(state.work.some(work => work.context?.kind === "review" && work.context.lens === lens && work.status === "succeeded"));
  assert.ok(result.events.some(event => event.event === "provider" && event.packet?.assignment.context?.kind === "review" && event.packet.assignment.context.lens === "security"));
  const check = state.verification.find(result => result.checkId === "policy-fixture"); assert.ok(check);
  assert.equal(check.outcome, outcome === "pass" ? "passed" : "failed");
  assert.equal(check.verifier.kind, "runtime");
  if (outcome === "pass") { assert.equal(state.lifecycle, "completed"); assert.deepEqual(check.codeIdentity, state.code?.identity); }
  else { assert.notEqual(state.lifecycle, "completed"); assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "commit"), false); }
}, 180000);

for (const limit of ["wall", "tokens", "cost"] as const) test(`a native ${limit} limit pauses and trusted exact limits resume the same run`, async () => {
  const scenario: Scenario = { id: `${limit}-limit-resume`, command: "shipit", reportUsage: limit !== "wall" ? "priced" : undefined, limits: limit === "wall" ? { wallMs: 0 } : limit === "tokens" ? { tokens: 1 } : { cost: { amount: 0.001, currency: "USD" } }, builds: [{ id: "once", path: "once.txt", content: "once\n" }] };
  const result = await runScenario(scenario, { tui: true, recoveryChoice: "continue", recoveryLimits: {} });
  const state = record(scenario, result, ["observable wall-cap pause", "actual TUI limit change", "same-run completion without mutation replay"]);
  const paused = result.snapshots.find(snapshot => snapshot.label === "recovery-prompt")?.state; assert.ok(paused);
  assert.equal(paused.lifecycle, "paused"); assert.ok(paused.recovery?.triggers.includes(limit === "wall" ? "wall-time-cap" : limit === "tokens" ? "token-cap" : "cost-cap"));
  assert.ok(limit === "wall" ? paused.usage.overshoot.wallMs > 0 : limit === "tokens" ? paused.usage.overshoot.tokens > 0 : paused.usage.overshoot.cost !== null && paused.usage.overshoot.cost > 0);
  assert.equal(state.runId, paused.runId); assert.equal(state.lifecycle, "completed");
  assert.deepEqual(state.limits, {}); assert.ok(state.approvals.some(approval => approval.kind === "recovery" && approval.authority === "omp-tui"));
  assert.equal(result.events.filter(event => event.event === "tool-call" && event.name === "write").length, 1);
}, 180000);

for (const missing of ["eval", "reviewer", "secondary-model"] as const) test(`native startup refuses missing ${missing} without silent fallback`, async () => {
  const scenario: Scenario = { id: `missing-${missing}`, command: "ultrashipit", builds: [] };
  const result = await runScenario(scenario, { disabledEval: missing === "eval", disabledAgent: missing === "reviewer" ? "reviewer" : undefined, missingJudgeModel: missing === "secondary-model" });
  evidence.push({ scenario: scenario.id, root: result.root, surface: result.surface, requiredAssertions: ["native unavailable capability or seat", "pre-run refusal", "no undeclared fallback"], outcome: "observed" });
  assert.equal(result.state, undefined);
  assert.equal(existsSync(join(result.cwd, ".planning", scenario.id)), false);
  assert.equal(result.events.some(event => event.event === "provider" && event.model !== "acceptance-parent"), false);
  assert.ok(result.events.some(event => event.event === "diagnostic" && (missing === "eval" ? /eval/i : missing === "reviewer" ? /reviewer.*disabled|disabled.*reviewer/i : /judge-secondary.*unavailable|unavailable.*judge-secondary/i).test(String(event.content))), `Missing exact startup diagnostic: ${result.root}`);
}, 180000);

test("an incompatible reported OMP version fails the public doctor check before any run", async () => {
  // The in-session preflight reads the executing host's own version, which a PATH shim cannot alter on the installed 18.1.10 host;
  // this row proves the public `supership doctor` incompatibility path under the same offline launcher and claims no native host refusal.
  const root = mkdtempSync(join(tmpdir(), "supership-acceptance-unsupported-version-")), bin = join(root, "bin"), cwd = join(root, "repo"), home = join(root, "home"), launcher = join(root, "deny-network");
  mkdirSync(bin); mkdirSync(cwd); mkdirSync(home);
  const compile = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve(import.meta.dir, "support/deny-network.c")], { encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stderr);
  const installed = Bun.which("omp"); assert.ok(installed);
  writeFileSync(join(bin, "omp"), `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf 'omp/0.0.0\\n'; else exec '${installed}' "$@"; fi\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${dirname(installed)}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root, LC_ALL: "C", CI: "1" };
  const doctor = spawnSync(launcher, [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "doctor", "--cwd", cwd], { cwd, env, encoding: "utf8", timeout: 120000 });
  writeFileSync(join(root, "doctor.json"), JSON.stringify({ status: doctor.status, stdout: doctor.stdout, stderr: doctor.stderr }));
  evidence.push({ scenario: "unsupported-version", root, surface: "installed-cli", requiredAssertions: ["controlled reported-version incompatibility through supership doctor", "reported 0.0.0 named in the report", "no durable run or host state", "not a native executing-host refusal"], outcome: "observed" });
  assert.equal(doctor.status, 1, `Doctor must refuse the reported version: ${doctor.stdout}\n${doctor.stderr}`);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.supported, false);
  assert.equal(report.observedVersion, "0.0.0");
  assert.equal(existsSync(join(cwd, ".planning")), false);
  assert.equal(existsSync(join(home, ".omp")), false, "The doctor must not create host state");
}, 180000);

for (const change of ["verified-code", "verification-artifact"] as const) test(`resume refuses stale proof after an external ${change} change`, async () => {
  // The verify->conclude boundary and the conclude action settle inside one supership_next call, so a post-conclude-boundary interruption is not observable through the public host; engine tests cover that path.
  const scenario: Scenario = { id: `evidence-${change}`, command: "shipit", builds: [{ id: "verified", path: "result.txt", content: "verified result\n" }], stopAfter: "verify" };
  const first = await runScenario(scenario, { crashWhen: (_event, _events, state) => state?.phase === "verify" && state.lifecycle === "active" && state.verification.some(result => result.outcome === "passed") && state.actions.every(action => !["issued", "claimed", "running", "uncertain"].includes(action.status)) });
  const before = record(scenario, first, ["real native verification before interruption"]);
  const checked = before.verification.find(result => result.outcome === "passed");
  assert.ok(checked, `No real passing verification before external change: ${first.root}`);
  assert.equal(before.phase, "verify");
  assert.equal(before.lifecycle, "active", "A stale-proof resume must start from an interrupted nonterminal run");
  assert.ok(first.snapshots.some(snapshot => snapshot.label === "before-crash"), "The host must stop after settled native verification without graceful cancellation");
  const reference = checked.evidence.find(ref => ref.kind === "file" && ref.availability === "available");
  assert.ok(reference, "Verification must retain an available runtime artifact");
  const { stopAfter: _stop, ...continued } = scenario;
  const resumed = await runScenario(continued, { resume: first, beforeResumeEdits: [{ path: change === "verified-code" ? "result.txt" : `.planning/${scenario.id}/${reference.uri}`, content: "external fixture change\n" }] });
  const after = record(continued, resumed, ["external bytes survive resume", "old code identity or unavailable artifact cannot authorize completion"]);
  if (change === "verified-code") {
    assert.equal(readFileSync(join(resumed.cwd, "result.txt"), "utf8"), "external fixture change\n");
    assert.notDeepEqual(after.code?.identity, checked.codeIdentity);
    assert.notEqual(after.lifecycle, "completed", "The old result cannot prove changed code");
  } else {
    const old = after.verification.find(result => result.id === checked.id);
    assert.ok(old?.evidence.some(ref => ref.id === reference.id && ref.availability !== "available"), `The tampered artifact must be invalidated on resume: ${resumed.root}`);
    assert.equal(after.lifecycle, "completed", `Unchanged code must re-verify and complete after the stale artifact, not stall at ${after.phase}: ${resumed.root}`);
    assert.ok(after.verification.some(result => result.id !== checked.id && result.outcome === "passed" && result.evidence.every(ref => ref.availability === "available")), "Completion must use a new actual runtime verification");
    assert.equal(resumed.events.filter(event => event.event === "tool-call" && event.name === "write").length, 0, "Re-verification never replays the mutation");
  }
}, 240000);

test("an autonomous initial destructive plan still requires trusted refusal before a builder starts", async () => {
  const scenario: Scenario = { id: "initial-destructive", command: "shipit", initialSafety: true, builds: [{ id: "guarded", path: "guarded.txt", content: "must not write\n" }] };
  const result = await runScenario(scenario, { tui: true });
  const state = record(scenario, result, ["destructive initial plan classified before work", "actual trusted TUI decline", "no autonomous safety grant", "no builder mutation"]);
  assert.ok(state.plan?.scope.effects.includes("delete destructive-target.txt"));
  assert.ok(state.approvals.some(approval => approval.planRevision === 1 && approval.authority === "omp-tui" && approval.decision === "decline"));
  assert.equal(result.events.some(event => event.event === "provider" && event.packet?.assignment.kind === "build"), false);
  assert.equal(existsSync(join(result.cwd, "guarded.txt")), false);
  const protectedPath = join(result.cwd, "destructive-target.txt");
  assert.ok(result.snapshots[0]?.files[protectedPath]);
  assert.equal(result.snapshots.at(-1)?.files[protectedPath], result.snapshots[0]?.files[protectedPath]);
  assert.notEqual(state.lifecycle, "completed");
}, 180000);
