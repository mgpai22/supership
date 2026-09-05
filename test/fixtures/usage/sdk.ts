import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createAgentSession, Settings, ModelRegistry, AuthStorage, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { prepareUsageMeter } from "../../../src/usage.ts";

const root = process.env.USAGE_PROOF_ROOT!;
const cwd = join(root, "repo"); const runPath = join(root, "run");
const settings = Settings.isolated({
  "providers.openai-codex.codeMode": "on", "memory.backend": "off", "prewalk.enabled": false,
  "startup.checkUpdate": false, "marketplace.autoUpdate": false, "autolearn.enabled": false,
  "compaction.enabled": false, "title.refreshOnReplan": false, "eval.py": false, "eval.js": true,
  "browser.enabled": false, "computer.enabled": false, "task.maxConcurrency": 1, "task.agentIdleTtlMs": 1500,
  "task.isolation.enabled": true, "task.isolation.apply": false, "isolation.backend": "rcopy",
  "extensions": [join(import.meta.dir, "extension.ts")], "task.agentModelOverrides": {}, "retry.enabled": false,
});
const authStorage = await AuthStorage.create(":memory:");
const modelRegistry = new ModelRegistry(authStorage, join(root, "models.yml"), { settings, cacheDbPath: ":memory:", fetch: async () => { throw new Error("unexpected discovery fetch"); } });
// A file-backed parent gives children persisted transcripts, which is what the lifecycle manager parks and revives.
const result = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settings, authStorage, modelRegistry, modelPattern: "openai-codex/usage-parent", disableExtensionDiscovery: false, enableMCP: false, enableLsp: false, enableIrc: true, skipPythonPreflight: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], sessionManager: SessionManager.create(cwd, join(root, "sessions")), agentId: "usage-parent", agentDisplayName: "usage-parent" });
assert.deepEqual(result.extensionsResult.errors, []);
const parentSessionId = result.session.sessionManager.getSessionId();
const identity = { runId: "run-usage", parentSessionId, ownerEpoch: 0 };
const meter = await prepareUsageMeter({ runPath, ...identity });
assert.deepEqual(await prepareUsageMeter({ runPath, ...identity }), meter, "Preparation is idempotent for the same owner");
const agentsRoot = join(root, "agents-extension"); mkdirSync(join(agentsRoot, "agents"), { recursive: true });
for (const model of ["priced", "unpriced"]) writeFileSync(join(agentsRoot, `agents/${model}.md`), `---\nname: usage-${model}-worker\ndescription: Offline usage proof worker\nmodel: openai-codex/usage-${model}\n---\nFollow the scripted fixture.\n`);
settings.override("extensions", [...settings.get("extensions"), agentsRoot, meter.extensionRoot]);
const work = (id: string) => ({ id, revision: 1, attemptId: `${id}-attempt` });
const packet = (actionId: string, ...ids: string[]) => ({ ...identity, actionId, work: ids.map(work) });
const secret = "SECRET-INSTRUCTION-TEXT-MUST-NOT-PERSIST";
const finite = (marker: string, actionId: string, id: string) => JSON.stringify({ assignment: { id, instructions: `${marker} ${secret}` }, work: work(id), supership: packet(actionId, id) });
const item = (id: string) => JSON.stringify({ logicalId: id, work: work(id), assignment: { id, instructions: secret }, supership: packet("pool-push", id) });
const schema = { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false };
const code = `
const prepared = await tool.usage_proof_prepare(${JSON.stringify({ runPath, runId: identity.runId, ownerEpoch: identity.ownerEpoch })});
if (prepared.details?.extensionRoot !== ${JSON.stringify(meter.extensionRoot)}) throw new Error("Extension-graph meter root differs: " + JSON.stringify(prepared));
const normal = await agent(${JSON.stringify(finite("USAGE_NORMAL", "finite-normal", "normal"))}, { agent: "usage-unpriced-worker", label: "usage-normal", schema: ${JSON.stringify(schema)}, schemaMode: "strict" });
const normalResult = await normal.wait();
const isolated = await agent(${JSON.stringify(finite("USAGE_NORMAL", "finite-isolated", "isolated"))}, { agent: "usage-unpriced-worker", label: "usage-isolated", isolated: true, apply: false, merge: false, schema: ${JSON.stringify(schema)}, schemaMode: "strict" });
const isolatedResult = await isolated.wait();
const aborted = await agent(${JSON.stringify(finite("USAGE_ABORT", "finite-aborted", "aborted"))}, { agent: "usage-priced-worker", label: "usage-aborted" });
for (let turn = 0; turn < 400 && !(await Bun.file(${JSON.stringify(join(root, "abort-ready"))}).exists()); turn++) await Bun.sleep(50);
if (!(await Bun.file(${JSON.stringify(join(root, "abort-ready"))}).exists())) throw new Error("Aborted child never reached its second message");
await aborted.cancel(); let rejection = ""; try { await aborted.wait(); } catch (error) { rejection = String(error); }
if (!/abort|cancel/i.test(rejection)) throw new Error("Cancellation did not reject the aborted child: " + rejection);
const pool = await workpool("usage-priced-worker", { name: "usage-pool", context: "Offline usage proof pool" });
const keys = await pool.push(${[1, 2, 3].map(index => JSON.stringify(item(`pool-${index}`))).join(", ")});
let status;
for (let turn = 0; turn < 600; turn++) { status = await pool.status(); if (status.items.completed === 3) break; await Bun.sleep(50); }
if (status.items.completed !== 3) throw new Error("Pool did not complete every item: " + JSON.stringify(status));
await pool.close();
// The finished worker parks after the idle TTL. A hub message revives it from its transcript with a fresh session manager and
// fresh extension instances; the wake turn carries the packet of a new action for the same work.
let parked = "";
for (let turn = 0; turn < 300 && !parked.includes("usage-normal"); turn++) { await Bun.sleep(50); parked = JSON.stringify(await tool.hub({ op: "list", status: "parked", i: "usage proof" })); }
if (!parked.includes("usage-normal")) throw new Error("Finished worker never parked: " + parked);
const unpricedBefore = (await Bun.file(${JSON.stringify(join(root, "events.jsonl"))}).text()).split("\\n").filter(line => line.includes('"kind":"assistant"') && line.includes("usage-unpriced")).length;
const delivery = await normal.send(${JSON.stringify(finite("USAGE_FOLLOWUP", "finite-followup", "normal"))});
let unpricedAfter = unpricedBefore;
for (let turn = 0; turn < 600 && unpricedAfter < unpricedBefore + 1; turn++) { await Bun.sleep(50); unpricedAfter = (await Bun.file(${JSON.stringify(join(root, "events.jsonl"))}).text()).split("\\n").filter(line => line.includes('"kind":"assistant"') && line.includes("usage-unpriced")).length; }
if (unpricedAfter < unpricedBefore + 1) throw new Error("Revived worker never answered the follow-up: " + JSON.stringify({ delivery, unpricedBefore, unpricedAfter }));
await Bun.sleep(500);
display({ marker: ["usage-proof", "complete"].join("-"), normalResult, isolatedResult, rejection, keys, status, parked, delivery, unpricedBefore, unpricedAfter });`;
await result.session.prompt("USAGE_EVAL\n" + code);
await result.session.waitForIdle();
const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
assert.ok(JSON.stringify(result.session.messages).includes("usage-proof-complete"), JSON.stringify(result.session.messages).slice(-4000));
const snapshot = result.session.getAsyncJobSnapshot({ recentLimit: 100 });
const jobs = [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].map(job => ({ id: job.id, label: job.label, status: job.status, agentId: job.agentId }));
writeFileSync(join(root, "evidence.json"), JSON.stringify({ runPath, identity, meter, jobs, sessions: events.filter(event => event.kind === "session"), assistant: events.filter(event => event.kind === "assistant"), providerCalls: events.filter(event => event.kind === "provider").map(event => event.model), secret, abortReady: existsSync(join(root, "abort-ready")) }, null, 2));
await result.session.dispose(); await authStorage.close();
console.log(JSON.stringify({ result: "passed", evidence: join(root, "evidence.json") }));
