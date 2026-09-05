import { constants } from "node:fs";
import { renderMarkdown } from "./dashboard.ts";
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as Type from "@sinclair/typebox/type";
import type { Static } from "@sinclair/typebox";
import {
  DecisionContextSchema, EngineInputSchema, PreflightEvidenceSchema, RunRecordSchema, RunSlugSchema, StartInputSchema,
  TrustedConfirmationSchema, WriterRequestSchema, DigestSchema, IdSchema, SequenceSchema,
  assertSchema, canonicalJson, digestJson,
  type DecisionContext, type Diagnostic, type EngineInput, type LoadedRun, type PreflightEvidence,
  type EvidenceRef, type RunRecord, type StartInput, type TransitionResult, type TrustedConfirmation, type WriterRequest,
} from "./contracts.ts";
import { applyEvent, decide, makeEvent } from "./engine.ts";

export class StoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly path: string, public readonly committed = false, public readonly removedPaths: string[] = []) {
    super(`${message}: ${path}`); this.name = "StoreError";
  }
}

/** The helper owns flock until stdin closes. A dead parent releases the OS lease, not its children. */
export class RunWriter {
  readonly leaseId = randomUUID();
  closed = false;
  poisoned = false;
  queue: Promise<unknown> = Promise.resolve();
  cached?: LoadedRun;
  fingerprint?: string;
  constructor(readonly runPath: string, readonly request: WriterRequest, readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">) {}
}
const noFollow = constants.O_NOFOLLOW;
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function git(root: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_OPTIONAL_LOCKS: "0" } });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (code !== 0) throw new StoreError("git-preflight", stderr.trim() || `Git exited ${code}`, root);
  return stdout.trimEnd();
}
async function safeRunPath(path: string, create: boolean): Promise<string> {
  if (process.platform !== "linux") throw new StoreError("unsupported-platform", "Supership storage requires Linux flock", path);
  const resolved = resolve(path);
  assertSchema(RunSlugSchema, basename(resolved), "run slug");
  if (basename(resolved) === "supership-upgrade") throw new StoreError("reserved-slug", "The upgrade handoff is not a run", resolved);
  const planning = dirname(resolved), root = dirname(planning);
  if (basename(planning) !== ".planning") throw new StoreError("invalid-run-path", "Run path must be <repository>/.planning/<slug>", resolved);
  if (await realpath(root) !== root) throw new StoreError("symlink-path", "Repository path must be canonical", root);
  if (await exists(planning)) { const info = await lstat(planning); if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError("symlink-path", "Planning path must be a real directory", planning); }
  if (await exists(resolved)) { const info = await lstat(resolved); if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreError("symlink-path", "Run path must be a real directory", resolved); }
  else if (!create) throw new StoreError("missing-run", "No versioned run exists", resolved);
  if (create) {
    if (resolve(await git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new StoreError("invalid-repository", "Run must live in the Git worktree root", root);
    await git(root, ["check-ignore", "--quiet", "--no-index", "--", `.planning/${basename(resolved)}/state.json`]);
  }
  return resolved;
}
async function safeRead(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | noFollow);
  try { if (!(await file.stat()).isFile()) throw new StoreError("invalid-file", "Expected a regular file", path); return await file.readFile(); }
  finally { await file.close(); }
}

export async function openWriter(runPath: string, request: WriterRequest): Promise<RunWriter> {
  assertSchema(WriterRequestSchema, request, "writer request");
  const path = await safeRunPath(runPath, request.purpose === "start");
  if (request.purpose === "start") {
    if (await exists(path)) {
      if (!(await readdir(path)).every(name => name === ".writer.lock")) throw new StoreError("existing-run-path", "Existing run data and legacy dashboards cannot become new runs", path);
    } else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { throw new StoreError("existing-run-path", `Another creator owns this run path (${String(error)})`, path); }
    }
  } else if (request.purpose !== "recover") {
    const loaded = await readRun(path);
    if (!loaded.writable && request.purpose !== "cleanup") throw new StoreError("read-only-recovery", "The preserved log requires explicit recovery before mutation", path);
  }
  const lockPath = join(path, ".writer.lock");
  const lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
  try { if (!(await lock.stat()).isFile()) throw new StoreError("invalid-lock", "Writer lock must be a regular file", lockPath); } finally { await lock.close(); }
  // No PID file or unlink-based stale-lock stealing. util-linux keeps this inode locked through exec.
  const helper = Bun.spawn(["flock", "--exclusive", "--nonblock", "--no-fork", lockPath, "/bin/sh", "-c", "printf 'locked\\n'; exec cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = helper.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done || new TextDecoder().decode(ready.value) !== "locked\n") {
    const error = await new Response(helper.stderr).text();
    helper.stdin.end(); await helper.exited;
    throw new StoreError("writer-busy", error.trim() || "Another process holds the writer lease", path);
  }
  const writer = new RunWriter(path, request, helper);
  try {
    if (request.purpose !== "start" && request.purpose !== "recover") {
      const loaded = await readRun(path);
      if (request.expectedEpoch !== undefined && request.expectedEpoch !== loaded.state.owner.epoch) throw new StoreError("stale-owner", "Expected owner epoch differs from persisted owner", path);
      if (request.purpose === "operate" && request.sessionId !== loaded.state.owner.sessionId) throw new StoreError("owner-mismatch", "Use resume to transfer an existing owner", path);
    }
    if (request.purpose === "start" && !(await readdir(path)).every(name => name === ".writer.lock")) throw new StoreError("existing-run-path", "A concurrent creator committed run data", path);
    if (request.purpose === "start") await durableExclusive(join(path, ".creation.json"), Buffer.from(canonicalJson({ schemaVersion: 1, slug: basename(path), sessionId: request.sessionId, leaseId: writer.leaseId, createdAt: Date.now() })));
    return writer;
  } catch (error) { await closeWriter(writer); throw error; }
}
export async function closeWriter(writer: RunWriter): Promise<void> {
  if (writer.closed) return;
  writer.closed = true;
  await writer.queue.catch(() => undefined);
  writer.process.stdin.end();
  await writer.process.exited;
}

/**
 * Only newline-terminated records commit. Preserve any final unterminated bytes unchanged and expose
 * the valid prefix read-only. Never append to or truncate that file. A complete unknown-version tail
 * is corruption, not a truncation excuse. A newline-terminated corrupt record always rejects.
 * A damaged run remains inspectable/exportable; an explicit recovery design must preserve its log
 * before creating a new writable history. This API deliberately provides no silent log repair.
 */
function replayPrefix(bytes: Buffer, logPath: string, snapshotSequence?: number) {
  const lastNewline = bytes.lastIndexOf(10), committedBytes = bytes.subarray(0, lastNewline + 1), tail = bytes.subarray(lastNewline + 1);
  if (tail.length) {
    try { const candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(tail)); if (candidate && typeof candidate === "object" && candidate.schemaVersion !== 1) throw new StoreError("unknown-event-version", "Unknown version in final record", logPath); }
    catch (error) { if (error instanceof StoreError) throw error; }
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(committedBytes); } catch (error) { throw new StoreError("corrupt-log", String(error), logPath); }
  let state: RunRecord | undefined, snapshotState: RunRecord | undefined;
  for (const [index, line] of (text ? text.slice(0, -1).split("\n") : []).entries()) {
    try { state = applyEvent(state, JSON.parse(line)); if (state.eventSequence === snapshotSequence) snapshotState = state; }
    catch (error) { throw new StoreError("corrupt-log", `Record ${index + 1}: ${String(error)}`, logPath); }
  }
  return { state, snapshotState, committedBytes, tail };
}
export async function readRun(runPath: string): Promise<LoadedRun> {
  const path = await safeRunPath(runPath, false), snapshotPath = join(path, "state.json"), logPath = join(path, "events.jsonl");
  if (!await exists(logPath)) { if (await exists(join(path, "plan.html"))) throw new StoreError("legacy-run", "Legacy plan.html remains readable but cannot resume or be overwritten", path); throw new StoreError("missing-event-log", "A snapshot without its event history cannot resume", logPath); }
  let snapshot: RunRecord | undefined;
  if (await exists(snapshotPath)) {
    try { snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await safeRead(snapshotPath))); assertSchema(RunRecordSchema, snapshot, "snapshot"); }
    catch (error) { throw new StoreError("invalid-snapshot", String(error), snapshotPath); }
  }
  const replayed = replayPrefix(await safeRead(logPath), logPath, snapshot?.eventSequence), state = replayed.state;
  if (!state) throw new StoreError("missing-genesis", "No committed run creation exists", logPath);
  if (snapshot && (!replayed.snapshotState || snapshot.eventSequence > state.eventSequence)) throw new StoreError("snapshot-ahead", "Snapshot is not a prefix of the committed event log", snapshotPath);
  if (snapshot && !sameState(snapshot, replayed.snapshotState)) throw new StoreError("snapshot-diverged", "Snapshot differs from its committed event prefix", snapshotPath);
  if (state.slug !== basename(path) || resolve(state.repository.root) !== dirname(dirname(path))) throw new StoreError("run-path-mismatch", "Persisted repository/slug differs from run location", path);
  const diagnostics: Diagnostic[] = [];
  if (replayed.tail.length) diagnostics.push({ code: "uncommitted-tail", severity: "error", message: replayed.tail.length + " final bytes have no commit newline. Original log is preserved; valid prefix is read-only.", path: logPath, evidence: [] });
  if (!snapshot || snapshot.eventSequence < state.eventSequence) diagnostics.push({ code: "snapshot-replayed", severity: "warning", message: "Committed events supersede the snapshot; state was reconstructed without repeating effects.", path: snapshotPath, evidence: [] });
  return { state, diagnostics, writable: replayed.tail.length === 0 };
}
function sameState(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

async function fileFingerprint(path: string): Promise<string> {
  const records = await Promise.all(["events.jsonl", "state.json"].map(async name => {
    try { const info = await lstat(join(path, name), { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  }));
  return records.join(";");
}

async function snapshotState(path: string, state: RunRecord): Promise<void> {
  const temporary = join(path, `.state-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { await file.writeFile(`${canonicalJson(state)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(path, "state.json"));
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function createRun(writer: RunWriter, input: StartInput, preflight: PreflightEvidence): Promise<TransitionResult> {
  assertSchema(StartInputSchema, input, "start input"); assertSchema(PreflightEvidenceSchema, preflight, "preflight");
  if (writer.request.purpose !== "start" || !sameState(input.start.preflight, preflight)) throw new StoreError("invalid-preflight", "Start requires the exact successful preflight packet", writer.runPath);
  if (input.start.owner.leaseId !== writer.leaseId || input.start.owner.sessionId !== writer.request.sessionId) throw new StoreError("owner-mismatch", "Start must bind the current writer lease", writer.runPath);
  return transact(writer, input, { now: Date.now(), inputId: `start:${input.start.runId}`, ownerSessionId: input.start.owner.sessionId, ownerEpoch: input.start.owner.epoch });
}
export async function transact(writer: RunWriter, input: EngineInput, context: DecisionContext): Promise<TransitionResult> {
  // Parse before acquiring queue slots or touching files. Unknown contracts cannot create effects.
  assertSchema(EngineInputSchema, input, "engine input"); assertSchema(DecisionContextSchema, context, "decision context");
  input = structuredClone(input); context = structuredClone(context);
  const execute = async (): Promise<TransitionResult> => {
    if (writer.closed || writer.poisoned || writer.process.exitCode !== null) throw new StoreError("writer-unavailable", "Writer is closed, lost or requires persistence recovery", writer.runPath);
    if (context.ownerSessionId !== writer.request.sessionId) throw new StoreError("owner-mismatch", "Decision context does not own this writer", writer.runPath);
    let loaded: LoadedRun | undefined;
    // The exclusive lease owns this cache. External changes require a new inspection.
    const fingerprint = await fileFingerprint(writer.runPath);
    if (writer.cached && writer.fingerprint !== fingerprint) { writer.poisoned = true; throw new StoreError("writer-data-changed", "Run files changed outside the exclusive writer. Reopen for inspection before further effects", writer.runPath); }
    if (writer.cached) loaded = writer.cached;
    else if (await exists(join(writer.runPath, "events.jsonl"))) loaded = await readRun(writer.runPath);
    else if (input.kind !== "start") throw new StoreError("missing-run", "Only start can create event history", writer.runPath);
    if (loaded && !loaded.writable) throw new StoreError("read-only-recovery", "Preserved incomplete log cannot accept writes", writer.runPath);
    if (input.kind === "start" && (input.start.slug !== basename(writer.runPath) || input.start.repository.root !== dirname(dirname(writer.runPath)) || input.start.owner.leaseId !== writer.leaseId)) throw new StoreError("run-path-mismatch", "Start identity differs from the leased path", writer.runPath);
    if (loaded && input.kind !== "resume" && (loaded.state.owner.leaseId !== writer.leaseId || loaded.state.owner.sessionId !== writer.request.sessionId)) throw new StoreError("resume-required", "A reopened writer must record an epoch transfer before effects", writer.runPath);
    if (input.kind === "resume" && (input.leaseId !== writer.leaseId || input.sessionId !== writer.request.sessionId)) throw new StoreError("owner-mismatch", "Resume must bind the current OS writer lease", writer.runPath);
    const decision = decide(loaded?.state, input, context);
    if (decision.kind === "reject") return { kind: "rejected", ...(loaded ? { state: structuredClone(loaded.state) } : {}), code: decision.code, message: decision.message, evidence: decision.evidence };
    if (decision.kind === "duplicate") return { kind: "duplicate", state: structuredClone(loaded!.state) };
    const event = makeEvent(loaded?.state, input, context, decision.facts);
    const state = applyEvent(loaded?.state, event);
    let flushed = false;
    try {
      const log = await open(join(writer.runPath, "events.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600);
      try {
        await log.writeFile(`${canonicalJson(event)}\n`);
        await log.sync();
        flushed = true;
      } finally { await log.close(); }
      await snapshotState(writer.runPath, state);
    } catch (error) {
      writer.poisoned = true;
      throw new StoreError("persistence-uncertain", `${flushed ? "Event is committed; snapshot failed" : "Event append/flush may be incomplete"}. Stop new effects and reopen for inspection. ${String(error)}`, writer.runPath, flushed);
    }
    writer.cached = { state: structuredClone(state), diagnostics: [], writable: true };
    writer.fingerprint = await fileFingerprint(writer.runPath);
    return { kind: "committed", state, event, diagnostics: [] };
  };
  const result = writer.queue.then(execute, execute);
  writer.queue = result.then(() => undefined, () => undefined);
  return result;
}

export async function exportRun(runPath: string): Promise<string> {
  const { state } = await readRun(runPath);
  return renderMarkdown(state);
}

const closed = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const CleanupEntrySchema = closed({ path: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")]), digest: DigestSchema });
export const CleanupPlanSchema = closed({ schemaVersion: Type.Literal(1), runId: IdSchema, runPath: Type.String(), repositoryRoot: Type.String(), ownerEpoch: SequenceSchema, eventSequence: SequenceSchema, stateHash: DigestSchema, entries: Type.Array(CleanupEntrySchema), worktrees: Type.Array(closed({ path: Type.String(), treeDigest: DigestSchema })), digest: DigestSchema });
export type CleanupPlan = Static<typeof CleanupPlanSchema>;
export type CleanupEntry = Static<typeof CleanupEntrySchema>;

async function treeEntries(path: string): Promise<CleanupEntry[]> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return [{ path, kind: "symlink", digest: digestJson({ target: await readlink(path), mode: info.mode }) }];
  if (info.isFile()) return [{ path, kind: "file", digest: digestJson({ content: createHash("sha256").update(await safeRead(path)).digest("hex"), mode: info.mode }) }];
  if (!info.isDirectory()) throw new StoreError("unsupported-cleanup-entry", "Cleanup refuses sockets, devices and other special entries", path);
  const entries: CleanupEntry[] = [{ path, kind: "directory", digest: digestJson({ mode: info.mode }) }];
  for (const name of (await readdir(path)).sort()) entries.push(...await treeEntries(join(path, name)));
  return entries;
}
async function cleanupPlan(runPath: string): Promise<CleanupPlan> {
  const loaded = await readRun(runPath), state = loaded.state;
  if (!loaded.writable || !["completed", "cancelled"].includes(state.lifecycle) || state.work.some(work => work.runtimeOwners.some(owner => owner.status !== "observed-terminal")) || state.recovery?.unresolvedOwners.length || state.pools.some(pool => pool.owner && pool.owner.status !== "observed-terminal") || state.toolInvocations.some(invocation => ["running", "uncertain"].includes(invocation.outcome))) throw new StoreError("unsafe-cleanup", "Cleanup requires terminal state and confirmed settled runtime owners", runPath);
  const path = await safeRunPath(runPath, false);
  const registered = (await git(state.repository.root, ["worktree", "list", "--porcelain", "-z"])).split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9));
  const worktrees: CleanupPlan["worktrees"] = [];
  const unique = new Set(state.worktrees.map(worktree => resolve(worktree.path)));
  for (const checkout of registered.filter(checkout => checkout.startsWith(`${join(path, "worktrees")}${sep}`))) if (!unique.has(checkout)) throw new StoreError("unverified-worktree", "Registered checkout has no observed runtime creation receipt", checkout);
  if (state.worktrees.some(worktree => worktree.runId !== state.runId || !worktree.evidence.length || worktree.evidence.some(ref => ref.availability !== "available"))) throw new StoreError("unverified-worktree", "Worktree creation evidence is unavailable or belongs to another run", path);
  for (const worktree of unique) {
    if (worktree === state.repository.root || !registered.includes(worktree) || path.startsWith(`${worktree}${sep}`) || !worktree.startsWith(`${join(path, "worktrees")}${sep}`) || await realpath(worktree) !== worktree) throw new StoreError("unverified-worktree", "Cleanup requires a Git-registered checkout inside this run-owned worktrees directory; plan text does not establish external ownership", worktree);
    const tree = await treeEntries(worktree);
    worktrees.push({ path: worktree, treeDigest: digestJson(tree) });
  }
  const envelope = { schemaVersion: 1 as const, runId: state.runId, runPath: path, repositoryRoot: state.repository.root, ownerEpoch: state.owner.epoch, eventSequence: state.eventSequence, stateHash: digestJson(state), entries: (await treeEntries(path)).filter(entry => !worktrees.some(worktree => entry.path === worktree.path || entry.path.startsWith(`${worktree.path}${sep}`))), worktrees };
  return { ...envelope, digest: digestJson(envelope) };
}
export async function planCleanup(runPath: string): Promise<CleanupPlan> { return cleanupPlan(runPath); }

/** Caller must display every path and obtain explicit confirmation. No --yes or autonomous policy shortcut. */
export async function cleanupRun(plan: CleanupPlan, confirmation: TrustedConfirmation): Promise<{ runId: string; removedPaths: string[] }> {
  assertSchema(CleanupPlanSchema, plan, "cleanup plan"); assertSchema(TrustedConfirmationSchema, confirmation, "cleanup confirmation");
  const { digest, ...envelope } = plan;
  const approval = confirmation.approval;
  if (digest !== digestJson(envelope) || confirmation.reviewedPlanHash !== digest || approval.scopeHash !== digest || !["omp-tui", "cli-terminal"].includes(approval.authority) || approval.kind !== "cleanup" || approval.decision !== "approve" || approval.ownerEpoch !== plan.ownerEpoch) throw new StoreError("confirmation-mismatch", "Cleanup requires exact reviewed paths and trusted confirmation", plan.runPath);
  const writer = await openWriter(plan.runPath, { sessionId: `cleanup-${randomUUID()}`, expectedEpoch: plan.ownerEpoch, purpose: "cleanup" });
  const removedPaths: string[] = [];
  try {
    const current = await cleanupPlan(plan.runPath);
    if (!sameState(plan, current)) throw new StoreError("cleanup-changed", "Run files or worktree bytes changed after review", plan.runPath);
    for (const worktree of plan.worktrees) {
      if (digestJson(await treeEntries(worktree.path)) !== worktree.treeDigest) throw new StoreError("cleanup-changed", "Worktree bytes changed before deletion", worktree.path);
      await git(plan.repositoryRoot, ["worktree", "remove", "--force", "--", worktree.path]);
      removedPaths.push(worktree.path);
    }
    // Delete deepest entries first; never follow a symlink into a user directory.
    for (const entry of [...plan.entries].reverse()) {
      const currentEntry = (await treeEntries(entry.path))[0];
      if (!sameState(entry, currentEntry)) throw new StoreError("cleanup-changed", "Cleanup entry changed before deletion", entry.path);
      if (entry.kind === "directory") await rmdir(entry.path); else await rm(entry.path);
      removedPaths.push(entry.path);
    }
    return { runId: plan.runId, removedPaths };
  } catch (error) {
    if (error instanceof StoreError) throw new StoreError(error.code, error.message, error.path, error.committed, removedPaths);
    throw new StoreError("cleanup-partial", String(error), plan.runPath, false, removedPaths);
  } finally { await closeWriter(writer); }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function durableExclusive(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o400);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}
export const StorageRepairPlanSchema = closed({ schemaVersion: Type.Literal(1), kind: Type.Union([Type.Literal("log-tail"), Type.Literal("snapshot-rebuild"), Type.Literal("orphan")]), runPath: Type.String(), runId: IdSchema, ownerEpoch: SequenceSchema, eventSequence: SequenceSchema, entries: Type.Array(CleanupEntrySchema), preservePath: Type.String(), committedBytes: SequenceSchema, logDigest: Type.Optional(DigestSchema), snapshotDigest: Type.Optional(DigestSchema), digest: DigestSchema });
export type StorageRepairPlan = Static<typeof StorageRepairPlanSchema>;
export type StorageRepairResult = { kind: "recovered"; state: RunRecord; preserved: EvidenceRef[] } | { kind: "orphan-preserved"; runPath: string; preservedPath: string };
const bytesDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function planStorageRepair(runPath: string): Promise<StorageRepairPlan> {
  const path = await safeRunPath(runPath, false), logPath = join(path, "events.jsonl"), snapshotPath = join(path, "state.json");
  const log = await exists(logPath) ? await safeRead(logPath) : undefined, snapshotBytes = await exists(snapshotPath) ? await safeRead(snapshotPath) : undefined;
  let snapshot: unknown;
  if (snapshotBytes) {
    try { snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes)); } catch (error) { throw new StoreError("unidentified-snapshot", "Cannot establish the damaged snapshot schema version: " + String(error), snapshotPath); }
    if (!snapshot || typeof snapshot !== "object" || !("schemaVersion" in snapshot) || snapshot.schemaVersion !== 1) throw new StoreError("unknown-snapshot-version", "Unknown snapshot schema cannot be overwritten", snapshotPath);
  }
  const prefix = log ? replayPrefix(log, logPath) : undefined, state = prefix?.state;
  const entries = (await treeEntries(path)).filter(entry => entry.path !== join(path, ".writer.lock"));
  let kind: StorageRepairPlan["kind"];
  if (!state) {
    if (snapshotBytes || await exists(join(path, "plan.html"))) throw new StoreError("legacy-or-unknown-run", "Legacy or unknown data cannot become a new run", path);
    const markerPath = join(path, ".creation.json");
    if (await exists(markerPath)) {
      const marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await safeRead(markerPath)));
      if (marker.schemaVersion !== 1 || marker.slug !== basename(path) || typeof marker.sessionId !== "string" || typeof marker.leaseId !== "string") throw new StoreError("unknown-orphan", "Creation marker does not identify this interrupted start", markerPath);
    } else if (log?.length) throw new StoreError("unknown-orphan", "Uncommitted data has no known creation marker", path);
    if (entries.some(entry => entry.path !== path && ![markerPath, logPath].includes(entry.path))) throw new StoreError("unknown-orphan", "Unknown files are not interrupted-start debris", path);
    kind = "orphan";
  } else {
    if (state.slug !== basename(path) || resolve(state.repository.root) !== dirname(dirname(path))) throw new StoreError("run-path-mismatch", "Verified log belongs to another run path", path);
    if (prefix!.tail.length) kind = "log-tail";
    else if (!sameState(snapshot ?? null, state)) kind = "snapshot-rebuild";
    else throw new StoreError("repair-not-needed", "Committed log and snapshot already agree", path);
  }
  const identity = digestJson({ kind, entries, committedBytes: prefix?.committedBytes.length ?? 0 });
  const preservePath = join(dirname(path), basename(path).slice(0, 32) + "-recovery-" + identity.slice(0, 16));
  const envelope = { schemaVersion: 1 as const, kind, runPath: path, runId: state?.runId ?? "orphan-" + identity.slice(0, 24), ownerEpoch: state?.owner.epoch ?? 0, eventSequence: state?.eventSequence ?? 0, entries, preservePath, committedBytes: prefix?.committedBytes.length ?? 0, ...(log ? { logDigest: bytesDigest(log) } : {}), ...(snapshotBytes ? { snapshotDigest: bytesDigest(snapshotBytes) } : {}) };
  return { ...envelope, digest: digestJson(envelope) };
}
/** Display the exact plan first. This function never supplies its own confirmation. */
export async function repairRunStorage(plan: StorageRepairPlan, confirmation: TrustedConfirmation): Promise<StorageRepairResult> {
  assertSchema(StorageRepairPlanSchema, plan, "storage repair plan"); assertSchema(TrustedConfirmationSchema, confirmation, "storage repair confirmation");
  const { digest, ...envelope } = plan, approval = confirmation.approval;
  if (digest !== digestJson(envelope) || confirmation.reviewedPlanHash !== digest || approval.scopeHash !== digest || approval.kind !== "recovery" || approval.decision !== "approve" || !["omp-tui", "cli-terminal"].includes(approval.authority) || approval.ownerEpoch !== plan.ownerEpoch) throw new StoreError("confirmation-mismatch", "Repair requires the exact reviewed files, preserved destination and trusted confirmation", plan.runPath);
  const writer = await openWriter(plan.runPath, { sessionId: "repair-" + randomUUID(), expectedEpoch: plan.ownerEpoch, purpose: "recover" });
  try {
    const current = await planStorageRepair(plan.runPath);
    if (!sameState(current, plan)) throw new StoreError("repair-changed", "Run bytes changed after the repair preview", plan.runPath);
    if (plan.kind === "orphan") {
      if (await exists(plan.preservePath)) throw new StoreError("preserve-path-exists", "Preserved orphan destination already exists", plan.preservePath);
      await rename(plan.runPath, plan.preservePath); await syncDirectory(dirname(plan.runPath));
      return { kind: "orphan-preserved", runPath: plan.runPath, preservedPath: plan.preservePath };
    }
    const originals = [{ name: "events.jsonl", bytes: await safeRead(join(plan.runPath, "events.jsonl")) }];
    if (plan.snapshotDigest) originals.push({ name: "state.json", bytes: await safeRead(join(plan.runPath, "state.json")) });
    if (!await exists(plan.preservePath)) await mkdir(plan.preservePath, { mode: 0o700 });
    if ((await lstat(plan.preservePath)).isSymbolicLink() || !((await lstat(plan.preservePath)).isDirectory())) throw new StoreError("unsafe-preservation-path", "Preservation destination must be a real directory", plan.preservePath);
    const manifest = Buffer.from(canonicalJson({ schemaVersion: 1, planDigest: plan.digest, files: originals.map(file => ({ name: file.name, digest: bytesDigest(file.bytes) })) }));
    const manifestPath = join(plan.preservePath, "manifest.json");
    if (await exists(manifestPath)) { if (!Buffer.from(await safeRead(manifestPath)).equals(manifest)) throw new StoreError("preservation-mismatch", "Existing backup belongs to another repair", manifestPath); }
    else { if ((await readdir(plan.preservePath)).length) throw new StoreError("preservation-mismatch", "Unknown files occupy the preservation destination", plan.preservePath); await durableExclusive(manifestPath, manifest); }
    for (const original of originals) {
      const destination = join(plan.preservePath, original.name);
      if (await exists(destination)) { if (!Buffer.from(await safeRead(destination)).equals(original.bytes)) throw new StoreError("preservation-mismatch", "Preserved original bytes changed", destination); }
      else await durableExclusive(destination, original.bytes);
    }
    await syncDirectory(plan.preservePath); await syncDirectory(dirname(plan.preservePath));
    const prefix = replayPrefix(originals[0].bytes, join(plan.runPath, "events.jsonl"));
    let state = prefix.state!;
    const preserved: EvidenceRef[] = originals.map(original => ({ id: "preserved-" + plan.digest.slice(0, 16) + "-" + original.name, kind: "file", uri: relative(state.repository.root, join(plan.preservePath, original.name)), digest: bytesDigest(original.bytes), mediaType: "application/json", summary: "Original bytes preserved before explicit " + plan.kind + " recovery", availability: "available" }));
    const events: Buffer[] = [];
    const record = (input: EngineInput, context: DecisionContext) => {
      const decision = decide(state, input, context);
      if (decision.kind !== "append") throw new StoreError("invalid-recovery-transition", decision.kind === "reject" ? decision.message : "Repair transition already recorded", plan.runPath);
      const event = makeEvent(state, input, context, decision.facts); state = applyEvent(state, event); events.push(Buffer.from(canonicalJson(event) + "\n"));
    };
    if (!["completed", "cancelled"].includes(state.lifecycle)) record({ kind: "resume", sessionId: writer.request.sessionId, leaseId: writer.leaseId, reconciliation: { confirmed: [], unresolved: state.work.flatMap(work => work.runtimeOwners).filter(owner => owner.status !== "observed-terminal"), candidateResults: preserved, requiredChoices: [] } }, { inputId: "repair-resume-" + plan.digest, now: Math.max(Date.now(), state.updatedAt), ownerSessionId: writer.request.sessionId, ownerEpoch: state.owner.epoch });
    record({ kind: "record-storage-recovery", preserved, reason: "Trusted " + plan.kind + " repair preserved original bytes and rebuilt the committed event prefix" }, { inputId: "storage-repair-" + plan.digest, now: Math.max(Date.now(), state.updatedAt), ownerSessionId: state.owner.sessionId, ownerEpoch: state.owner.epoch });
    const temporary = join(plan.runPath, ".events-repair-" + randomUUID() + ".tmp");
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try { await file.writeFile(prefix.committedBytes); for (const event of events) await file.writeFile(event); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(plan.runPath, "events.jsonl")); await syncDirectory(plan.runPath); await snapshotState(plan.runPath, state);
    return { kind: "recovered", state, preserved };
  } finally { await closeWriter(writer); }
}
