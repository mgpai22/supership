import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, digestJson, type EngineInput, type TrustedConfirmation } from "../src/contracts.ts";
import { cleanupRun, closeWriter, createRun, exportRun, openWriter, planCleanup, readRun, StoreError, transact, type CleanupPlan, type RunWriter, type StorageRepairPlan, planStorageRepair, repairRunStorage } from "../src/store.ts";
import { assignment, hash, startInput } from "./core-fixtures.ts";

const roots: string[] = [];
const writers: RunWriter[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  for (const writer of writers.splice(0)) await closeWriter(writer);
  for (const root of roots.splice(0)) { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "supership-store-")); roots.push(root);
  const process = Bun.spawn(["git", "init", "--quiet", root], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
  await writeFile(join(root, ".gitignore"), ".planning/\n");
  return root;
}
async function run(slug = "test-run") {
  const root = await repository(), path = join(root, ".planning", slug);
  const writer = await openWriter(path, { sessionId: "session", purpose: "start" }); writers.push(writer);
  const input = startInput(root, slug, writer.leaseId);
  const result = await createRun(writer, input, input.start.preflight);
  if (result.kind !== "committed") throw new Error(JSON.stringify(result));
  const context = (id: string) => ({ now: Date.now(), inputId: id, ownerSessionId: "session", ownerEpoch: 0 });
  return { root, path, writer, state: result.state, context };
}
// These deadlines bound real child-process/OS-lock settlement, which fake timers cannot drive.
async function ready(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const reader = child.stdout.getReader();
  const value = await Promise.race([reader.read(), Bun.sleep(10000).then(() => { throw new Error("Child did not reach crash checkpoint"); })]);
  reader.releaseLock();
  if (value.done) throw new Error(`Child exited before checkpoint: ${await new Response(child.stderr).text()}`);
  return new TextDecoder().decode(value.value).trim();
}
const fixture = join(import.meta.dir, "fixtures/store-child.ts");

test("real flock excludes another process; graceful release preserves the lock inode", async () => {
  const { root, path, writer, state } = await run();
  const inode = (await lstat(join(path, ".writer.lock"))).ino;
  const contender = Bun.spawn([process.execPath, fixture, "contend", root, "test-run"], { stdout: "pipe", stderr: "pipe" });
  expect(await contender.exited).toBe(0);
  await closeWriter(writer);
  const next = await openWriter(path, { sessionId: "session", expectedEpoch: state.owner.epoch, purpose: "resume" }); writers.push(next);
  expect((await lstat(join(path, ".writer.lock"))).ino).toBe(inode);
  await expect(transact(next, { kind: "record-source-usage", sources: [] }, { now: Date.now(), inputId: "no-transfer", ownerSessionId: "session", ownerEpoch: 0 })).rejects.toMatchObject({ code: "resume-required" });
  const resumed = await transact(next, { kind: "resume", sessionId: "session", leaseId: next.leaseId, reconciliation: { confirmed: [], unresolved: [], candidateResults: [], requiredChoices: [] } }, { now: Date.now(), inputId: "transfer", ownerSessionId: "session", ownerEpoch: 0 });
  expect(resumed.kind === "committed" && resumed.state.owner.epoch).toBe(1);
});

test("parent SIGKILL releases flock without deleting its persistent file", async () => {
  const root = await repository();
  const child = Bun.spawn([process.execPath, fixture, "hold", root, "crash-owner"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); children.push(child);
  expect(await ready(child)).toBe("lease-held");
  const path = join(root, ".planning", "crash-owner");
  child.kill("SIGKILL"); await child.exited;
  let writer: RunWriter | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { writer = await openWriter(path, { sessionId: "replacement", purpose: "resume" }); break; }
    catch (error) { if (!(error instanceof StoreError) || error.code !== "writer-busy") throw error; await Bun.sleep(10); }
  }
  expect(writer).toBeDefined(); writers.push(writer!);
  expect((await readRun(path)).state.owner.epoch).toBe(0);
});

test("a flushed transition survives a process crash before its snapshot and replays once", async () => {
  const root = await repository(), path = join(root, ".planning", "crash-flush");
  const child = Bun.spawn([process.execPath, fixture, "crash-after-flush", root, "crash-flush"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" }); children.push(child);
  expect(await ready(child)).toBe("committed-without-snapshot");
  child.kill("SIGKILL"); await child.exited; await chmod(path, 0o700);
  const recovered = await readRun(path);
  expect(recovered.state.usage.tokens).toBe(17);
  expect(recovered.state.eventSequence).toBe(2);
  expect(recovered.diagnostics.some(diagnostic => diagnostic.code === "snapshot-replayed")).toBe(true);
  expect(canonicalJson((await readRun(path)).state)).toBe(canonicalJson(recovered.state));
  expect((await readFile(join(path, "events.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
});

test("snapshot failure poisons the current writer and does not permit subsequent effects", async () => {
  const { path, writer, state, context } = await run();
  await chmod(path, 0o500);
  try {
    await expect(transact(writer, { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 8, costAmount: null, model: "fixture/model", observedAt: 0 }] }, context("snapshot-error"))).rejects.toMatchObject({ code: "persistence-uncertain", committed: true });
    await expect(transact(writer, { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 9, costAmount: null, model: "fixture/model", observedAt: 0 }] }, context("after-error"))).rejects.toMatchObject({ code: "writer-unavailable" });
  } finally { await chmod(path, 0o700); }
  expect((await readRun(path)).state.usage.tokens).toBe(8);
});

test("duplicate input is a byte-preserving no-op, changed duplicate rejects, and queued inputs are captured", async () => {
  const { path, writer, state, context } = await run();
  const input: EngineInput = { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 4, costAmount: null, model: "fixture/model", observedAt: 0 }] }, ctx = context("once");
  await transact(writer, input, ctx);
  const before = await readFile(join(path, "events.jsonl"));
  expect((await transact(writer, input, ctx)).kind).toBe("duplicate");
  expect((await transact(writer, { ...input, sources: [{ ...input.sources[0], tokens: 5 }] }, ctx)).kind).toBe("rejected");
  expect(await readFile(join(path, "events.jsonl"))).toEqual(before);
  const queued: EngineInput = { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 6, costAmount: null, model: "fixture/model", observedAt: 0 }] };
  const pending = transact(writer, queued, context("captured")); queued.sources[0].tokens = 999;
  await pending;
  expect((await readRun(path)).state.usage.tokens).toBe(6);
});

test("an incomplete final record is preserved byte-for-byte and cannot receive an append", async () => {
  const { path, writer, state, context } = await run();
  const log = join(path, "events.jsonl"); await appendFile(log, '{"schemaVersion":1,"runId":"cut');
  const before = await readFile(log);
  const loaded = await readRun(path);
  expect(loaded.writable).toBe(false);
  expect(loaded.state.eventSequence).toBe(1);
  await expect(transact(writer, { kind: "record-source-usage", sources: [] }, context("tail"))).rejects.toMatchObject({ code: "writer-data-changed" });
  expect(await readFile(log)).toEqual(before);
  await closeWriter(writer);
  await expect(openWriter(path, { sessionId: "session", purpose: "resume" })).rejects.toMatchObject({ code: "read-only-recovery" });
});

test("middle corruption, unknown versions, sequence gaps and fabricated snapshots reject before writes", async () => {
  const { path, writer, state, context } = await run();
  await transact(writer, { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 2, costAmount: null, model: "fixture/model", observedAt: 0 }] }, context("second"));
  const log = join(path, "events.jsonl"), original = await readFile(log, "utf8"), snapshot = await readFile(join(path, "state.json"), "utf8");
  const lines = original.trimEnd().split("\n");
  for (const bad of ["not-json\n" + lines[1] + "\n", JSON.stringify({ ...JSON.parse(lines[0]), schemaVersion: 2 }) + "\n" + lines[1] + "\n", lines[0] + "\n" + JSON.stringify({ ...JSON.parse(lines[1]), sequence: 9 }) + "\n"]) {
    await writeFile(log, bad);
    await expect(readRun(path)).rejects.toMatchObject({ code: "corrupt-log" });
    await expect(transact(writer, { kind: "record-source-usage", sources: [] }, context("blocked"))).rejects.toBeInstanceOf(StoreError);
    expect(await readFile(log, "utf8")).toBe(bad);
  }
  await writeFile(log, original);
  await writeFile(join(path, "state.json"), JSON.stringify({ ...JSON.parse(snapshot), eventSequence: 99 }));
  await expect(readRun(path)).rejects.toMatchObject({ code: "snapshot-ahead" });
  await writeFile(join(path, "state.json"), JSON.stringify({ ...JSON.parse(snapshot), usage: { ...JSON.parse(snapshot).usage, tokens: 999 } }));
  await expect(readRun(path)).rejects.toMatchObject({ code: "snapshot-diverged", path: join(path, "state.json") });
});

test("unknown input contracts cause no filesystem changes", async () => {
  const { path, writer, context } = await run();
  const before = await readFile(join(path, "events.jsonl"));
  await expect(transact(writer, { kind: "record-kernel-generation", generation: 1, schemaVersion: 2, reason: "lost", evidence: [] } as unknown as EngineInput, context("unknown"))).rejects.toThrow("Invalid engine input");
  expect(await readFile(join(path, "events.jsonl"))).toEqual(before);
});

test("legacy dashboards, reserved handoff slugs, symlink paths and nonignored repositories remain untouched", async () => {
  const root = await repository(), legacy = join(root, ".planning", "legacy");
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, "plan.html"), "legacy user dashboard");
  await expect(readRun(legacy)).rejects.toMatchObject({ code: "legacy-run" });
  await expect(openWriter(legacy, { sessionId: "session", purpose: "start" })).rejects.toMatchObject({ code: "existing-run-path" });
  await expect(openWriter(join(root, ".planning", "supership-upgrade"), { sessionId: "session", purpose: "start" })).rejects.toMatchObject({ code: "reserved-slug" });
  await symlink(legacy, join(root, ".planning", "linked"));
  await expect(readRun(join(root, ".planning", "linked"))).rejects.toMatchObject({ code: "symlink-path" });
  expect(await readFile(join(legacy, "plan.html"), "utf8")).toBe("legacy user dashboard");
  await writeFile(join(root, ".gitignore"), "");
  await expect(openWriter(join(root, ".planning", "not-ignored"), { sessionId: "session", purpose: "start" })).rejects.toMatchObject({ code: "git-preflight" });
  expect(await readdir(join(root, ".planning"))).not.toContain("not-ignored");
});

function confirmation(plan: CleanupPlan): TrustedConfirmation {
  return { reviewedPlanHash: plan.digest, approval: { id: "cleanup-approval", kind: "cleanup", decision: "approve", authority: "cli-terminal", scopeHash: plan.digest, planRevision: 0, toolVersions: [], ownerEpoch: plan.ownerEpoch, createdAt: Date.now(), rationale: "Reviewed exact fixture paths", evidence: [] } };
}
test("cleanup requires settled state, exact bytes and trusted confirmation; symlinks never delete their targets", async () => {
  const { root, path, writer, context } = await run();
  await expect(planCleanup(path)).rejects.toMatchObject({ code: "unsafe-cleanup" });
  await transact(writer, { kind: "request-cancel", reason: "fixture complete", evidence: [] }, context("cancel"));
  await closeWriter(writer);
  await writeFile(join(root, "protected-user-file"), "preserve"); await symlink(join(root, "protected-user-file"), join(path, "artifact-link"));
  const reviewed = await planCleanup(path);
  const denied = confirmation(reviewed); denied.approval.authority = "autonomous-policy";
  await expect(cleanupRun(reviewed, denied)).rejects.toMatchObject({ code: "confirmation-mismatch" });
  await writeFile(join(path, "new-evidence"), "later bytes");
  await expect(cleanupRun(reviewed, confirmation(reviewed))).rejects.toMatchObject({ code: "cleanup-changed" });
  const current = await planCleanup(path);
  const removed = await cleanupRun(current, confirmation(current));
  expect(removed.removedPaths).toContain(path);
  expect(await readFile(join(root, "protected-user-file"), "utf8")).toBe("preserve");
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("export reads committed state and never touches a generated legacy dashboard", async () => {
  const { path, writer, context } = await run();
  await transact(writer, { kind: "request-cancel", reason: "fixture finished", evidence: [] }, context("cancel"));
  await writeFile(join(path, "plan.html"), "presentation is independent");
  const markdown = await exportRun(path);
  expect(markdown).toContain("run-test-run");
  expect(markdown).toContain("cancelled");
  expect(await readFile(join(path, "plan.html"), "utf8")).toBe("presentation is independent");
});

test("cleanup rechecks registered worktree bytes and removes only the confirmed checkout", async () => {
  const { root, path, writer, context } = await run();
  const commit = Bun.spawn(["git", "-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { stdout: "pipe", stderr: "pipe" });
  expect(await commit.exited).toBe(0);
  const worktree = join(path, "worktrees", "isolated");
  const added = Bun.spawn(["git", "-C", root, "worktree", "add", "--detach", worktree, "HEAD"], { stdout: "pipe", stderr: "pipe" });
  expect(await added.exited).toBe(0);
  const item = assignment("isolated");
  item.isolation = { kind: "worktree", path: worktree, base: { head: "HEAD", indexTree: "tree", worktreeDigest: hash, scopeDigest: hash, parentEffectDigest: hash } };
  const recorded = await transact(writer, { kind: "record-work", assignment: item }, context("worktree"));
  if (recorded.kind !== "committed") throw new Error("Work assignment did not commit");
  const work = recorded.state.work.find(work => work.id === item.id)!;
  const issued = await transact(writer, { kind: "issue-action", draft: { input: { kind: "run_finite", scheduler: "task", work: [{ id: work.id, revision: work.revision, attemptId: work.attempt.id }], assignments: [item] }, recipients: [{ workId: work.id, workRevision: work.revision, attemptId: work.attempt.id, seatId: work.seatId, toolVersions: [] }], planRevision: 0 }, programHash: hash }, context("issued-worktree"));
  if (issued.kind !== "committed") throw new Error("Worktree action did not commit");
  await transact(writer, { kind: "record-worktree", worktree: { schemaVersion: 1, runId: issued.state.runId, path: worktree, actionId: issued.state.actions.at(-1)!.id, work: { id: work.id, revision: work.revision, attemptId: work.attempt.id }, createdAt: Date.now(), evidence: [issued.state.repository.baselineRef] }, observation: { kind: "runtime-confirmed", toolCallId: "fixture-git-worktree-add", evidence: [issued.state.repository.baselineRef] } }, context("attested-worktree"));
  await transact(writer, { kind: "request-cancel", reason: "fixture complete", evidence: [] }, context("cancel"));
  await closeWriter(writer);
  const reviewed = await planCleanup(path);
  await writeFile(join(worktree, "new-user-data"), "preserve unless reviewed again");
  await expect(cleanupRun(reviewed, confirmation(reviewed))).rejects.toMatchObject({ code: "cleanup-changed" });
  expect(await readFile(join(worktree, "new-user-data"), "utf8")).toBe("preserve unless reviewed again");
  const current = await planCleanup(path);
  const result = await cleanupRun(current, confirmation(current));
  expect(result.removedPaths).toContain(worktree);
  await expect(lstat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
});

function repairConfirmation(plan: StorageRepairPlan): TrustedConfirmation {
  return { reviewedPlanHash: plan.digest, approval: { id: "repair-confirmed", kind: "recovery", decision: "approve", authority: "omp-tui", scopeHash: plan.digest, planRevision: 0, toolVersions: [], ownerEpoch: plan.ownerEpoch, createdAt: Date.now(), rationale: "Preserve the displayed original bytes and repair the verified prefix", evidence: [] } };
}
test("explicit torn-tail repair preserves complete original bytes and requires changed-preview confirmation", async () => {
  const { path, writer } = await run("tail-repair");
  await closeWriter(writer);
  const log = join(path, "events.jsonl"), original = await readFile(log);
  await appendFile(log, '{"schemaVersion":1,"unfinished":');
  const damaged = await readFile(log), preview = await planStorageRepair(path);
  expect(preview.kind).toBe("log-tail");
  expect((await readRun(path)).writable).toBe(false);
  await expect(repairRunStorage(preview, { ...repairConfirmation(preview), reviewedPlanHash: hash })).rejects.toMatchObject({ code: "confirmation-mismatch" });
  expect(await readFile(log)).toEqual(damaged);
  const repaired = await repairRunStorage(preview, repairConfirmation(preview));
  expect(repaired.kind).toBe("recovered");
  expect(await readFile(join(preview.preservePath, "events.jsonl"))).toEqual(damaged);
  expect((await lstat(join(preview.preservePath, "events.jsonl"))).mode & 0o777).toBe(0o400);
  expect((await readFile(log)).subarray(0, original.length)).toEqual(original);
  const loaded = await readRun(path);
  expect(loaded.writable).toBe(true);
  expect(loaded.state.lifecycle).toBe("blocked");
  expect(loaded.state.owner.epoch).toBe(1);
  expect(loaded.state.recovery?.primaryReason).toBe("storage-recovery");
});
test("snapshot rebuild trusts the verified log and refuses unknown schema versions before preservation", async () => {
  const { path, writer, state } = await run("snapshot-repair");
  await closeWriter(writer);
  const snapshot = join(path, "state.json");
  await writeFile(snapshot, canonicalJson({ ...state, usage: { ...state.usage, tokens: 999 } }));
  const damaged = await readFile(snapshot), preview = await planStorageRepair(path);
  expect(preview.kind).toBe("snapshot-rebuild");
  await writeFile(snapshot, canonicalJson({ ...state, schemaVersion: 2 }));
  await expect(planStorageRepair(path)).rejects.toMatchObject({ code: "unknown-snapshot-version" });
  await expect(lstat(preview.preservePath)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(snapshot, damaged);
  const repaired = await repairRunStorage(preview, repairConfirmation(preview));
  expect(repaired.kind).toBe("recovered");
  expect(await readFile(join(preview.preservePath, "state.json"))).toEqual(damaged);
  expect((await readRun(path)).state.usage.tokens).toBe(state.usage.tokens);
});
test("interrupted starts require explicit intact preservation and never replace legacy dashboards", async () => {
  const root = await repository(), path = join(root, ".planning", "orphan-start");
  const writer = await openWriter(path, { sessionId: "interrupted", purpose: "start" }); writers.push(writer);
  await closeWriter(writer);
  const marker = await readFile(join(path, ".creation.json"));
  await expect(openWriter(path, { sessionId: "new", purpose: "start" })).rejects.toMatchObject({ code: "existing-run-path" });
  const preview = await planStorageRepair(path);
  expect(preview.kind).toBe("orphan");
  const preserved = await repairRunStorage(preview, repairConfirmation(preview));
  expect(preserved.kind).toBe("orphan-preserved");
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(preview.preservePath, ".creation.json"))).toEqual(marker);
  await mkdir(path); await writeFile(join(path, "plan.html"), "legacy user dashboard");
  await expect(planStorageRepair(path)).rejects.toMatchObject({ code: "legacy-or-unknown-run" });
  expect(await readFile(join(path, "plan.html"), "utf8")).toBe("legacy user dashboard");
});
