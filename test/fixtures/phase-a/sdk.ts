import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createAgentSession, Settings, ModelRegistry, AuthStorage, SessionManager, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";

const root = process.env.PHASE_A_ROOT!;
const cwd = process.env.PHASE_A_CWD!;
const fixtureExtension = join(import.meta.dir, "extension.ts");
const entries = () => readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
async function makeSession(run: string, models: string[]) {
  const settings = Settings.isolated({
    "providers.openai-codex.codeMode": "on", "memory.backend": "off", "prewalk.enabled": false,
    "startup.checkUpdate": false, "marketplace.autoUpdate": false, "autolearn.enabled": false,
    "compaction.enabled": false, "title.refreshOnReplan": false, "eval.py": false, "eval.js": true,
    "browser.enabled": false, "computer.enabled": false, "task.maxConcurrency": 2,
    "extensions": [fixtureExtension], "task.agentModelOverrides": {}, "retry.enabled": false,
    "task.agentPrewalk": { reviewer: "off" }, "task.agentAdvisor": { reviewer: "off" },
    "task.isolation.enabled": true, "task.isolation.apply": false, "isolation.backend": "rcopy",
  });
  const authStorage = await AuthStorage.create(":memory:");
  // Provider registration supplies a fixture-only transport value, never a real credential.
  const modelRegistry = new ModelRegistry(authStorage, join(root, "models.yml"), {
    settings, cacheDbPath: ":memory:", fetch: async () => { throw new Error("unexpected model discovery fetch"); },
  });
  const result = await createAgentSession({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settings, authStorage, modelRegistry,
    modelPattern: "openai-codex/phase-a-parent",
    disableExtensionDiscovery: false, enableMCP: false, enableLsp: false, enableIrc: true,
    skipPythonPreflight: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    sessionManager: SessionManager.inMemory(cwd), agentId: run, agentDisplayName: run,
  });
  assert.deepEqual(result.extensionsResult.errors, []);
  await result.session.prompt("/phase-a " + JSON.stringify({ op: "start", run, models }));
  assert.deepEqual(settings.get("extensions"), [fixtureExtension, join(root, run)]);
  return { ...result, settings, authStorage, run };
}
interface Fixture extends CreateAgentSessionResult { settings: Settings; authStorage: AuthStorage; run: string }
async function prepare(fixture: Fixture, scenario: string) {
  await fixture.session.waitForIdle();
  await fixture.session.prompt("/phase-a " + JSON.stringify({ op: "prepare", scenario }));
  return JSON.parse(readFileSync(join(root, fixture.run, "action.json"), "utf8"));
}
async function execute(fixture: Fixture, scenario: string, expected = "complete") {
  const action = await prepare(fixture, scenario);
  await fixture.session.waitForIdle();
  await fixture.session.prompt("PHASE_A_EVAL\n" + action.code);
  const receipt = entries().find(event => event.kind === "receipt" && event.receiptKind === expected && event.action === action.id);
  assert.ok(receipt, `Missing ${scenario}/${expected}; evidence ${root}/events.jsonl`);
  return receipt.data;
}
async function waitJob(fixture: Fixture, id: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = fixture.session.getAsyncJobSnapshot({ recentLimit: 100 });
    const job = [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].find(job => job.id === id);
    if (job && job.status !== "running") return job;
    await Bun.sleep(20);
  }
  throw new Error(`Job ${id} did not settle; evidence ${root}/events.jsonl`);
}

const a = await makeSession("sdk-a", ["a", "b"]);
const b = await makeSession("sdk-b", ["c", "d"]);
assert.notEqual(a.settings, b.settings);
const [aResults, bResults] = await Promise.all([execute(a, "finite"), execute(b, "finite")]);
for (const [results, models] of [[aResults, ["phase-a-a", "phase-a-b"]], [bResults, ["phase-a-c", "phase-a-d"]]] as const) {
  assert.deepEqual(results.map((result: { structured: { data: { model: string } } }) => result.structured.data.model).sort(), models);
  for (const result of results) {
    assert.equal(result.status, "completed"); assert.equal(result.structured.status, "valid"); assert.equal(result.structured.mode, "strict");
    assert.equal(result.structured.data.value, 7);
  }
}
assert.deepEqual(a.settings.get("extensions"), [fixtureExtension, join(root, "sdk-a")]);
assert.deepEqual(b.settings.get("extensions"), [fixtureExtension, join(root, "sdk-b")]);

const invalid = await execute(a, "invalid");
assert.equal(invalid[0].status, "failed", JSON.stringify(invalid));
assert.notEqual(invalid[0].structured?.status, "valid");
await execute(a, "duplicate");
assert.equal(entries().filter(event => event.kind === "duplicate_receipt").length, 1);
const stale = await prepare(a, "startup");
await a.session.prompt('/phase-a {"op":"revise"}');
await a.session.prompt("PHASE_A_EVAL\n" + stale.code);
assert.equal(entries().filter(event => event.kind === "receipt" && event.action === stale.id).length, 0);
const interrupted = await prepare(a, "interrupt");
await a.session.prompt("PHASE_A_EVAL\n" + interrupted.code);
assert.equal(entries().filter(event => event.kind === "receipt" && event.action === interrupted.id).length, 0);
const inProgress = a.session.getAsyncJobSnapshot({ recentLimit: 100 });
assert.ok(inProgress?.running.some(job => job.label === "sdk-a-interrupted"), JSON.stringify(inProgress));
await a.session.prompt("PHASE_A_EVAL\n" + interrupted.code);
const cancelled = await execute(a, "recover", "cancelled");
assert.match(cancelled.settled, /cancel|abort/i, JSON.stringify(cancelled));
assert.ok(cancelled.rosterAfter.details.peers.every((peer: { id: string }) => peer.id !== "sdk-a-interrupted"));
assert.ok(entries().some(event => event.kind === "provider_abort"));
assert.equal(a.session.getAsyncJobSnapshot({ recentLimit: 100 })?.running.length, 0);
assert.deepEqual(b.settings.get("extensions"), [fixtureExtension, join(root, "sdk-b")]);
const pool = await execute(a, "pool", "created");
await waitJob(a, pool.name);
const poolResult = await execute(a, "pool-collect", "pool_complete");
assert.equal(poolResult.peek.pending, 0);
assert.equal(poolResult.status.items.completed, 2);
const validation = entries().findLast(event => event.receiptKind === "pool_complete").itemValidation;
assert.deepEqual(validation.map((item: { valid: boolean }) => item.valid).sort(), [false, true]);
const slowPool = await execute(a, "pool-slow", "created");
await Bun.sleep(300);
await execute(a, "pool-cancel", "cancelling");
await Bun.sleep(200);
const poolStopped = await execute(a, "pool-stopped", "cancelled");
assert.equal(poolStopped.peek.pending, 0);
assert.equal(poolStopped.status.items.running, 0);
assert.equal(poolStopped.status.items.queued, 0);
assert.equal(poolStopped.status.items.cancelled, 3);
assert.ok(poolStopped.roster.details.peers.every((peer: { id: string }) => !peer.id.startsWith(slowPool.name)));
const closeReceipt = entries().findLast(event => event.receiptKind === "closed");
assert.equal(closeReceipt.data.status.items.queued, 0);
assert.equal(closeReceipt.data.status.items.running, 2, "close must not claim it stopped active workers");
const isolated = await execute(a, "isolated");
assert.equal(isolated[0].status, "completed", JSON.stringify(isolated));
const dynamic = await execute(a, "dynamic");
assert.equal(dynamic[0].structured?.data?.value, 23, JSON.stringify(dynamic));
const extraRoot = join(root, "unrelated-session-extension"); mkdirSync(extraRoot);
a.settings.override("extensions", [...a.settings.get("extensions"), extraRoot]);
await a.session.prompt('/phase-a {"op":"restore"}');
assert.deepEqual(a.settings.get("extensions"), [fixtureExtension, extraRoot]);
assert.deepEqual(b.settings.get("extensions"), [fixtureExtension, join(root, "sdk-b")]);
await b.session.prompt('/phase-a {"op":"restore"}');
assert.deepEqual(b.settings.get("extensions"), [fixtureExtension]);
a.settings.override("task.disabledAgents", ["reviewer"]);
await a.session.prompt('/phase-a {"op":"start","run":"disabled-seat","models":["a"]}');
assert.equal(existsSync(join(root, "disabled-seat")), false, "A disabled base must not acquire an alias");
a.settings.override("task.disabledAgents", []);
const observed = entries();
const starts = observed.filter(event => event.kind === "started" && event.run.startsWith("sdk-"));
assert.equal(starts[0].bodyHash, starts[1].bodyHash);
assert.equal(new Set(starts.flatMap(event => event.aliases)).size, 4);
assert.ok(observed.some(event => event.kind === "session_start" && event.cwd !== cwd), "A real child must execute in an isolated cwd");
const parentCalls = observed.filter(event => event.kind === "provider" && event.model === "phase-a-parent");
assert.ok(parentCalls.every(event => event.tools.includes("eval") && !event.tools.includes("task") && !event.tools.includes("supership_receipt")), "Code Mode must expose the bridge, with task and receipt behind it");
assert.deepEqual(a.settings.get("task.agentModelOverrides"), {});
assert.deepEqual(b.settings.get("task.agentModelOverrides"), {});
assert.ok(observed.some(event => event.kind === "tool_call" && event.name === "eval"));
assert.ok(observed.some(event => event.kind === "tool_call" && event.name === "task"));
assert.ok(observed.some(event => event.kind === "tool_call" && event.name === "supership_receipt"));
assert.ok(observed.some(event => event.kind === "tool_call" && event.name === "yield"));
assert.ok(observed.every(event => event.kind !== "provider" || event.model.startsWith("phase-a-")));
const report = { sdk: "passed", root, seatModels: [aResults, bResults].map(results => results.map((result: { resolvedModel: string }) => result.resolvedModel)), pool: poolResult, poolStopped };
writeFileSync(join(root, "sdk-evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sdk: "passed", root }));
await a.session.dispose(); await b.session.dispose();
await a.authStorage.close(); await b.authStorage.close();
process.exit(0);
