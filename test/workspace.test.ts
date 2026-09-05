import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readlinkSync, symlinkSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { shareNativeCache } from "./support/native-cache.ts";
import { captureBaseline } from "../src/git.ts";
import { captureWorkspace, prepareWorkspace, revokeWorkspace, routeWorkspaceOperation } from "../src/workspace.ts";
import type { PrepareWorkspace } from "../src/workspace.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
async function fixture(): Promise<PrepareWorkspace> {
  const root = mkdtempSync(join(tmpdir(), "supership-workspace-"));
  const repositoryRoot = join(root, "repo"); const runPath = join(root, "run");
  mkdirSync(repositoryRoot); mkdirSync(runPath);
  git(repositoryRoot, "init", "-q", "-b", "fixture");
  writeFileSync(join(repositoryRoot, "tracked.txt"), "base\n");
  writeFileSync(join(repositoryRoot, "deleted.txt"), "base deletion\n");
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "-c", "user.name=Offline Fixture", "-c", "user.email=offline@invalid", "commit", "-qm", "fixture");
  writeFileSync(join(repositoryRoot, "tracked.txt"), "staged user\n"); git(repositoryRoot, "add", "tracked.txt");
  writeFileSync(join(repositoryRoot, "tracked.txt"), "unstaged user\n");
  writeFileSync(join(repositoryRoot, "binary.bin"), Buffer.from([0, 255, 128, 10]));
  symlinkSync("tracked.txt", join(repositoryRoot, "link.txt"));
  const baseline = await captureBaseline(repositoryRoot);
  return { runPath, repositoryRoot, runId: "run", parentSessionId: "parent", ownerEpoch: 0, actionId: "action", grantedToolNames: [], work: { id: "work", revision: 1, attemptId: "attempt-1" }, assignment: { id: "work", revision: 1, kind: "build", dependencies: [], seatId: "builder", expectedPaths: ["tracked.txt", "deleted.txt", "binary.bin", "link.txt", "new.txt", "command.txt", "renamed.txt"], expectedOutputs: [], verificationCheckIds: [], mutation: "repository", isolation: { kind: "worktree", base: baseline.identity }, toolGrants: [], outputSchema: { name: "build", version: 1 }, instructions: "Fixture mutation", evidence: [] } };
}

test("workspace retains full staged and unstaged raw baseline and attributes only its own changes", async () => {
  const request = await fixture(); const source = await captureBaseline(request.repositoryRoot);
  const binding = await prepareWorkspace(request);
  assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.work));
  const initial = await captureWorkspace(binding);
  assert.deepEqual(initial.before.index, source.index); assert.deepEqual(initial.before.worktree, source.worktree);
  assert.deepEqual(readFileSync(join(binding.path, "binary.bin")), Buffer.from([0, 255, 128, 10]));
  assert.equal(readlinkSync(join(binding.path, "link.txt")), "tracked.txt");
  assert.equal(git(binding.path, "show", ":tracked.txt"), "staged user\n");
  const routed = routeWorkspaceOperation(binding, "write", { i: "Writing work output", path: "new.txt", content: "work output\n" });
  writeFileSync(routed.input.path as string, routed.input.content as string);
  revokeWorkspace(binding);
  assert.throws(() => routeWorkspaceOperation(binding, "write", { path: "new.txt", content: "lost" }), /stale|revoked/);
  const result = await captureWorkspace(binding);
  assert.deepEqual(result.patch.changes.map(change => change.path), ["new.txt"]);
  assert.equal(result.patch.source.workId, "work");
  assert.deepEqual((await captureBaseline(request.repositoryRoot)).identity, source.identity);
  assert.equal(readFileSync(join(binding.path, "new.txt"), "utf8"), "work output\n");
  assert.equal(git(binding.path, "fsck", "--full").includes("error"), false);
});

test("active checkout callbacks preserve staged user content and attribute parent effects without a second checkout", async () => {
  const request = await fixture();
  const binding = await prepareWorkspace({ ...request, assignment: { ...request.assignment, isolation: { kind: "active-checkout" } } });
  const routed = routeWorkspaceOperation(binding, "write", { path: "new.txt", content: "parent output\n" });
  writeFileSync(routed.input.path as string, routed.input.content as string);
  const capture = await captureWorkspace(binding);
  assert.equal(binding.path, request.repositoryRoot);
  assert.equal(capture.patch.source.kind, "parent-callback");
  assert.deepEqual(capture.patch.changes.map(change => change.path), ["new.txt"]);
  assert.equal(git(request.repositoryRoot, "show", ":tracked.txt"), "staged user\n");
  assert.equal(readFileSync(join(request.repositoryRoot, "new.txt"), "utf8"), "parent output\n");
  revokeWorkspace(binding); revokeWorkspace(binding);
  assert.equal(readFileSync(join(request.repositoryRoot, "new.txt"), "utf8"), "parent output\n");
});

test("read-only dynamic grants cannot route mutations or expand their native allowlist", async () => {
  const request = await fixture();
  const scoped = { ...request, grantedToolNames: ["supership_fixture_read"], assignment: { ...request.assignment, mutation: "read-only" as const, toolGrants: [{ name: "reader", version: 1, approvalId: "approval" }] } };
  const binding = await prepareWorkspace(scoped);
  assert.equal(binding.path, request.repositoryRoot);
  assert.throws(() => routeWorkspaceOperation(binding, "write", { path: "new.txt", content: "forbidden" }), /Read-only/);
  assert.throws(() => routeWorkspaceOperation(binding, "bash", { command: "printf forbidden > new.txt" }), /Read-only/);
  await assert.rejects(prepareWorkspace({ ...scoped, grantedToolNames: ["write"] }));
  await assert.rejects(prepareWorkspace({ ...scoped, grantedToolNames: [] }), /exact grants/);
  assert.equal(existsSync(join(request.repositoryRoot, "new.txt")), false);
});

test("workspace rejects traversal, symlink aliases, malformed schema, stale receipts, and cross-work claims before effects", async () => {
  const request = await fixture(); const a = await prepareWorkspace(request);
  const b = await prepareWorkspace({ ...request, work: { ...request.work, id: "second" }, assignment: { ...request.assignment, id: "second" } });
  const denied = ["../outside.txt", join(b.path, "new.txt"), ".git/config", "xd://report_issue", "link.txt", "missing/../../outside.txt"];
  for (const path of denied) assert.throws(() => routeWorkspaceOperation(a, "write", { path, content: "forbidden" }));
  assert.throws(() => routeWorkspaceOperation(a, "write", { path: "new.txt", content: "forbidden", workId: "second" }));
  assert.throws(() => routeWorkspaceOperation({ ...a, work: b.work }, "write", { path: "new.txt", content: "forbidden" }));
  assert.throws(() => routeWorkspaceOperation(a, "bash", { command: "pwd", cwd: b.path }));
  assert.throws(() => routeWorkspaceOperation(a, "bash", { command: "sleep 10", async: true }));
  assert.throws(() => routeWorkspaceOperation(a, "edit", { input: `[tracked.txt#ABCD]\nPUT 1.=1:\n+new\nMV ../outside.txt` }));
  assert.throws(() => routeWorkspaceOperation(a, "edit", { input: `[tracked.txt#ABCD]\nPUT 1.=1:\n+new\n  MV ../outside.txt` }));
  const edit = routeWorkspaceOperation(a, "edit", { i: "Editing work output", input: `[tracked.txt#ABCD]\nPUT 1.=1:\n+new\nMV renamed.txt` });
  assert.equal(edit.input.input, `[${a.path}/tracked.txt#ABCD]\nPUT 1.=1:\n+new\nMV ${JSON.stringify(join(a.path, "renamed.txt"))}`);
  await prepareWorkspace({ ...request, work: { ...request.work, attemptId: "attempt-2" } });
  revokeWorkspace(a); // An obsolete attempt must not revoke its replacement.
  assert.throws(() => routeWorkspaceOperation(a, "write", { path: "new.txt", content: "forbidden" }), /stale|revoked/);
  assert.equal(existsSync(join(a.path, "new.txt")), false); assert.equal(existsSync(join(b.path, "new.txt")), false);
  assert.equal(readFileSync(join(a.path, "tracked.txt"), "utf8"), "unstaged user\n");
  writeFileSync(b.manifestPath, "{}");
  assert.throws(() => routeWorkspaceOperation(b, "write", { path: "new.txt", content: "forbidden" }), /manifest changed/);
  assert.equal(existsSync(join(b.path, "new.txt")), false);
  const c = await prepareWorkspace({ ...request, work: { ...request.work, id: "third" }, assignment: { ...request.assignment, id: "third" } });
  writeFileSync(join(dirname(c.manifestPath), "baseline.json"), "{}");
  assert.throws(() => routeWorkspaceOperation(c, "write", { path: "new.txt", content: "forbidden" }), /baseline digest/);
  assert.equal(existsSync(join(c.path, "new.txt")), false);
});

test("persistence preparation fails before returning a worker grant when setup cannot preserve the assignment", async () => {
  const request = await fixture();
  writeFileSync(join(request.runPath, "worktrees"), "occupied");
  await assert.rejects(prepareWorkspace(request));
  assert.equal(readFileSync(join(request.repositoryRoot, "tracked.txt"), "utf8"), "unstaged user\n");
  const moved = await fixture(); writeFileSync(join(moved.repositoryRoot, "tracked.txt"), "changed after assignment\n");
  await assert.rejects(prepareWorkspace(moved), /source changed/);
  assert.equal(existsSync(join(moved.runPath, "worktrees")), false);
  const linked = await fixture(); const outside = join(dirname(linked.runPath), "outside"); mkdirSync(outside);
  symlinkSync(outside, join(linked.runPath, "worktrees"));
  await assert.rejects(prepareWorkspace(linked), /symlink/);
  assert.equal(git(linked.repositoryRoot, "worktree", "list", "--porcelain").split("worktree ").length, 2);
});

test("real isolated OMP child uses native parent callbacks, denies native and second-work writes, and retains code after cancellation", async () => {
  const request = await fixture(); const root = dirname(request.repositoryRoot);
  const home = join(root, "home"); mkdirSync(join(home, ".omp/agent"), { recursive: true });
  shareNativeCache(home);
  writeFileSync(join(root, "request.json"), JSON.stringify(request));
  const protectedPaths = [join(process.env.HOME!, ".omp/agent/config.yml"), resolve(".omp/config.yml")];
  const checksums = () => protectedPaths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
  const protectedBefore = checksums(); const launcher = join(root, "deny-network");
  const env = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp/agent"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), TMPDIR: root, LC_ALL: "C", TERM: "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true", WORKSPACE_PROOF_ROOT: root };
  const run = (args: string[]) => {
    const result = spawnSync(args[0]!, args.slice(1), { cwd: request.repositoryRoot, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(root, "last-command.json"), JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nEvidence: ${root}`); return result.stdout;
  };
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve("test/support/deny-network.c")]);
  const installed = Bun.which("omp"); assert.ok(installed);

  run([launcher, process.execPath, resolve("test/fixtures/workspace/sdk.ts")]);
  const evidence = JSON.parse(readFileSync(join(root, "evidence.json"), "utf8"));
  assert.equal(evidence.nativeScratchGone, true); assert.equal(evidence.status, "cancelled");
  assert.equal(evidence.nativeWriteDenied, true); assert.equal(evidence.crossWorkDenied, true);
  assert.deepEqual(checksums(), protectedBefore);
  assert.ok(lstatSync(evidence.path).isDirectory());
}, 180_000);
