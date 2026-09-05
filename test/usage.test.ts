import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shareNativeCache } from "./support/native-cache.ts";
import type { ActionRecord, RunRecord, RuntimeOwner, UsageCoverage, UsageSource, WorkRef } from "../src/contracts.ts";
import { bindUsagePackets, installUsageObserver, prepareUsageMeter, readUsageObservations, usageObservationDirectory } from "../src/usage.ts";
import type { UsageObservation } from "../src/usage.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { assignment, harness, hash } from "./core-fixtures.ts";
import { decide } from "../src/engine.ts";

const parentSessionId = "01a06f6a-8fcf-7000-ade2-7b4361517bcd";
const identity = { runId: "run-usage", parentSessionId, ownerEpoch: 0 };
const work = (id: string): WorkRef => ({ id, revision: 1, attemptId: `${id}-attempt` });
const uuid = (suffix: string) => `01a06f6a-0000-7000-8000-${suffix.padStart(12, "0")}`;
type Authority = Pick<RunRecord, "runId" | "owner" | "actions" | "work" | "usageCoverage" | "usageSources">;
/** A claimed action: the adapter started it, so every recipient is an execution to account for. `issued` actions never launched. */
function action(id: string, refs: WorkRef[], kind: "run_finite" | "pool_push" = "run_finite", status: ActionRecord["status"] = "running"): ActionRecord {
  const input = kind === "run_finite" ? { kind, scheduler: "task" as const, work: refs, assignments: refs.map(ref => assignment(ref.id)) } : { kind, poolId: "pool", items: refs.map(ref => ({ logicalId: ref.id, work: ref, assignment: assignment(ref.id) })) };
  return { schemaVersion: 1, id, runId: identity.runId, ownerEpoch: 0, expectedStateRevision: 0, input, recipients: refs.map(ref => ({ workId: ref.id, workRevision: ref.revision, attemptId: ref.attemptId, seatId: "scout", toolVersions: [] })), planRevision: 1, inputHash: hash, status, issuedAt: 0, ...(status === "issued" ? {} : { claimedAt: 1, claimToolCallId: `claim-${id}` }), receiptIds: [] };
}
function authority(actions: ActionRecord[], owners: Array<Partial<RuntimeOwner> & { actionId: string; workId: string }>, usageCoverage: UsageCoverage[] = [], usageSources: UsageSource[] = []): Authority {
  return { runId: identity.runId, owner: { sessionId: parentSessionId, epoch: 0, leaseId: "lease" }, actions, usageCoverage, usageSources, work: owners.map(owner => ({ schemaVersion: 1, ...assignment(owner.workId), attempt: { id: `${owner.workId}-attempt`, number: 1, validationStage: "initial", seatId: "scout" }, status: "running", runtimeOwners: [{ kind: "task", id: owner.workId, sessionId: parentSessionId, ownerEpoch: 0, workRevision: 1, attemptId: `${owner.workId}-attempt`, status: "observed-terminal", ...owner }] })) };
}
function record(nativeSessionId: string, sequence: number, patch: Partial<UsageObservation> = {}): UsageObservation {
  return { schemaVersion: 1, observerId: uuid("ab"), sequence, nativeSessionId, ...identity, assignments: [{ actionId: "finite", work: [work("one")] }], observedAt: 1000 + sequence, model: "fixture/priced", tokens: 100, costAmount: 0.01, stopReason: "toolUse", complete: true, ...patch };
}
function runDirectory(): string {
  const runPath = mkdtempSync(join(tmpdir(), "supership-usage-unit-"));
  mkdirSync(usageObservationDirectory(runPath), { recursive: true });
  return runPath;
}
const file = (runPath: string, nativeSessionId: string) => join(usageObservationDirectory(runPath), `${nativeSessionId}.jsonl`);
const lines = (runPath: string, nativeSessionId: string, records: Array<UsageObservation | string>) => writeFileSync(file(runPath, nativeSessionId), records.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\n") + "\n");
const summary = (coverage: UsageCoverage[]) => coverage.map(record => [record.id, record.status, record.nativeSessionId, record.observedAt]);

test("binding merges every packet of a batch, dedupes work, and rejects foreign, malformed, or workless packets", () => {
  const packet = (actionId: string, ...ids: string[]) => JSON.stringify({ ...identity, actionId, work: ids.map(work) });
  const batch = `<workpool>\n## Item 1\n{"logicalId":"a","supership":${packet("push", "a")}}\n## Item 2\n{"supership":${packet("push", "b", "a")},"x":{"nested":"{}"}}\n## Item 3\n{"supership":${packet("other", "c")}}\n</workpool>`;
  assert.deepEqual(bindUsagePackets(batch, identity), [{ actionId: "other", work: [work("c")] }, { actionId: "push", work: [work("a"), work("b")] }]);
  assert.equal(bindUsagePackets("plain continuation prompt", identity), undefined);
  assert.equal(bindUsagePackets(JSON.stringify({ instructions: `mentions "supership":{...} in text ${packet("push", "a")}` }), identity), undefined, "A packet quoted inside a JSON string is not a top-level packet");
  assert.equal(bindUsagePackets(`{"supership":${packet("push", "a")}}{"supership":${JSON.stringify({ ...identity, ownerEpoch: 1, actionId: "push", work: [work("a")] })}}`, identity), null, "One foreign packet unbinds the whole turn");
  assert.equal(bindUsagePackets(`{"supership":${packet("push", "a")}}{"supership":${packet("other")}}`, identity), null, "A packet without work is malformed and cannot bind vacuously");
  assert.equal(bindUsagePackets(`{"supership":{"runId":"run-usage","unterminated":`, identity), null);
  assert.equal(bindUsagePackets(`{"supership":{"runId":"run-usage","extra":1}}`, identity), null);
  assert.equal(bindUsagePackets(`{"supership":${packet("push", "a")}}`, { ...identity, parentSessionId: "other-parent" }), null);
});

test("importer derives deterministic message sources, per-work coverage, and gaps from optional input files", async () => {
  const runPath = runDirectory();
  const finite = action("finite", [work("one")]), push = action("pool-push", [work("p1"), work("p2"), work("p3")], "pool_push"), stale = action("stale", [work("old")]);
  const crashed = action("crashed", [work("gone")]), unlaunched = action("unlaunched", [work("never")], "run_finite", "issued");
  const state = authority([finite, push, stale, crashed, unlaunched], [{ actionId: "finite", workId: "one" }, { actionId: "pool-push", workId: "p1", kind: "pool-item", status: "observed-running" }, { actionId: "pool-push", workId: "p2", kind: "pool-item" }, { actionId: "pool-push", workId: "p3", kind: "pool-item" }, { actionId: "stale", workId: "old" }]);
  const session = uuid("1"), pool = uuid("2"), damaged = uuid("3"), foreign = uuid("4"), unbound = uuid("5"), gapped = uuid("6");
  lines(runPath, session, [record(session, 1), record(session, 2, { tokens: 50, costAmount: null, model: "fixture/unpriced", stopReason: "aborted", complete: false }), record(session, 1)]);
  const batch = [{ actionId: "pool-push", work: [work("p2"), work("p3")] }];
  lines(runPath, pool, [record(pool, 1, { assignments: [{ actionId: "pool-push", work: [work("p1")] }], tokens: 300 }), record(pool, 2, { assignments: batch, tokens: 400, costAmount: 0.04 }), record(pool, 3, { assignments: batch, tokens: 0, costAmount: 0, stopReason: "aborted", complete: false })]);
  lines(runPath, damaged, [record(damaged, 1, { assignments: [{ actionId: "stale", work: [work("old")] }], tokens: 7 }), record(damaged, 2, { assignments: [{ actionId: "stale", work: [] }] }), '{"schemaVersion":1,"truncated']);
  lines(runPath, foreign, [record(foreign, 1, { runId: "other-run" }), record(foreign, 2, { assignments: [{ actionId: "finite", work: [work("two")] }] }), record(foreign, 3, { ownerEpoch: 1 }), record(foreign, 4, { assignments: [{ actionId: "missing", work: [work("one")] }] }), record(foreign, 5, { assignments: [{ actionId: "unlaunched", work: [work("never")] }] })]);
  lines(runPath, unbound, [record(unbound, 1, { assignments: null, tokens: 999 })]);
  lines(runPath, gapped, [record(gapped, 1, { assignments: [{ actionId: "stale", work: [work("old")] }], tokens: 1 }), record(gapped, 3, { assignments: [{ actionId: "stale", work: [work("old")] }], tokens: 2 })]);
  lines(runPath, parentSessionId, [record(parentSessionId, 1, { tokens: 5000 })]);
  writeFileSync(join(usageObservationDirectory(runPath), "notes.txt"), "ignored");
  symlinkSync(file(runPath, session), file(runPath, uuid("7")));
  const observed = await readUsageObservations(runPath, state, 5000);
  assert.deepEqual(observed.sources.map(source => [source.id, source.tokens, source.costAmount, source.complete]), [
    [`child:${session}:${uuid("ab")}:1`, 100, 0.01, true], [`child:${session}:${uuid("ab")}:2`, 50, null, false],
    [`child:${pool}:${uuid("ab")}:1`, 300, 0.01, true], [`child:${pool}:${uuid("ab")}:2`, 400, 0.04, true], [`child:${pool}:${uuid("ab")}:3`, 0, 0, false],
    [`child:${damaged}:${uuid("ab")}:1`, 7, 0.01, true], [`child:${gapped}:${uuid("ab")}:1`, 1, 0.01, true], [`child:${gapped}:${uuid("ab")}:3`, 2, 0.01, true],
  ]);
  assert.equal(new Set(observed.sources.map(source => source.id)).size, observed.sources.length, "Every message is one source");
  assert.deepEqual(observed.gaps, [{ nativeSessionId: damaged, reason: "damaged" }, { nativeSessionId: foreign, reason: "rejected" }, { nativeSessionId: unbound, reason: "unbound" }, { nativeSessionId: gapped, reason: "damaged" }, { nativeSessionId: uuid("7"), reason: "damaged" }]);
  assert.deepEqual(summary(observed.coverage), [
    ["usage:crashed:gone:1:gone-attempt", "unknown", undefined, 5000],
    ["usage:finite:one:1:one-attempt", "complete", session, 1002],
    ["usage:pool-push:p1:1:p1-attempt", "partial", pool, 1001], ["usage:pool-push:p2:1:p2-attempt", "complete", pool, 1003], ["usage:pool-push:p3:1:p3-attempt", "complete", pool, 1003],
    ["usage:stale:old:1:old-attempt", "partial", gapped, 1003],
  ], "A claimed recipient without a creation receipt is unknown; issued but never claimed work has no scope");
  assert.ok(observed.coverage.every(coverage => coverage.work.length === 1 && coverage.reason.length));
  const idle = await readUsageObservations(runPath, authority([finite], [{ actionId: "finite", workId: "one", status: "reported" }, { actionId: "finite", workId: "silent" }]), 5000);
  assert.deepEqual(idle.coverage.map(coverage => [coverage.status, coverage.observedAt]), [["partial", 1002], ["unknown", 5000]]);
  assert.deepEqual(await readUsageObservations(runPath, state, 5000), observed, "Re-reading is a pure duplicate import");
  const absent = await readUsageObservations(join(runPath, "absent"), state, 5000);
  assert.deepEqual([absent.sources, absent.gaps, absent.coverage.map(coverage => [coverage.status, coverage.nativeSessionId, coverage.observedAt])], [[], [], observed.coverage.map(() => ["unknown", undefined, 5000])], "A missing observer directory is unknown coverage, never an empty success");
  const run = harness();
  const before = run.accept({ kind: "record-source-usage", sources: observed.sources }).usage;
  assert.deepEqual([before.tokens, before.cost.amount, before.cost.unpricedModels], [860, null, ["fixture/unpriced"]]);
  assert.deepEqual(run.accept({ kind: "record-source-usage", sources: observed.sources }).usage.tokens, 860, "Identical re-import changes no totals");
});

test("canonical coverage outlives vanished input and only new contradictory evidence demotes it", async () => {
  const runPath = runDirectory();
  const session = uuid("c1"), other = uuid("c2");
  const finite = action("finite", [work("one")]), later = action("later", [work("two")]);
  const terminal = [{ actionId: "finite", workId: "one" }, { actionId: "later", workId: "two" }];
  lines(runPath, session, [record(session, 1), record(session, 2)]);
  lines(runPath, other, [record(other, 1, { assignments: [{ actionId: "later", work: [work("two")] }], tokens: 30 })]);
  const first = await readUsageObservations(runPath, authority([finite, later], [terminal[0]!, { ...terminal[1]!, status: "observed-running" }]), 5000);
  assert.deepEqual(summary(first.coverage), [["usage:finite:one:1:one-attempt", "complete", session, 1002], ["usage:later:two:1:two-attempt", "partial", other, 1001]]);
  const canonical = authority([finite, later], terminal, first.coverage);
  const engine = harness();
  const imported = engine.accept({ kind: "record-source-usage", sources: first.sources }).usage.tokens;
  rmSync(file(runPath, session)); rmSync(file(runPath, other));
  const afterLoss = await readUsageObservations(runPath, canonical, 6000);
  assert.deepEqual([afterLoss.sources, afterLoss.gaps, afterLoss.coverage], [[], [], first.coverage], "Vanished input neither erases complete coverage nor promotes prior partial coverage");
  assert.equal(engine.accept({ kind: "record-source-usage", sources: afterLoss.sources }).usage.tokens, imported, "Core keeps the previously imported sources");
  rmSync(usageObservationDirectory(runPath), { recursive: true });
  assert.deepEqual((await readUsageObservations(runPath, canonical, 6000)).coverage, first.coverage, "A vanished directory is the same loss");
  mkdirSync(usageObservationDirectory(runPath), { recursive: true });
  lines(runPath, session, [record(session, 1), record(session, 2), '{"schemaVersion":1,"truncated']);
  const truncated = await readUsageObservations(runPath, canonical, 6000);
  assert.deepEqual(summary(truncated.coverage)[0], ["usage:finite:one:1:one-attempt", "partial", session, 1002], "A truncated tail is new damage and cannot stay complete");
  assert.equal(truncated.coverage[0]!.reason, "Observation input for this work is damaged");
  lines(runPath, session, [record(session, 1), record(session, 2), record(session, 2, { tokens: 5 })]);
  assert.deepEqual(summary((await readUsageObservations(runPath, canonical, 6000)).coverage)[0], ["usage:finite:one:1:one-attempt", "partial", session, 1002], "A conflicting duplicate is new damage");
  rmSync(file(runPath, session)); symlinkSync(join(runPath, "elsewhere"), file(runPath, session));
  assert.deepEqual(summary((await readUsageObservations(runPath, canonical, 6000)).coverage)[0], ["usage:finite:one:1:one-attempt", "partial", session, 1002], "An unreadable replacement of the known input is new damage");
  rmSync(file(runPath, session)); lines(runPath, session, [record(session, 1), record(session, 2), record(session, 3)]);
  const restored = await readUsageObservations(runPath, canonical, 6000);
  assert.deepEqual(summary(restored.coverage), [["usage:finite:one:1:one-attempt", "complete", session, 1003], ["usage:later:two:1:two-attempt", "partial", other, 1001]], "Intact input is re-derived; the untouched partial scope stays as recorded");
  assert.equal(new Set(restored.sources.map(source => source.id)).size, restored.sources.length);
  const fresh = harness();
  fresh.accept({ kind: "record-source-usage", sources: first.sources });
  assert.equal(fresh.accept({ kind: "record-source-usage", sources: restored.sources }).usage.tokens, 330, "Re-imported messages merge by id, never duplicate");
});

test("a retry keeps the prior attempt's complete coverage until new damage arrives", async () => {
  const runPath = runDirectory();
  const session = uuid("e1"), finite = action("finite", [work("one")]);
  lines(runPath, session, [record(session, 1), record(session, 2)]);
  const first = await readUsageObservations(runPath, authority([finite], [{ actionId: "finite", workId: "one" }]), 5000);
  assert.deepEqual(summary(first.coverage), [["usage:finite:one:1:one-attempt", "complete", session, 1002]]);
  // The engine's retry replaces the work item and drops the terminal runtime owner while the observer file stays untouched.
  const retried = authority([finite], [{ actionId: "finite", workId: "one" }], first.coverage);
  for (const item of retried.work) item.runtimeOwners = [];
  assert.deepEqual((await readUsageObservations(runPath, retried, 6000)).coverage, first.coverage, "Unchanged evidence never demotes a canonical complete verdict");
  lines(runPath, session, [record(session, 1), record(session, 2), '{"schemaVersion":1,"truncated']);
  assert.deepEqual(summary((await readUsageObservations(runPath, retried, 6000)).coverage), [["usage:finite:one:1:one-attempt", "partial", session, 1002]], "New corruption still demotes after the retry");
});

test("a rewritten model identity is damage to that input, not a batch the core refuses", async () => {
  const runPath = runDirectory();
  const session = uuid("f1"), other = uuid("f2");
  const finite = action("finite", [work("one")]), later = action("later", [work("two")]);
  const owners = [{ actionId: "finite", workId: "one" }, { actionId: "later", workId: "two" }];
  lines(runPath, session, [record(session, 1), record(session, 2)]);
  lines(runPath, other, [record(other, 1, { assignments: [{ actionId: "later", work: [work("two")] }], tokens: 30 })]);
  const first = await readUsageObservations(runPath, authority([finite], [owners[0]!]), 5000);
  const engine = harness();
  const imported = engine.accept({ kind: "record-source-usage", sources: first.sources }).usage.tokens;
  const forged = { ...first.sources[0]!, model: "fixture/other" };
  assert.equal(decide(engine.state, { kind: "record-source-usage", sources: [forged] }, engine.context()).kind, "reject", "The core still refuses a hand-crafted identity change");
  lines(runPath, session, [record(session, 1, { model: "fixture/other" }), record(session, 2)]);
  const canonical = authority([finite, later], owners, first.coverage, engine.state.usageSources);
  const observed = await readUsageObservations(runPath, canonical, 6000);
  assert.deepEqual(observed.gaps, [{ nativeSessionId: session, reason: "damaged" }]);
  assert.ok(!observed.sources.some(source => source.id === forged.id), "The conflicting row is never re-emitted");
  assert.deepEqual(summary(observed.coverage), [["usage:finite:one:1:one-attempt", "partial", session, 1002], ["usage:later:two:1:two-attempt", "complete", other, 1001]]);
  const parent = { id: `parent:${parentSessionId}:1`, complete: true, tokens: 500, costAmount: 0.5, model: "fixture/priced", observedAt: 6000 };
  const usage = engine.accept({ kind: "record-source-usage", sources: [parent, ...observed.sources] }).usage;
  assert.equal(usage.tokens, imported + 500 + 30, "Unrelated parent and child usage keeps importing while the damaged row stays at its canonical value");
  assert.equal(engine.state.usageSources.find(source => source.id === forged.id)?.model, "fixture/priced");
});

test("a token count the aggregate cannot hold is damage to that input, and a near-bound canonical total never blocks later usage", async () => {
  const runPath = runDirectory();
  const session = uuid("a1"), other = uuid("a2"), max = Number.MAX_SAFE_INTEGER;
  const finite = action("finite", [work("one")]), later = action("later", [work("two")]);
  const owners = [{ actionId: "finite", workId: "one" }, { actionId: "later", workId: "two" }];
  lines(runPath, session, [record(session, 1), record(session, 2, { tokens: max })]);
  lines(runPath, other, [record(other, 1, { assignments: [{ actionId: "later", work: [work("two")] }], tokens: 30 })]);
  const observed = await readUsageObservations(runPath, authority([finite, later], owners), 5000);
  assert.deepEqual(observed.gaps, [{ nativeSessionId: session, reason: "damaged" }]);
  assert.deepEqual(observed.sources.map(source => source.tokens), [100, 30], "The unrepresentable row is withheld; every other row still imports");
  assert.deepEqual(summary(observed.coverage), [["usage:finite:one:1:one-attempt", "partial", session, 1001], ["usage:later:two:1:two-attempt", "complete", other, 1001]]);
  const engine = harness();
  const parent = (sequence: number, tokens: number) => ({ id: `parent:${parentSessionId}:${sequence}`, complete: true, tokens, costAmount: 0.5, model: "fixture/priced", observedAt: 6000 + sequence });
  assert.equal(engine.accept({ kind: "record-source-usage", sources: [parent(1, 500), ...observed.sources] }).usage.tokens, 630);
  // A row that exactly fills the remaining aggregate is representable and imports; re-reading it against the canonical state is a duplicate, not new damage.
  lines(runPath, session, [record(session, 1), record(session, 2, { tokens: max - 630 })]);
  const filled = await readUsageObservations(runPath, authority([finite, later], owners, observed.coverage, engine.state.usageSources), 7000);
  assert.deepEqual([filled.gaps, filled.sources.map(source => source.tokens)], [[], [100, max - 630, 30]]);
  engine.accept({ kind: "record-source-usage", sources: filled.sources });
  assert.equal(engine.state.usage.tokens, max);
  const again = await readUsageObservations(runPath, authority([finite, later], owners, filled.coverage, engine.state.usageSources), 8000);
  assert.deepEqual([again.gaps, again.sources], [[], filled.sources], "Canonical rows never count against the aggregate again");
  // New parent usage after a canonical total at the bound saturates the aggregate instead of refusing the batch and blocking every later control turn.
  const usage = engine.accept({ kind: "record-source-usage", sources: [parent(2, 500), ...filled.sources] }).usage;
  assert.equal(usage.tokens, max, "The aggregate saturates at the schema bound");
  assert.equal(usage.cost.pricedSubtotal, 0.5 + 0.5 + 0.01 + 0.01 + 0.01, "Priced cost keeps summing past the token bound");
  assert.deepEqual(engine.state.usageSources.map(source => source.tokens).sort((a, b) => a - b), [30, 100, 500, 500, max - 630], "Every individual source stays canonical and intact");
  assert.equal(engine.accept({ kind: "request-cancel", reason: "operator", evidence: [] }).lifecycle, "cancelled", "Control turns still proceed after saturation");
  lines(runPath, other, [record(other, 1, { assignments: [{ actionId: "later", work: [work("two")] }], tokens: 30 }), record(other, 2, { assignments: [{ actionId: "later", work: [work("two")] }], tokens: 1 })]);
  const saturated = await readUsageObservations(runPath, authority([finite, later], owners, filled.coverage, engine.state.usageSources), 9000);
  assert.deepEqual([saturated.gaps, saturated.sources.length], [[{ nativeSessionId: other, reason: "damaged" }], 3], "Past the bound, any growth is unrepresentable and reported as damage");
  const capped = harness(); capped.accept({ kind: "configure-limits", limits: { tokens: 1000 }, rationale: "fixture cap" });
  const paused = capped.accept({ kind: "record-source-usage", sources: [parent(1, max), parent(2, 500)] });
  assert.deepEqual([paused.usage.tokens, paused.usage.overshoot.tokens, paused.lifecycle, paused.recovery?.triggers], [max, max - 1000, "paused", ["token-cap"]], "Cap controls still fire on a saturated total");
});

test("prepared meter root is immutable per owner and rejects a changed configuration", async () => {
  const runPath = runDirectory();
  const meter = await prepareUsageMeter({ runPath, ...identity });
  assert.deepEqual(await prepareUsageMeter({ runPath, ...identity }), meter);
  assert.match(readFileSync(join(meter.extensionRoot, "index.ts"), "utf8"), /installUsageObserver\(api, \{"ownerEpoch":0/);
  assert.notEqual((await prepareUsageMeter({ runPath, ...identity, ownerEpoch: 1 })).extensionRoot, meter.extensionRoot);
  writeFileSync(join(meter.extensionRoot, "index.ts"), "export default () => {};\n");
  await assert.rejects(prepareUsageMeter({ runPath, ...identity }), /Trusted usage meter configuration changed/);
  await assert.rejects(prepareUsageMeter({ runPath: join(runPath, "missing"), ...identity }));
});

test("observer claims one live session object per instance and never fabricates usage the protocol did not report", () => {
  const runPath = runDirectory();
  const config = { schemaVersion: 1 as const, runPath, ...identity };
  const install = () => { const handlers: Record<string, Function> = {}; installUsageObserver({ on: (name: string, handler: Function) => { handlers[name] = handler; } } as unknown as ExtensionAPI, config); return handlers; };
  const child = uuid("d1"), manager = { getSessionId: () => child }, ctx = { sessionManager: manager, models: { resolve: () => undefined } };
  const packet = JSON.stringify({ supership: { ...identity, actionId: "finite", work: [work("one")] } });
  const assistant = (usage: unknown, stopReason = "toolUse") => ({ role: "assistant", provider: "fixture", model: "priced", stopReason, usage, timestamp: 5, content: [] });
  const first = install(), second = install();
  for (const handlers of [first, second]) handlers.message_end!({ type: "message_end", message: { role: "user", content: packet } }, ctx);
  first.message_end!({ type: "message_end", message: assistant({ totalTokens: 12, cost: { total: 0.5 } }) }, ctx);
  second.message_end!({ type: "message_end", message: assistant({ totalTokens: 999, cost: { total: 9 } }) }, ctx);
  first.message_end!({ type: "message_end", message: assistant({ totalTokens: "twelve" }) }, ctx);
  first.message_end!({ type: "message_end", message: assistant(undefined, "stop") }, ctx);
  const revived = install(), reopened = { getSessionId: () => child };
  revived.message_end!({ type: "message_end", message: { role: "custom", customType: "irc:incoming", content: `<irc>\n${packet}\n</irc>` } }, { ...ctx, sessionManager: reopened });
  revived.message_end!({ type: "message_end", message: assistant({ totalTokens: 7 }) }, { ...ctx, sessionManager: reopened });
  const records = readFileSync(file(runPath, child), "utf8").trim().split("\n").map(line => JSON.parse(line) as UsageObservation);
  assert.deepEqual(records.map(item => [item.observerId === records[0]!.observerId ? "first" : "revived", item.sequence, item.tokens, item.costAmount, item.stopReason, item.complete]), [
    ["first", 1, 12, 0.5, "toolUse", true], ["first", 2, 0, null, "malformed-usage", false], ["first", 3, 0, null, "malformed-usage", false], ["revived", 1, 7, null, "toolUse", true],
  ], "A second observer on the same session object is silent, malformed usage is an incomplete zero, and a reopened session object admits a fresh observer");
  assert.ok(records.every(item => item.assignments?.[0]?.actionId === "finite"));
});

test("real OMP children meter every assistant message through inherited hooks on non-isolated, isolated, aborted, reused, and revived pool routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "supership-usage-")); const home = join(root, "home"); mkdirSync(join(home, ".omp/agent"), { recursive: true });
  shareNativeCache(home);
  const cwd = join(root, "repo"); mkdirSync(cwd); mkdirSync(join(root, "run"));
  const protectedPaths = [join(process.env.HOME!, ".omp/agent/config.yml"), resolve(".omp/config.yml")];
  const checksums = () => protectedPaths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
  const protectedBefore = checksums(); const launcher = join(root, "deny-network");
  const env = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp/agent"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), TMPDIR: root, LC_ALL: "C", TERM: "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true", USAGE_PROOF_ROOT: root };
  const run = (args: string[]) => {
    const result = spawnSync(args[0]!, args.slice(1), { cwd, env, encoding: "utf8", timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(root, "last-command.json"), JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nEvidence: ${root}`); return result.stdout;
  };
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve("test/support/deny-network.c")]);
  run(["git", "init", "-q", "-b", "fixture"]);
  run(["git", "-c", "user.name=Offline Fixture", "-c", "user.email=offline@invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]);
  const installed = Bun.which("omp"); assert.ok(installed);

  run([launcher, process.execPath, resolve("test/fixtures/usage/sdk.ts")]);
  assert.deepEqual(checksums(), protectedBefore);
  const evidence = JSON.parse(readFileSync(join(root, "evidence.json"), "utf8"));
  const parent = evidence.identity.parentSessionId as string;
  assert.deepEqual(Object.fromEntries(evidence.jobs.map((job: { label: string; status: string }) => [job.label, job.status])), { "usage-normal": "completed", "usage-isolated": "completed", "usage-aborted": "cancelled", "usage-pool": "completed", "usage-pool-1-b1": "completed", "usage-pool-1-b2": "completed" });
  const truth = evidence.assistant.filter((message: { session: string }) => message.session !== parent) as Array<{ session: string; model: string; stopReason: string; tokens: number; cost: number }>;
  const files = readdirSync(usageObservationDirectory(evidence.runPath)).sort();
  assert.deepEqual(files, [...new Set(truth.map(message => `${message.session}.jsonl`))].sort(), "One input per child native session, none for the parent");
  const records = files.flatMap(file => readFileSync(join(usageObservationDirectory(evidence.runPath), file), "utf8").trim().split("\n").map(line => JSON.parse(line) as UsageObservation));
  assert.equal(records.length, truth.length, "Every child assistant message is metered exactly once");
  assert.equal(records.length, (evidence.providerCalls as string[]).filter(model => model !== "usage-parent").length, "Every child provider request, including the aborted follow-up request, has one record");
  assert.ok(records.every(item => !JSON.stringify(item).includes(evidence.secret)), "No prompt or message content persists");
  const refs = (...ids: string[]) => ids.map(id => ({ id, revision: 1, attemptId: `${id}-attempt` }));
  const poolWork = ["pool-1", "pool-2", "pool-3"];
  const actions = [action("finite-normal", refs("normal")), action("finite-followup", refs("normal")), action("finite-isolated", refs("isolated")), action("finite-aborted", refs("aborted")), action("pool-push", refs(...poolWork), "pool_push")];
  const owners = [{ actionId: "finite-normal", workId: "normal" }, { actionId: "finite-followup", workId: "normal" }, { actionId: "finite-isolated", workId: "isolated" }, { actionId: "finite-aborted", workId: "aborted" }, ...poolWork.map(workId => ({ actionId: "pool-push", workId, kind: "pool-item" as const }))];
  const state = { ...authority(actions, owners), runId: evidence.identity.runId, owner: { sessionId: parent, epoch: 0, leaseId: "lease" } };
  const observed = await readUsageObservations(evidence.runPath, state);
  assert.deepEqual(observed.gaps, []);
  assert.equal(observed.sources.length, truth.length);
  assert.equal(new Set(observed.sources.map(source => source.id)).size, truth.length);
  assert.equal(observed.sources.reduce((total, source) => total + source.tokens, 0), truth.reduce((total, message) => total + message.tokens, 0));
  const bySession = (session: string) => records.filter(item => item.nativeSessionId === session);
  const normalSession = records.find(item => item.assignments?.[0]?.actionId === "finite-normal")!.nativeSessionId;
  const normal = bySession(normalSession).filter(item => item.assignments?.[0]?.actionId === "finite-normal");
  assert.deepEqual(normal.map(item => [item.sequence, item.tokens, item.costAmount, item.stopReason, item.complete]), [[1, 136, null, "toolUse", true], [2, 168, null, "toolUse", true]], "Cached tokens count in totals and an all-zero rate card stays unpriced");
  const revived = bySession(normalSession).filter(item => item.assignments?.[0]?.actionId === "finite-followup");
  assert.ok(revived.length >= 1 && revived.every(item => item.observerId !== normal[0]!.observerId && item.observerId === revived[0]!.observerId), "The parked worker revived with one fresh observer instance in the same native session");
  assert.deepEqual(revived.map(item => [item.sequence, item.assignments]), revived.map((_, index) => [index + 1, [{ actionId: "finite-followup", work: [{ id: "normal", revision: 1, attemptId: "normal-attempt" }] }]]), "The hub wake turn rebinds to the follow-up action from sequence 1");
  assert.equal(bySession(normalSession).length, normal.length + revived.length, "The revived session has no unbound or double-claimed message");
  assert.ok(evidence.sessions.filter((session: { id: string }) => session.id === normalSession).length >= 2, "The worker session started twice: once live, once revived from its transcript");
  const isolated = bySession(records.find(item => item.assignments?.[0]?.actionId === "finite-isolated")!.nativeSessionId);
  assert.deepEqual([isolated.length, new Set(isolated.map(item => item.observerId)).size], [2, 1], "The rediscovered root meters an isolated child through one observer only");
  const aborted = bySession(records.find(item => item.assignments?.[0]?.actionId === "finite-aborted")!.nativeSessionId);
  assert.deepEqual(aborted.map(item => [item.tokens, item.costAmount, item.stopReason, item.complete]), [[460, 0.002125, "toolUse", true], [0, 0, "aborted", false]]);
  const pool = bySession(records.find(item => item.assignments?.[0]?.actionId === "pool-push")!.nativeSessionId);
  assert.deepEqual(pool.map(item => [item.sequence, item.assignments!.flatMap(entry => entry.work.map(ref => ref.id)), item.tokens]), [[1, ["pool-1"], 1110], [2, ["pool-1"], 0], [3, ["pool-2", "pool-3"], 1110], [4, ["pool-2", "pool-3"], 1210], [5, ["pool-2", "pool-3"], 0]], "A reused worker rebinds to the exact second batch and each batch message is stored once");
  assert.equal(observed.sources.filter(source => source.id.includes(pool[0]!.nativeSessionId)).length, 5, "Batch messages are never multiplied per item");
  assert.deepEqual(observed.coverage.map(coverage => [coverage.id, coverage.status, coverage.nativeSessionId]), [
    ["usage:finite-aborted:aborted:1:aborted-attempt", "complete", aborted[0]!.nativeSessionId], ["usage:finite-followup:normal:1:normal-attempt", "complete", normalSession], ["usage:finite-isolated:isolated:1:isolated-attempt", "complete", isolated[0]!.nativeSessionId], ["usage:finite-normal:normal:1:normal-attempt", "complete", normalSession],
    ...poolWork.map(id => [`usage:pool-push:${id}:1:${id}-attempt`, "complete", pool[0]!.nativeSessionId]),
  ]);
  const run2 = harness();
  const usage = run2.accept({ kind: "record-source-usage", sources: observed.sources }).usage;
  assert.deepEqual([usage.tokens, usage.cost.amount, usage.cost.unpricedModels], [truth.reduce((total, message) => total + message.tokens, 0), null, ["openai-codex/usage-unpriced"]]);
  assert.equal(run2.accept({ kind: "record-source-usage", sources: (await readUsageObservations(evidence.runPath, state)).sources }).usage.tokens, usage.tokens, "Duplicate import leaves totals unchanged");
  assert.ok(observed.sources.some(source => source.costAmount === 0.002125) && observed.sources.some(source => source.costAmount === 0.0032));
  writeFileSync(join(root, "usage-evidence.json"), JSON.stringify({ observed, records }, null, 2));
}, 240_000);
