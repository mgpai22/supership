import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readlinkSync } from "node:fs";
import { createAgentSession, Settings, ModelRegistry, AuthStorage, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { prepareWorkspace, captureWorkspace, revokeWorkspace } from "../../../src/workspace.ts";
import type { PrepareWorkspace } from "../../../src/workspace.ts";
import { captureBaseline } from "../../../src/git.ts";

const root = process.env.WORKSPACE_PROOF_ROOT!;
const request = JSON.parse(readFileSync(join(root, "request.json"), "utf8")) as PrepareWorkspace;
const settings = Settings.isolated({
  "providers.openai-codex.codeMode": "on", "memory.backend": "off", "prewalk.enabled": false,
  "startup.checkUpdate": false, "marketplace.autoUpdate": false, "autolearn.enabled": false,
  "compaction.enabled": false, "title.refreshOnReplan": false, "eval.py": false, "eval.js": true,
  "browser.enabled": false, "computer.enabled": false, "task.maxConcurrency": 2,
  "extensions": [join(import.meta.dir, "extension.ts")], "task.agentModelOverrides": {}, "retry.enabled": false,
  "task.isolation.enabled": true, "task.isolation.apply": false, "isolation.backend": "rcopy",
});
const authStorage = await AuthStorage.create(":memory:");
const modelRegistry = new ModelRegistry(authStorage, join(root, "models.yml"), { settings, cacheDbPath: ":memory:", fetch: async () => { throw new Error("unexpected discovery fetch"); } });
const result = await createAgentSession({ cwd: request.repositoryRoot, agentDir: process.env.PI_CODING_AGENT_DIR, settings, authStorage, modelRegistry, modelPattern: "openai-codex/workspace-parent", disableExtensionDiscovery: false, enableMCP: false, enableLsp: false, enableIrc: true, skipPythonPreflight: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], sessionManager: SessionManager.inMemory(request.repositoryRoot), agentId: "workspace-parent", agentDisplayName: "workspace-parent" });
assert.deepEqual(result.extensionsResult.errors, []);
writeFileSync(join(root, "discovery.json"), JSON.stringify({ extensions: result.extensionsResult.extensions.map(extension => extension.path), settings: settings.get("extensions"), model: result.session.model, messages: result.session.messages }));
request.parentSessionId = result.session.sessionManager.getSessionId();
const source = await captureBaseline(request.repositoryRoot);
const a = await prepareWorkspace({ ...request, grantedToolNames: ["supership_proof_read"], assignment: { ...request.assignment, toolGrants: [{ name: "proof-read", version: 1, approvalId: "fixture-approved" }] } });
const b = await prepareWorkspace({ ...request, work: { ...request.work, id: "second" }, assignment: { ...request.assignment, id: "second" } });
writeFileSync(join(root, "bindings.json"), JSON.stringify([a, b]));
const agentsRoot = join(root, "agents-extension"); mkdirSync(join(agentsRoot, "agents"), { recursive: true });
writeFileSync(join(agentsRoot, "agents/worker.md"), "---\nname: workspace-proof-worker\ndescription: Offline workspace proof worker\nmodel: openai-codex/workspace-child\n---\nUse only the granted workspace callback for durable code operations.\n");
settings.override("extensions", [...settings.get("extensions"), agentsRoot, a.extensionRoot]);
const schema = { type: "object", properties: { operation: { type: "string", enum: ["read", "write", "edit", "bash"] }, input: { type: "object", additionalProperties: true } }, required: ["operation", "input"], additionalProperties: false };
const registrations = [a, b].map(binding => `await tool(async function(args) { const routed = await tool.workspace_proof_route({marker:${JSON.stringify(binding.marker)},operation:args.operation,input:args.input}); const route = routed.details; if (!route) throw new Error(JSON.stringify(routed)); return await tool[route.toolName](route.input); }, {name:${JSON.stringify(binding.grantName)},description:"Worktree isolation with parent access",parameters:${JSON.stringify(schema)}});`).join("\n");
const task = JSON.stringify({ assignment: request.assignment, work: a.work, parentAccess: a.parentAccess, workspace: { marker: a.marker, path: a.path, grantName: a.grantName, manifestDigest: a.manifestDigest, workId: a.work.id, workRevision: a.work.revision, attemptId: a.work.attemptId } });
const code = `${registrations}
await tool(async function() { const routed = await tool.workspace_proof_route({marker:${JSON.stringify(a.marker)},operation:"read",input:{path:"tracked.txt"}}); return await tool.read(routed.details.input); }, {name:"supership_proof_read",description:"Read assigned durable source",parameters:{type:"object",properties:{},additionalProperties:false}});
const unbound = await agent("WORKSPACE_UNBOUND", {agent:"workspace-proof-worker",label:"workspace-unbound-child",isolated:true,apply:false,tools:[${JSON.stringify(b.grantName)}]});
await unbound.wait();
const child = await agent(${JSON.stringify(task)}, {agent:"workspace-proof-worker",label:"workspace-retention-child",isolated:true,apply:false,tools:[${JSON.stringify(a.grantName)},"supership_proof_read"]});
let ready = false;
for (let turn=0; turn<200; turn++) { const state = await tool.workspace_proof_state({}); if (state.details?.ready) { ready=true; break; } await Bun.sleep(50); }
if (!ready) { await child.cancel(); throw new Error("Child did not complete mutations"); }
await child.cancel(); let rejection=""; try { await child.wait(); } catch(error) { rejection=String(error); }
if (!/abort|cancel/i.test(rejection)) throw new Error("Cancellation did not reject child wait: "+rejection);
display({cancelled:true});`;
await result.session.prompt("WORKSPACE_EVAL\n" + code);
await result.session.waitForIdle();
writeFileSync(join(root, "messages.json"), JSON.stringify(result.session.messages));
const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const childSessions = events.filter(event => event.kind === "session" && event.id !== request.parentSessionId);
const childSession = childSessions.at(-1);
assert.ok(childSession, "No actual isolated child session");
const deadline = Date.now() + 20_000;
let job;
while (Date.now() < deadline) {
  const snapshot = result.session.getAsyncJobSnapshot({ recentLimit: 100 });
  job = snapshot?.recent.find(job => job.label === "workspace-retention-child");
  if (job?.status === "cancelled" && !existsSync(childSession.cwd)) break;
  await Bun.sleep(20);
}
assert.equal(job?.status, "cancelled", JSON.stringify(events));
assert.equal(existsSync(childSession.cwd), false, "Native scratch must disappear before retention assertions");
assert.equal(readFileSync(join(a.path, "tracked.txt"), "utf8"), "child mutation\n");
assert.equal(readFileSync(join(a.path, "new.txt"), "utf8"), "durable output\n");
assert.equal(readFileSync(join(a.path, "command.txt"), "utf8"), "native-callback-command\n");
assert.deepEqual(readFileSync(join(a.path, "binary.bin")), Buffer.from([0, 255, 128, 10]));
assert.equal(readlinkSync(join(a.path, "link.txt")), "tracked.txt");
assert.equal(existsSync(join(a.path, "native-denied.txt")), false);
assert.equal(existsSync(join(b.path, "new.txt")), false);
assert.deepEqual((await captureBaseline(request.repositoryRoot)).identity, source.identity);
const completed = events.find(event => event.kind === "tool" && event.name === "eval" && event.cwd === childSession.cwd && JSON.stringify(event.content).includes("workspace-mutation-complete"));
assert.ok(completed, JSON.stringify(events));
assert.match(completed.content[0].text, /"nativeWriteDenied": true/);
assert.match(completed.content[0].text, /"crossWorkDenied": true/);
assert.ok(events.some(event => event.kind === "tool" && event.name === "eval" && JSON.stringify(event.content).includes("unbound-denied")));
assert.ok(childSessions.every(event => !existsSync(event.cwd)));
assert.ok(events.filter(event => event.kind === "route").every(event => event.work === a.work.id));
assert.ok(events.some(event => event.kind === "route" && event.operation === "bash" && event.input.cwd === a.path));
revokeWorkspace(a); revokeWorkspace(a);
const capture = await captureWorkspace(a);
assert.deepEqual(capture.patch.changes.map(change => change.path), ["command.txt", "new.txt", "tracked.txt"]);
writeFileSync(join(root, "evidence.json"), JSON.stringify({ status: job.status, nativeScratchGone: true, nativeWriteDenied: true, crossWorkDenied: true, path: a.path, patch: capture.patch, binding: a }, null, 2));
await result.session.dispose(); await authStorage.close();
console.log(JSON.stringify({ result: "passed", evidence: join(root, "evidence.json") }));
