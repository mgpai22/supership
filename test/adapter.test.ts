import { test } from "bun:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { doctor, readRuntimeSnapshot, CapabilityReportSchema } from "../src/omp.ts";
import { assertSchema, type RunRecord, type RuntimeOwner, type SchedulingSnapshot } from "../src/contracts.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { shareNativeCache } from "./support/native-cache.ts";

test("runtime snapshot reports the WorkPool owner from its aggregate job, never inferring an unpushed pool ended", () => {
  const owner: RuntimeOwner = { kind: "pool", id: "pool-1-correctness", actionId: "a-1", workId: "pool-1-correctness", workRevision: 1, attemptId: "a-1", sessionId: "s", ownerEpoch: 0, status: "observed-running" };
  const item = { kind: "pool-item", id: owner.id + "#1", parentId: owner.id, logicalKey: owner.id + "#1", actionId: "a-2", workId: "r", workRevision: 1, attemptId: "r:1", sessionId: "s", ownerEpoch: 0 };
  const state = (keys: boolean, itemStatus?: "observed-running" | "observed-terminal") => ({ owner: { sessionId: "s", epoch: 0, leaseId: "l" }, work: itemStatus ? [{ id: "r", revision: 1, attempt: { id: "r:1" }, status: itemStatus === "observed-terminal" ? "succeeded" : "running", runtimeOwners: [{ ...item, status: itemStatus }] }] : [], actions: [], pools: [{ id: owner.id, status: "running", owner, items: [{ logicalId: "r", work: { id: "r", revision: 1, attemptId: "r:1" }, ...(keys ? { key: owner.id + "#1" } : {}) }] }] }) as unknown as RunRecord;
  const ctx = (jobs: Array<{ id: string; status: string }>) => ({ getAsyncJobSnapshot: () => ({ running: jobs.filter(job => job.status === "running"), recent: jobs.filter(job => job.status !== "running"), delivery: {} }) }) as unknown as ExtensionContext;
  const kinds = (snapshot: SchedulingSnapshot) => ({ active: snapshot.activeOwners.map(item => item.status), completed: snapshot.knownCompletedOwners.map(item => item.status), unknown: snapshot.unknownOwners.map(item => item.status) });
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([]), state(false), 2)), { active: ["observed-running"], completed: [], unknown: [] }, "OMP registers the pool job only on the first push; a created pool is live in the kernel");
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([]), state(true), 2)), { active: [], completed: [], unknown: ["unknown"] }, "A pushed pool whose job row is gone while an item lacks a terminal receipt needs reconciliation");
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([]), state(true, "observed-running"), 2)).unknown, ["unknown", "unknown"], "Item and pool are both unresolved without rows or receipts");
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([]), state(true, "observed-terminal"), 2)), { active: [], completed: ["observed-terminal", "observed-terminal"], unknown: [] }, "Every pushed item settled by a real receipt means the pool drained; its expired job row is not a loss");
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([{ id: owner.id, status: "running" }]), state(true), 2)), { active: ["observed-running"], completed: [], unknown: [] });
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([{ id: owner.id, status: "completed" }]), state(true), 2)), { active: [], completed: ["observed-terminal"], unknown: [] }, "Only a terminal job row settles the pool owner");
  assert.equal(readRuntimeSnapshot(ctx([]), state(false), 0).ompCeiling, null);
  const terminalPool = state(true, "observed-terminal");
  terminalPool.pools[0]!.owner = { ...owner, status: "observed-terminal" };
  assert.deepEqual(kinds(readRuntimeSnapshot(ctx([]), terminalPool, 2)), { active: [], completed: ["observed-terminal", "observed-terminal"], unknown: [] }, "A canonical terminal pool owner must remain available to settle logical cancellation after its job row expires");
});

test("doctor distinguishes version and runtime capabilities without model transport", async () => {
  const supported = await doctor({ observedVersion: "18.1.10", runtime: { settings: true, extensionAgents: true, toolHooks: true, eval: true, task: true, planMode: false, session: true } });
  assertSchema(CapabilityReportSchema, supported); assert.equal(supported.supported, true);
  for (const observedVersion of ["18.1.9", "18.2.0", "19.0.0", "18.1.10-private", "unknown"]) assert.equal((await doctor({ observedVersion })).supported, false);
  assert.equal((await doctor({ observedVersion: "18.1.10", runtime: { settings: true, extensionAgents: true, toolHooks: true, eval: true, task: true, planMode: true, session: true } })).supported, false);
});

test("real product extension gates startup and native eval through isolated offline OMP sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "supership-product-")), home = join(root, "home"), cwd = join(root, "repo");
  shareNativeCache(home);
  mkdirSync(join(home, ".omp", "agent"), { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "extensions: []\n");
  writeFileSync(join(cwd, ".gitignore"), ".planning/\n");
  const env = { PATH: `${process.env.HOME}/.local/bin:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), PI_CODING_AGENT_DIR: join(home, ".omp", "agent"), TMPDIR: root, LC_ALL: "C", TERM: "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true", PRODUCT_ROOT: root, PRODUCT_CWD: cwd, PRODUCT_EXTENSION: resolve("src/extension.ts") };
  const run = (args: string[]) => {
    const executed = spawnSync(args[0]!, args.slice(1), { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(root, "last-command.json"), JSON.stringify({ args, status: executed.status, stdout: executed.stdout, stderr: executed.stderr }));
    assert.ifError(executed.error); assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}\nEvidence: ${root}`); return executed.stdout;
  };
  const launcher = join(root, "deny-network");
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve("test/support/deny-network.c")]);
  run(["git", "init", "-q", "-b", "fixture"]);
  run(["git", "-c", "user.name=Offline Fixture", "-c", "user.email=offline@invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const output = run([launcher, process.execPath, resolve("test/fixtures/product/sdk.ts")]);
  const path = join(cwd, ".planning", "product-smoke", "state.json");
  assert.ok(existsSync(path), "The public host creates a real durable run.");
  const state = JSON.parse(readFileSync(path,"utf8"));
  assert.equal(state.invocation.mode,"autonomous");
  assert.ok(state.seats.every((seat:{resolvedModel:string})=>seat.resolvedModel==="openai-codex/product-a"));
  assert.equal(existsSync(join(cwd,".planning","second-run")),false);
  const events=readFileSync(join(root,"events.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.ok(events.some(event=>event.event==="tool_call" && event.name==="supership_next"));
  assert.ok(events.some(event=>event.event==="provider" && event.user.includes("PRODUCT_CELL") && typeof event.lastToolResult==="string"), root);
  const issued = events.find(event => event.event === "tool_result" && event.toolCallId === "product-issued");
  assert.ok(issued && !issued.error && !issued.details?.cells?.some((cell: {status: string}) => cell.status === "error"), "The retrieved original control must execute successfully");
  assert.ok(state.actions.some((action: {claimToolCallId?: string; receiptIds: string[]}) => action.claimToolCallId === "product-issued" && action.receiptIds.length), "The actual runtime must record the issued control receipts");
  assert.equal(existsSync(join(root,"unauthorized.txt")),false,"Rejected raw eval must not execute its filesystem effect.");
  assert.ok(events.every(event=>event.event!=="provider" || event.model.startsWith("product-")));
  const report={product:"passed",proof:["public initialized print host","durable startup","one active run","run-local alias models","native Code Mode bridge","unknown eval rejected"],root};
  writeFileSync(join(root,"product-evidence.json"),JSON.stringify(report));
  console.log(JSON.stringify(report));
}, 240000);

test("the installed omp host serves its own in-process module for the extension's coding-agent import, so the version gate reads the running host", () => {
  const root = mkdtempSync(join(tmpdir(), "supership-version-alias-")), home = join(root, "home"), cwd = join(root, "repo"), ext = join(root, "ext");
  shareNativeCache(home);
  const decoy = join(ext, "node_modules", "@oh-my-pi", "pi-coding-agent");
  mkdirSync(join(home, ".omp", "agent"), { recursive: true }); mkdirSync(cwd); mkdirSync(decoy, { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "extensions: []\n");
  // A stale or foreign dependency copy beside the extension must never win over the executing host.
  writeFileSync(join(decoy, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0", main: "index.js", exports: { ".": "./index.js" } }));
  writeFileSync(join(decoy, "index.js"), 'export const VERSION = "0.0.0"; export const DECOY = true;\n');
  copyFileSync(resolve("test/fixtures/product/version-alias.ts"), join(ext, "version-alias.ts"));
  writeFileSync(join(root, "offline.yml"), `startup:\n  checkUpdate: false\nmemory:\n  backend: off\nextensions:\n  - ${JSON.stringify(join(ext, "version-alias.ts"))}\n`);
  const omp = Bun.which("omp"); assert.ok(omp, "The installed omp binary must be on PATH");
  const env = { PATH: `${dirname(omp)}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp", "agent"), TMPDIR: root, LC_ALL: "C", TERM: "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true", ALIAS_REPORT: join(root, "alias-report.json") };
  const run = (args: string[]) => { const executed = spawnSync(args[0]!, args.slice(1), { cwd, env, encoding: "utf8", timeout: 180000 }); assert.ifError(executed.error); assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}\nEvidence: ${root}`); return executed.stdout; };
  const launcher = join(root, "deny-network");
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve("test/support/deny-network.c")]);
  run(["git", "init", "-q", "-b", "fixture"]);
  run([launcher, omp, "--config", join(root, "offline.yml"), "--no-title", "--no-session", "--no-lsp", "--no-skills", "--no-rules", "--model", "openai-codex/alias-probe", "-p", "alias probe"]);
  const report = JSON.parse(readFileSync(join(root, "alias-report.json"), "utf8"));
  const hostVersion = spawnSync(omp, ["--version"], { env, encoding: "utf8" }).stdout.match(/\d+\.\d+\.\d+/)?.[0];
  assert.equal(report.decoy, false, `The host must not serve the extension's node_modules copy: ${root}`);
  assert.equal(report.VERSION, hostVersion, "The served VERSION is the executing host's version");
  assert.equal(report.hasMain, "function", "The served module is the full host surface, not a shim of the decoy");
  // Plain module resolution from the same directory does pick the decoy, so the equality above is the host's aliasing, not luck.
  assert.equal(spawnSync(process.execPath, ["-e", 'import {VERSION} from "@oh-my-pi/pi-coding-agent"; console.log(VERSION)'], { cwd: ext, encoding: "utf8" }).stdout.trim(), "0.0.0");
}, 120000);
