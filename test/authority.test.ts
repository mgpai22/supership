import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ActionRecord, RunRecord, WorkRef } from "../src/contracts.ts";
import { shareNativeCache } from "./support/native-cache.ts";

interface Call { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
interface Event {
  event: string; id?: string; name?: string; model?: string; tools?: string[]; error?: boolean; cellId?: string; issued?: string;
  calls?: Call[]; action?: ActionRecord; content?: Call[]; claimed?: string[]; work?: WorkRef;
  input?: Record<string, unknown>;
  results?: Array<{ id: string; name: string; error?: boolean; content: Array<{ type: string; text: string }> }>;
  details?: { kind?: string; cellId?: string; cells?: Array<{ status: string }>; isError?: boolean; xdev?: { tool?: string } };
}

const fixtureRoot = resolve(import.meta.dir, "fixtures", "authority");
const source = process.env.AUTHORITY_SOURCE_ROOT ?? resolve(import.meta.dir, "..");
/** One isolated offline host: fresh HOME, seccomp launcher, fixture repository; `phase` selects the scripted parent policy. */
function host(phase: "proof" | "crash-after-verify") {
  assert.ok(isAbsolute(source), "AUTHORITY_SOURCE_ROOT must select an explicit absolute source assembly");
  assert.ok(existsSync(join(source, "src", "extension.ts")), `Missing actual product extension: ${source}`);
  const root = mkdtempSync(join(tmpdir(), "supership-authority-")), home = join(root, "home"), cwd = join(root, "repo");
  shareNativeCache(home);
  mkdirSync(join(home, ".omp", "agent"), { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "extensions: []\n");
  writeFileSync(join(cwd, ".gitignore"), ".planning/\n.omp/\n");
  writeFileSync(join(cwd, "baseline.txt"), "baseline\n");
  const env = {
    PATH: `${dirname(Bun.which("omp") ?? "/usr/bin/omp")}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"), TMPDIR: root, LC_ALL: "C", TERM: "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true",
    AUTHORITY_ROOT: root, AUTHORITY_CWD: cwd, AUTHORITY_SOURCE_ROOT: source, AUTHORITY_PHASE: phase,
  };
  const run = (args: string[], options: { env?: Record<string, string>; signal?: NodeJS.Signals } = {}) => {
    const execution = spawnSync(args[0]!, args.slice(1), { cwd, env: { ...env, ...options.env }, encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(root, "last-command.json"), JSON.stringify({ args, status: execution.status, signal: execution.signal, stdout: execution.stdout, stderr: execution.stderr }));
    assert.ifError(execution.error);
    if (options.signal) assert.equal(execution.signal, options.signal, `${execution.stdout}\n${execution.stderr}\nEvidence: ${root}`);
    else assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}\nEvidence: ${root}`);
    return execution.stdout;
  };
  const launcher = join(root, "deny-network");
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve(import.meta.dir, "support", "deny-network.c")]);
  run(["git", "init", "-q", "-b", "fixture"]);
  run(["git", "add", ".gitignore", "baseline.txt"]);
  run(["git", "-c", "user.name=Offline Fixture", "-c", "user.email=offline@invalid", "commit", "-q", "-m", "fixture"]);
  return { root, cwd, run, launcher };
}

test("native non-CodeMode authority rejects prepared-message tool IDs and serializes concurrent next requests", () => {
  const { root, cwd, run, launcher } = host("proof");
  const version = JSON.parse(readFileSync(resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/package.json"), "utf8")).version;
  const sourceHashes = Object.fromEntries(["extension.ts", "omp.ts", "engine.ts", "contracts.ts"].map(file => [join(source, "src", file), createHash("sha256").update(readFileSync(join(source, "src", file))).digest("hex")]));
  run([launcher, process.execPath, join(fixtureRoot, "sdk.ts")]);
  assert.ok(existsSync(join(root, "boundary.json")), `The actual host did not reach the proof boundary: ${root}`);
  const state: RunRecord = JSON.parse(readFileSync(join(root, "boundary.json"), "utf8"));
  const events: Event[] = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const attacks = events.filter(event => event.event === "attack");
  const modelResults = new Map(events.filter(event => event.event === "model-result").map(event => [event.id!, event]));
  const direct = attacks.flatMap(event => event.calls!.filter(call => call.name !== "eval"));
  const report = { root, source, fixtureRoot, sourceHashes, version, attacks: attacks.map(event => event.action!.input.kind), directIds: direct.map(call => call.id) };
  writeFileSync(join(root, "authority-evidence.json"), JSON.stringify(report, null, 2));

  assert.equal(version, "18.2.3");
  const parentTools = events.find(event => event.event === "provider" && event.model === "authority-parent")!.tools!;
  for (const name of ["eval", "task", "hub", "bash", "write"]) assert.ok(parentTools.includes(name), `${name} must be directly exposed outside CodeMode`);
  // Outside Code Mode the host mounts extension tools as xd:// devices: the model reaches supership_next through write, never through a listed tool.
  assert.ok(!parentTools.includes("supership_next"), "The host mounts extension tools as devices; a listed supership_next would change the attack surface this proof covers");
  const deviceNext = events.filter(event => event.event === "tool-result" && event.name === "write" && event.details?.xdev?.tool === "supership_next");
  assert.ok(deviceNext.length && deviceNext.every(event => !event.error), `The xd://supership_next device route must work for the parent: ${root}`);
  assert.ok(direct.some(call => call.name === "write" && call.arguments.path === "xd://supership_runtime"), "The model must attempt a forged receipt through the device transport");
  assert.ok(events.filter(event => event.event === "provider").every(event => event.model === "authority-parent" || event.model === "authority-worker"), "Every real child must use only the offline transport");

  const concurrent = ["concurrent-next-a", "concurrent-next-b"].map(id => events.find(event => event.event === "tool-result" && event.id === id));
  for (const result of concurrent) assert.ok(result?.details?.cellId, `Each concurrent request must return its issued manifest: ${root}`);
  assert.equal(new Set(concurrent.map(event => event!.details!.cellId)).size, 1, `Concurrent next calls issued duplicate work: ${root}`);
  const firstActionId = events.find(event => event.event === "decision" && event.cellId === concurrent[0]!.details!.cellId && event.issued)?.issued;
  const firstAction = state.actions.find(action => action.id === firstActionId)!;
  assert.ok(firstAction, "The concurrently issued manifest must reconstruct the actual first action");
  assert.equal(firstAction.input.kind, "run_finite");
  assert.equal(state.actions.filter(action => action.input.kind === "run_finite" && action.recipients.some(recipient => firstAction.recipients.some(first => first.attemptId === recipient.attemptId))).length, 1);
  for (const recipient of firstAction.recipients) assert.equal(events.filter(event => event.event === "worker-output" && event.work?.attemptId === recipient.attemptId).length, 1, "One issued logical work item must execute once");

  assert.equal(modelResults.get("omitted-timeout")?.error, true, "A default-timeout control call must fail without consuming the issued action");
  assert.deepEqual(attacks.map(event => event.action!.input.kind).sort(), ["run_finite", "verify", "wait"], `The proof must reach task, wait and verification gates: ${root}`);
  assert.ok(direct.some(call => call.name === "bash" && /^js-bash-[0-9a-f-]{36}$/.test(call.id)), "The model must spoof a native bridge-shaped bash ID");
  for (const attack of attacks) {
    const exact = attack.calls!.find(call => call.name === "eval")!;
    assert.ok(events.some(event => event.event === "assistant-message" && attack.calls!.every(call => event.content?.some(block => block.type === "toolCall" && block.id === call.id))), "The issued eval and unauthorized direct calls must share one actual assistant message");
    const preparedIndex = events.findIndex(event => event.event === "tool-call" && event.id === exact.id && event.claimed?.includes(attack.action!.id));
    const executeIndex = events.findIndex(event => event.event === "execution-start" && event.id === exact.id);
    assert.ok(preparedIndex >= 0 && executeIndex > preparedIndex, "The real host must claim eval during preparation, before native execution");
    const result = events.find(event => event.event === "tool-result" && event.id === exact.id);
    assert.ok(result && !result.error && !result.details?.isError && !result.details?.cells?.some(cell => cell.status === "error"), `The exact issued cell must remain executable: ${root}`);
  }
  for (const call of direct) assert.equal(modelResults.get(call.id)?.error, true, `Unauthorized direct ${call.name} (${call.id}) did not fail: ${root}`);
  assert.equal(existsSync(join(root, "unauthorized-effects.txt")), false, "No rejected direct shell effect may run");
  assert.equal(readFileSync(join(root, "verification-effects.txt"), "utf8"), "executed\n", "The authorized verification command must execute once, without a spoofed duplicate");
  const childAttacks = events.filter(event => event.event === "child-attack");
  assert.ok(childAttacks.length, "A non-isolated research child must attempt native write and bash");
  // Blocked child calls short-circuit later extension hooks, so the proof reads the results the child model itself received.
  const childResults = events.filter(event => event.event === "child-results").flatMap(event => event.results!);
  for (const call of childAttacks.flatMap(event => event.calls!)) {
    const result = childResults.find(result => result.id === call.id);
    assert.ok(result?.error && result.content.some(block => /Supership child guard denies/.test(block.text)), `The rebound product factory must deny the child's native ${call.name} (${call.id}): ${root}`);
  }
  assert.equal(existsSync(join(cwd, "child-unauthorized.txt")), false, "A non-isolated child must not write the parent checkout natively");
  assert.equal(existsSync(join(root, "child-unauthorized-effects.txt")), false, "A non-isolated child must not run a native shell effect");
  assert.equal(readFileSync(join(cwd, "baseline.txt"), "utf8"), "baseline\n");
  assert.equal(state.verification.length, 1, "A forged runtime receipt must not create another verification record");
  assert.equal(state.verification[0]!.outcome, "passed");
  assert.ok(!new Set(direct.map(call => call.id)).has(state.verification[0]!.verifier.id), "Only a real bridged receipt may attest verification");
  assert.equal(state.recovery, undefined, `Rejected direct calls must not damage the authorized run: ${root}`);
  const workExecutions = events.filter(event => event.event === "worker-output");
  assert.equal(new Set(workExecutions.map(event => event.work!.attemptId)).size, workExecutions.length, "Unauthorized direct task calls must not spawn duplicate native children");
  console.log(JSON.stringify({ ...report, result: "passed" }));
}, 300000);

test("resume invalidates a stale native verification artifact before any action and re-runs the check under the true OMP ceiling", () => {
  const { root, cwd, run, launcher } = host("crash-after-verify");
  run([launcher, process.execPath, join(fixtureRoot, "sdk.ts")], { signal: "SIGKILL" });
  assert.ok(existsSync(join(root, "boundary.json")), `The host did not reach a settled verification before its crash: ${root}`);
  const before: RunRecord = JSON.parse(readFileSync(join(root, "boundary.json"), "utf8"));
  const checked = before.verification.find(record => record.outcome === "passed");
  assert.ok(checked, `No passed native verification before the crash: ${root}`);
  const runPath = join(cwd, ".planning", "authority-proof");
  const persisted: RunRecord = JSON.parse(readFileSync(join(runPath, "state.json"), "utf8"));
  assert.equal(persisted.lifecycle, "active", "SIGKILL must leave an active run on disk, without graceful cancellation");
  const reference = checked.evidence.find(ref => ref.kind === "file" && ref.availability === "available");
  assert.ok(reference, "A passed verification must retain an available run-local artifact");
  assert.equal(createHash("sha256").update(readFileSync(join(runPath, reference.uri))).digest("hex"), reference.digest, "The recorded digest must be the sha256 of the artifact bytes");
  assert.equal(readFileSync(join(root, "verification-effects.txt"), "utf8"), "executed\n");
  const replaced = "external fixture change\n";
  writeFileSync(join(runPath, reference.uri), replaced);

  run([launcher, process.execPath, join(fixtureRoot, "sdk.ts")], { env: { AUTHORITY_PHASE: "resume" } });
  assert.ok(existsSync(join(root, "boundary-resume.json")), `The resumed host did not reach its boundary: ${root}`);
  const after: RunRecord = JSON.parse(readFileSync(join(root, "boundary-resume.json"), "utf8"));
  const old = after.verification.find(record => record.id === checked.id);
  assert.ok(old); assert.equal(old.outcome, "unavailable");
  assert.ok(old.evidence.some(ref => ref.id === reference.id && ref.availability === "unavailable"), "The changed artifact must stop counting as available");
  const fresh = after.verification.filter(record => record.id !== checked.id);
  assert.equal(fresh.length, 1, `Exactly one new runtime verification must replace the stale proof: ${root}`);
  assert.equal(fresh[0]!.outcome, "passed"); assert.equal(fresh[0]!.verifier.kind, "runtime"); assert.equal(fresh[0]!.checkId, checked.checkId);
  assert.ok(fresh[0]!.evidence.length && fresh[0]!.evidence.every(ref => ref.availability === "available"));
  assert.deepEqual(fresh[0]!.codeIdentity, after.code!.identity);
  assert.equal(readFileSync(join(root, "verification-effects.txt"), "utf8"), "executed\nexecuted\n", "The check must actually run again, exactly once");
  assert.equal(readFileSync(join(runPath, reference.uri), "utf8"), replaced, "External bytes survive the resume untouched");

  const log: Array<{ facts: Array<Record<string, unknown> & { kind: string }> }> = readFileSync(join(runPath, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const resumed = log.findIndex(event => event.facts.some(fact => fact.kind === "owner-claimed"));
  assert.ok(resumed >= 0, "The fresh host must claim ownership");
  const invalidated = log.findIndex((event, index) => index > resumed && event.facts.some(fact => fact.kind === "verification-invalidated" && (fact.ids as string[]).includes(checked.id) && Array.isArray(fact.evidence) && fact.evidence.length > 0));
  const firstAction = log.findIndex((event, index) => index > resumed && event.facts.some(fact => fact.kind === "action-issued"));
  assert.ok(invalidated > resumed, "The stale record must be invalidated canonically in the run log");
  assert.ok(firstAction > invalidated, "Invalidation must precede the first action after resume");
  const audit = log[invalidated]!.facts.find(fact => fact.kind === "verification-invalidated")!.evidence as Array<{ uri: string }>;
  const items: Array<{ verificationId: string; evidenceId: string; observed: string }> = JSON.parse(readFileSync(join(runPath, audit[0]!.uri), "utf8"));
  assert.ok(items.some(item => item.verificationId === checked.id && item.evidenceId === reference.id && item.observed === createHash("sha256").update(replaced).digest("hex")), "The audit must record the observed bytes hash");
  assert.equal(after.actions.filter(action => action.input.kind === "verify").length, 2);
  assert.equal(after.limits.concurrency, 1, "The resume command lowered the run cap");
  assert.equal(after.runtime?.ompCeiling, 2, "The snapshot must report the true OMP ceiling beneath the run cap override");
  console.log(JSON.stringify({ root, stale: reference.uri, result: "passed" }));
}, 400000);
