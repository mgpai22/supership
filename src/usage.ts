import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Type from "@sinclair/typebox/type";
import type { Static, TSchema } from "@sinclair/typebox";
import { IdSchema, SchemaVersion, SequenceSchema, TimestampSchema, WorkRefSchema, assertSchema, canonicalJson, digestJson } from "./contracts.ts";
import type { ActionRecord, RunRecord, UsageCoverage, UsageSource, WorkRef } from "./contracts.ts";

// The observer is a read-only metadata opinion written by the child's own extension hooks. It is not a sandbox and not a
// security guarantee: a child that can write the run root can forge or damage its own record, and the importer reports that as a gap.

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UuidSchema = Type.String({ pattern: UUID.source });
export const UsageMeterConfigSchema = object({ schemaVersion: SchemaVersion, runPath: Type.String(), runId: IdSchema, parentSessionId: IdSchema, ownerEpoch: SequenceSchema });
export type UsageMeterConfig = Static<typeof UsageMeterConfigSchema>;
/** The `supership` object the adapter embeds at the top level of every finite and pool item packet. A packet always names work. */
export const UsagePacketSchema = object({ runId: IdSchema, parentSessionId: IdSchema, ownerEpoch: SequenceSchema, actionId: IdSchema, work: Type.Array(WorkRefSchema, { minItems: 1 }) });
export type UsagePacket = Static<typeof UsagePacketSchema>;
const AssignmentSchema = object({ actionId: IdSchema, work: Type.Array(WorkRefSchema, { minItems: 1 }) });
/** One assistant message_end, written by the child. Numeric usage and identity only, never message content. */
export const UsageObservationSchema = object({
  schemaVersion: SchemaVersion, observerId: UuidSchema, sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), nativeSessionId: UuidSchema,
  runId: IdSchema, parentSessionId: IdSchema, ownerEpoch: SequenceSchema, assignments: Type.Union([Type.Null(), Type.Array(AssignmentSchema, { minItems: 1 })]),
  observedAt: TimestampSchema, model: IdSchema, tokens: SequenceSchema, costAmount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), stopReason: Type.String({ maxLength: 32 }), complete: Type.Boolean(),
});
export type UsageObservation = Static<typeof UsageObservationSchema>;
export interface UsageGap { nativeSessionId: string; reason: "damaged" | "rejected" | "unbound" }
export interface UsageObservations { sources: UsageSource[]; coverage: UsageCoverage[]; gaps: UsageGap[] }
type RunAuthority = Pick<RunRecord, "runId" | "owner" | "actions" | "work" | "usageCoverage" | "usageSources">;

function directory(path: string): void {
  let ancestor = path;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) throw new Error("Usage directory has a symlink or non-directory ancestor");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error("Usage directory has a symlink ancestor");
}
function write(path: string, content: string, flags: "wx" | "a"): void {
  const fd = openSync(path, flags, 0o600);
  try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
export function usageObservationDirectory(runPath: string): string { return join(runPath, "evidence", "child-usage"); }

// Non-isolated children rebind the parent's already loaded extension factories and never re-read the extension list,
// so the parent extension observes through this process-local registry; isolated children rediscover the prepared root.
const activeMeters = new Map<string, UsageMeterConfig>();
// One observer per live session object: an isolated child loads both routes, and a parked child revives with a new
// session manager and new extension instances under the same session id, so a claim keyed by id would outlive its observer.
const claimedSessions = new WeakMap<object, string>();

/** Installs the run-bound observer root and activates the in-process meter before every managed child route. */
export async function prepareUsageMeter(request: Omit<UsageMeterConfig, "schemaVersion">): Promise<{ extensionRoot: string }> {
  const config: UsageMeterConfig = { schemaVersion: 1, runPath: resolve(request.runPath), runId: request.runId, parentSessionId: request.parentSessionId, ownerEpoch: request.ownerEpoch };
  assertSchema(UsageMeterConfigSchema, config, "usage meter configuration");
  if (realpathSync(config.runPath) !== config.runPath) throw new Error("Run root must be a canonical existing directory");
  const extensionRoot = join(config.runPath, "usage-meter", digestJson({ parentSessionId: config.parentSessionId, ownerEpoch: config.ownerEpoch }));
  directory(extensionRoot); directory(usageObservationDirectory(config.runPath));
  const extensionPath = join(extensionRoot, "index.ts");
  const code = `import { installUsageObserver } from ${JSON.stringify(fileURLToPath(new URL("./usage.ts", import.meta.url)))};\nexport default api => installUsageObserver(api, ${canonicalJson(config)});\n`;
  if (lstatSync(extensionPath, { throwIfNoEntry: false })) {
    if (realpathSync(extensionPath) !== extensionPath || readFileSync(extensionPath, "utf8") !== code) throw new Error("Trusted usage meter configuration changed");
  } else write(extensionPath, code, "wx");
  activeMeters.set(config.parentSessionId, config);
  return { extensionRoot };
}
/** Stops in-process observation for a parent session. Files and the prepared root remain evidence. */
export function releaseUsageMeter(parentSessionId: string): void { activeMeters.delete(parentSessionId); }

function balancedObject(text: string, start: number): string | undefined {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}
/** Every packet in the prompt must be valid and belong to this run, epoch, and owner; otherwise the turn is unbound. */
export function bindUsagePackets(prompt: string, config: Pick<UsageMeterConfig, "runId" | "parentSessionId" | "ownerEpoch">): UsageObservation["assignments"] | undefined {
  const assignments = new Map<string, Map<string, WorkRef>>();
  let found = false;
  for (const match of prompt.matchAll(/"supership"\s*:\s*(?=\{)/g)) {
    found = true;
    const body = balancedObject(prompt, match.index + match[0].length);
    if (body === undefined) return null;
    let packet: UsagePacket;
    try { packet = JSON.parse(body); assertSchema(UsagePacketSchema, packet, "usage packet"); } catch { return null; }
    if (packet.runId !== config.runId || packet.parentSessionId !== config.parentSessionId || packet.ownerEpoch !== config.ownerEpoch) return null;
    const work = assignments.get(packet.actionId) ?? new Map<string, WorkRef>();
    for (const ref of packet.work) work.set(canonicalJson(ref), ref);
    assignments.set(packet.actionId, work);
  }
  if (!found) return undefined;
  return [...assignments.keys()].sort().map(actionId => ({ actionId, work: [...assignments.get(actionId)!.keys()].sort().map(key => assignments.get(actionId)!.get(key)!) }));
}

function observe(api: ExtensionAPI, meters: () => UsageMeterConfig[]): void {
  const observerId = randomUUID();
  let sequence = 0;
  let binding: { config: UsageMeterConfig; assignments: UsageObservation["assignments"] } | undefined;
  // Delivered messages reach hooks through message_end for every route, including the IRC wake turn of a revived child,
  // which never runs before_agent_start.
  api.on("message_end", (event, ctx) => {
    const nativeSessionId = ctx.sessionManager.getSessionId();
    const configs = meters();
    if (configs.some(candidate => candidate.parentSessionId === nativeSessionId) || !UUID.test(nativeSessionId)) return;
    const received = event.message;
    const delivered = received.role === "user" || received.role === "custom" && received.customType === "irc:incoming" ? typeof received.content === "string" ? received.content : received.content.map(block => block.type === "text" ? block.text : "").join("\n") : undefined;
    if (delivered !== undefined) {
      if (!/"supership"\s*:/.test(delivered)) return;
      const bound = configs.map(config => ({ config, assignments: bindUsagePackets(delivered, config) ?? null })).find(candidate => candidate.assignments !== null);
      binding = bound ?? (configs.length ? { config: configs[0]!, assignments: null } : undefined);
      return;
    }
    // An unbound child is a diagnostic only when one meter is active.
    const config = binding?.config ?? (configs.length === 1 ? configs[0] : undefined);
    if (!config || event.message.role !== "assistant") return;
    if ((claimedSessions.get(ctx.sessionManager) ?? claimedSessions.set(ctx.sessionManager, observerId).get(ctx.sessionManager)) !== observerId) return;
    const message = event.message, usage = message.usage;
    // Usage the protocol did not report is a gap, never an observed zero-token complete message.
    const valid = Number.isSafeInteger(usage?.totalTokens) && usage.totalTokens >= 0;
    const reported = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total > 0 ? usage.cost.total : null;
    let priced = false;
    try { const rates = ctx.models.resolve(`${message.provider}/${message.model}`)?.cost; priced = !!rates && [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some(rate => rate > 0); } catch { priced = false; }
    const observedAt = [message.completedAt, message.timestamp, Date.now()].find(value => Number.isSafeInteger(value) && value! >= 0)!;
    const record: UsageObservation = {
      schemaVersion: 1, observerId, sequence: ++sequence, nativeSessionId, runId: config.runId, parentSessionId: config.parentSessionId, ownerEpoch: config.ownerEpoch, assignments: binding?.assignments ?? null,
      observedAt, model: `${message.provider}/${message.model}`.slice(0, 200), tokens: valid ? usage.totalTokens : 0, costAmount: valid ? reported ?? (priced ? 0 : null) : null,
      stopReason: valid ? String(message.stopReason).slice(0, 32) : "malformed-usage", complete: valid && message.stopReason !== "error" && message.stopReason !== "aborted",
    };
    try {
      assertSchema(UsageObservationSchema, record, "usage observation");
      const dir = usageObservationDirectory(config.runPath); directory(dir);
      write(join(dir, `${nativeSessionId}.jsonl`), `${JSON.stringify(record)}\n`, "a");
    } catch { /* A meter failure must not stop the child; the parent reports the gap. */ }
  });
}
/** Direct install for the prepared root that isolated children rediscover. */
export function installUsageObserver(api: ExtensionAPI, config: UsageMeterConfig): void {
  assertSchema(UsageMeterConfigSchema, config, "usage meter configuration");
  observe(api, () => [config]);
}
/** Install from the Supership extension factory; children that rebind the factory observe every active meter. */
export function observeChildUsage(api: ExtensionAPI): void { observe(api, () => [...activeMeters.values()]); }

function actionWork(action: ActionRecord | undefined, record: Pick<UsageObservation, "runId" | "ownerEpoch">, refs: WorkRef[]): boolean {
  // Only a claimed action ever started an execution; a record naming an issued action contradicts the run.
  if (!action || action.claimedAt === undefined || action.runId !== record.runId || action.ownerEpoch !== record.ownerEpoch) return false;
  return refs.length > 0 && refs.every(ref => action.recipients.some(known => known.workId === ref.id && known.workRevision === ref.revision && known.attemptId === ref.attemptId));
}
function authorized(record: UsageObservation, state: RunAuthority): boolean {
  if (record.runId !== state.runId || record.ownerEpoch > state.owner.epoch) return false;
  if (record.ownerEpoch === state.owner.epoch && record.parentSessionId !== state.owner.sessionId) return false;
  // A prior epoch keeps its authorization through its retained actions; usage incurred late still counts, but it never revives the work.
  return (record.assignments ?? []).every(assignment => actionWork(state.actions.find(candidate => candidate.id === assignment.actionId), record, assignment.work));
}
const scopeKey = (actionId: string, work: WorkRef) => `usage:${actionId}:${work.id}:${work.revision}:${work.attemptId}`;

/**
 * Reads optional transport inputs into canonical contributions and per-work coverage. Missing or damaged input never creates a
 * zero source, and input that vanished never erases canonical coverage: a scope without new file evidence keeps its prior record.
 */
export async function readUsageObservations(runPath: string, state: RunAuthority, now = Date.now()): Promise<UsageObservations> {
  const dir = usageObservationDirectory(resolve(runPath));
  const sources: UsageSource[] = [], gaps: UsageGap[] = [];
  const scopes = new Map<string, { actionId: string; work: WorkRef; terminal: boolean; sessions: Set<string>; observedAt: number; count: number; prior?: UsageCoverage }>();
  const scope = (actionId: string, work: WorkRef) => scopes.get(scopeKey(actionId, work)) ?? scopes.set(scopeKey(actionId, work), { actionId, work, terminal: false, sessions: new Set(), observedAt: 0, count: 0 }).get(scopeKey(actionId, work))!;
  // Every claimed recipient is an execution the adapter started, whether or not its creation receipt ever arrived.
  for (const action of state.actions) if (action.claimedAt !== undefined) for (const recipient of action.recipients) scope(action.id, { id: recipient.workId, revision: recipient.workRevision, attemptId: recipient.attemptId });
  for (const item of state.work) for (const owner of item.runtimeOwners) {
    if (owner.kind === "pool") continue;
    const entry = scope(owner.actionId, { id: owner.workId, revision: owner.workRevision, attemptId: owner.attemptId });
    entry.terminal ||= owner.status === "observed-terminal";
  }
  for (const record of state.usageCoverage) {
    if (record.work.length !== 1 || scopeKey(record.actionId, record.work[0]!) !== record.id) continue;
    const entry = scope(record.actionId, record.work[0]!);
    entry.prior = record;
    // A retry replaces the work item and drops the prior attempt's runtime owner; the canonical terminal verdict is not evidence that vanished.
    entry.terminal ||= record.status === "complete";
    if (record.nativeSessionId) entry.sessions.add(record.nativeSessionId);
  }
  const canonical = new Map(state.usageSources.map(source => [source.id, source]));
  // The core merges a re-emitted row by max, so only growth counts against the representable aggregate; a saturated aggregate leaves none.
  let headroom = Math.max(0, Number.MAX_SAFE_INTEGER - state.usageSources.reduce((total, source) => total + source.tokens, 0));
  const damaged = new Set<string>();
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) for (const name of readdirSync(dir).sort()) {
    const nativeSessionId = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    if (!UUID.test(nativeSessionId) || nativeSessionId === state.owner.sessionId) continue;
    const flags = { damaged: false, rejected: false, unbound: false };
    let text: string;
    try {
      const path = join(dir, name);
      if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error("not a regular file");
      text = readFileSync(path, "utf8");
    } catch { gaps.push({ nativeSessionId, reason: "damaged" }); damaged.add(nativeSessionId); continue; }
    const seen = new Map<string, string>(), sequences = new Map<string, Set<number>>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: UsageObservation;
      try { record = JSON.parse(line); assertSchema(UsageObservationSchema, record, "usage observation"); } catch { flags.damaged = true; continue; }
      if (record.nativeSessionId !== nativeSessionId) { flags.damaged = true; continue; }
      const key = `${record.observerId}:${record.sequence}`, body = canonicalJson(record), prior = seen.get(key);
      if (prior !== undefined) { if (prior !== body) flags.damaged = true; continue; }
      seen.set(key, body);
      (sequences.get(record.observerId) ?? sequences.set(record.observerId, new Set()).get(record.observerId)!).add(record.sequence);
      if (!authorized(record, state)) { flags.rejected = true; continue; }
      if (record.assignments === null) { flags.unbound = true; continue; }
      const id = `child:${nativeSessionId}:${key}`, known = canonical.get(id), growth = Math.max(0, record.tokens - (known?.tokens ?? 0));
      // A rewritten row that renames the model, or a count the canonical aggregate cannot hold, is damage to this input, never a batch the core must refuse alongside unrelated usage.
      if (known !== undefined && known.model !== record.model || growth > headroom) { flags.damaged = true; continue; }
      headroom -= growth;
      sources.push({ id, complete: record.complete, tokens: record.tokens, costAmount: record.costAmount, model: record.model, observedAt: record.observedAt });
      for (const assignment of record.assignments) for (const work of assignment.work) {
        const entry = scope(assignment.actionId, work);
        entry.sessions.add(nativeSessionId); entry.count++; entry.observedAt = Math.max(entry.observedAt, record.observedAt);
      }
    }
    for (const observed of sequences.values()) if (Math.max(...observed) !== observed.size) flags.damaged = true;
    if (flags.damaged) damaged.add(nativeSessionId);
    for (const reason of ["damaged", "rejected", "unbound"] as const) if (flags[reason]) gaps.push({ nativeSessionId, reason });
  }
  const coverage: UsageCoverage[] = [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
    const broken = [...entry.sessions].some(session => damaged.has(session));
    // No new evidence for this scope: the canonical record stands, whether complete, partial or unknown.
    if (entry.prior && !entry.count && !broken) return entry.prior;
    const nativeSessionId = [...entry.sessions].sort().at(-1);
    const status = !entry.count && !broken ? "unknown" : broken || !entry.terminal ? "partial" : "complete";
    const reason = status === "unknown" ? "No usage observation for launched work" : broken ? "Observation input for this work is damaged" : !entry.terminal ? "Runtime owner not yet observed terminal" : `${entry.count} observed message(s) through owner termination`;
    return { id, actionId: entry.actionId, work: [entry.work], status, ...(nativeSessionId ? { nativeSessionId } : {}), reason, observedAt: Math.max(entry.observedAt, entry.prior?.observedAt ?? 0) || now };
  });
  return { sources, coverage, gaps };
}
