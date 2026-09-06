import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Settings } from "@oh-my-pi/pi-coding-agent";
// Public compatibility facade, resolved by OMP's file-loaded extension loader in the active session.
// The declaration in omp-compat.d.ts describes this host-provided public facade.
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox/type";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  toolApprovalScope, assertSchema, canonicalJson, digestJson, sha256Utf8, EngineInputSchema, InvocationRecordSchema,
  LimitsSchema, PolicyOverlaySchema, RecoveryChoiceSchema, JudgeOutputSchema, SeatRequestSchema, WorkRefSchema, RawWorkerOutputSchema, ReceiptSchema, RunSlugSchema, ToolProposalSchema, ToolGrantSchema,
  type ActionDraft, type ActionRecord, type ApprovalRecord, type EngineInput, type EvidenceRef, type GitOperationResult, type UsageSource,
  type InvocationRecord, type Limits, type PolicyOverlay, type Receipt, type ReceiptObservation,
  type RunRecord, type RecoveryChoice, type SeatRequest, type ToolDefinitionRecord,
} from "./contracts.ts";
import { selectNextAction, toolApprovalNeedsTui } from "./engine.ts";
import { closeWriter, createRun, openWriter, readRun, planStorageRepair, repairRunStorage, transact, type RunWriter } from "./store.ts";
import { captureBaseline, capturePatch, observeCode, selectReviewScope, createOutputBranch, integrateChecked, prepareCommitGroups, commitApproved, preparePush, pushConfirmed, GitPause, type BaselineRecord, type OwnershipRecord, type PatchEvidence } from "./git.ts";
import { activateChildGuard, deactivateChildGuard, observeChildGuard, validateWorkspaceBinding, type ChildGuardConfig } from "./child-guard.ts";
import { guardExtension, prepareWorkspace, routeWorkspaceOperation, captureWorkspace, revokeWorkspace, type WorkspaceBinding, type WorkspaceOperation } from "./workspace.ts";
import { observeChildUsage, prepareUsageMeter, readUsageObservations, releaseUsageMeter } from "./usage.ts";
import { renderDashboard } from "./dashboard.ts";
import { captureWorkerOutput, nativeName, normalizeNativeResult, probeCapabilities, readRuntimeSnapshot, receiptBase, reconcileRuntime, releaseSeatBindings, removeExtensionRoots, renderControlCell, resolveSeats, runtimeToolName, taskParameters, validateControlCall, type ControlCell, type SeatResolution } from "./omp.ts";
import { captureProposal, inspectProposal, readCapturedSource, validateGrant, PARENT_ACCESS, TOOL_POLICY_LIMIT } from "./tools.ts";
import { NextRequestSchema, nextExpression, issueControl, controlManifest, controlPage, controlResult, type IssuedControl } from "./control-delivery.ts";

export const COMMANDS = ["supership", "shipit", "ultraship", "ultrashipit", "superreview"] as const;
export interface Invocation { invocation: InvocationRecord; slug: string; resume: boolean; limits: Limits; seats: Record<string, string> }
function words(input: string): string[] {
  const result: string[] = []; let value = "", quote = "", started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === "\\" && quote !== "'") { if (++index >= input.length) throw new Error("Trailing argument escape."); value += input[index]; started = true; }
    else if (quote) { if (char === quote) quote = ""; else value += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { result.push(value); value = ""; started = false; } }
    else { value += char; started = true; }
  }
  if (quote) throw new Error("Unclosed argument quote.");
  if (started) result.push(value);
  return result;
}
export function parseInvocation(command: InvocationRecord["command"], raw: string): Invocation {
  const args = words(raw), intent: string[] = [], seats: Record<string, string> = {}, limits: Limits = {};
  let slug = "", resume = false;
  const invocation: InvocationRecord = { command, mode: command === "shipit" || command === "ultrashipit" ? "autonomous" : command === "superreview" ? "review-only" : "interactive", topology: command.startsWith("ultra") || command === "superreview" ? "crossreview" : "normal", intent: "", commitRequested: false, pushRequested: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { intent.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith("--")) { intent.push(arg); continue; }
    const equal = arg.indexOf("="), name = equal < 0 ? arg : arg.slice(0, equal);
    const value = () => { const next = equal < 0 ? args[++index] : arg.slice(equal + 1); if (!next || next.startsWith("--")) throw new Error(`${name} requires a value.`); return next; };
    if (name === "--commit" || name === "--push") { if (equal >= 0) throw new Error(`${name} takes no value.`); if (name === "--commit") invocation.commitRequested = true; else { invocation.pushRequested = true; invocation.commitRequested = true; } }
    else if (name === "--resume") { resume = true; if (equal >= 0 || (args[index + 1] && !args[index + 1]!.startsWith("--"))) slug = value(); }
    else if (name === "--slug") slug = value();
    else if (name === "--base") invocation.base = value();
    else if (name === "--branch") invocation.outputBranch = value();
    else if (name === "--topology") invocation.topology = value() as InvocationRecord["topology"];
    else if (name === "--seat") { const pair = value(), split = pair.indexOf("="); if (split < 1 || !pair.slice(split + 1)) throw new Error("--seat requires seat=model."); seats[pair.slice(0, split)] = pair.slice(split + 1); }
    else if (["--concurrency", "--tokens", "--wall-ms", "--review-rounds", "--cost"].includes(name)) {
      const number = Number(value());
      if (name === "--cost") limits.cost = { amount: number, currency: "USD" };
      else { const key = ({ "--concurrency": "concurrency", "--tokens": "tokens", "--wall-ms": "wallMs", "--review-rounds": "reviewRounds" } as const)[name as "--concurrency" | "--tokens" | "--wall-ms" | "--review-rounds"]; limits[key] = number; }
    } else throw new Error(`Unknown Supership flag ${name}.`);
  }
  invocation.intent = intent.join(" ");
  if (!slug) { if (resume) throw new Error("Resume requires --slug or --resume <slug>."); slug = `${invocation.intent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || command}-${randomUUID().slice(0, 8)}`; }
  assertSchema(RunSlugSchema, slug, "run slug"); assertSchema(InvocationRecordSchema, invocation, "invocation"); assertSchema(LimitsSchema, limits, "limits");
  if (command === "superreview" && invocation.topology === "normal") throw new Error("Superreview requires an ultra topology.");
  return { invocation, slug, resume, limits, seats };
}
export function defaultPolicy(): PolicyOverlay { return { schemaVersion: 1, seats: [], namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], phaseGates: [], pathRouting: [], instructionRefs: [] }; }
export async function loadPolicy(cwd: string): Promise<PolicyOverlay> {
  const policy = defaultPolicy();
  const roots = [process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".omp", "agent"), join(cwd, ".omp")];
  for (const root of roots) {
    let source: string;
    try { source = await readFile(join(root, "supership.json"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const parsed = JSON.parse(source); if (parsed.schemaVersion !== 1) throw new Error("Unsupported Supership policy version.");
    const overlay = { ...defaultPolicy(), ...parsed }; assertSchema(PolicyOverlaySchema, overlay, "repository policy");
    async function resolveRefs(value: unknown): Promise<void> {
      if (!value || typeof value !== "object") return;
      if ("kind" in value && value.kind === "file" && "uri" in value && typeof value.uri === "string") {
        const ref = value as EvidenceRef;
        const path = resolve(root, ref.uri);
        const bytes = await readFile(path);
        const digest = sha256Utf8(bytes.toString("utf8"));
        if (ref.digest && ref.digest !== digest) throw new Error("Policy evidence changed: " + path);
        Object.assign(ref, { kind: "artifact", uri: path, digest, availability: "available" });
        return;
      }
      for (const child of Object.values(value)) await resolveRefs(child);
    }
    await resolveRefs(overlay);
    for (const seat of overlay.seats) { const index = policy.seats.findIndex(item => item.seatId === seat.seatId); if (index < 0) policy.seats.push(seat); else policy.seats[index] = seat; }
    Object.assign(policy.limits, overlay.limits);
    for (const key of ["namedFallbackSeats", "verificationChecks", "phaseGates", "pathRouting", "instructionRefs"] as const) (policy[key] as unknown[]).push(...overlay[key]);
    policy.requiredLenses = [...new Set([...policy.requiredLenses, ...overlay.requiredLenses])];
    if (overlay.requiredVerification?.length) policy.requiredVerification = [...(policy.requiredVerification ?? []), ...overlay.requiredVerification];
  }
  assertSchema(PolicyOverlaySchema, policy); return policy;
}
const baseAgents: Record<string, string> = { scout: "scout", architect: "supership-architect", critic: "supership-critic", judge: "supership-judge", "judge-secondary": "supership-judge", correctness: "reviewer", simplicity: "reviewer", security: "security-reviewer", data: "reviewer", performance: "reviewer", ui: "reviewer", builder: "task", sonic: "sonic" };
export function requestedSeats(invocation: Invocation, policy: PolicyOverlay): SeatRequest[] {
  const required = invocation.invocation.mode === "review-only" ? ["correctness", "simplicity", "judge", "judge-secondary", "builder"] : ["scout", "architect", "builder", "correctness", "simplicity", "judge", ...(invocation.invocation.topology !== "normal" ? ["critic", "judge-secondary"] : [])];
  const names = [...new Set([...required, ...policy.seats.map(seat => seat.seatId), ...Object.keys(invocation.seats), ...policy.requiredLenses])];
  return names.map(seatId => { const request = policy.seats.find(seat => seat.seatId === seatId) ?? { seatId, agentName: baseAgents[seatId] ?? seatId }; return { ...request, ...(invocation.seats[seatId] ? { model: invocation.seats[seatId] } : {}) }; });
}

interface ActiveRun { state: RunRecord; writer: RunWriter; settings: Settings; seats: SeatResolution; ownership: OwnershipRecord; cells: Map<string, IssuedControl>; native: Map<string, unknown>; workspaces: Map<string,WorkspaceBinding>; capturedWorkspaces:Set<string>; scopeRevision:number; childRoots: string[]; restoreSettings: () => void; kernelToken: string; evalAction?: string; evalCallId?: string; evalExecuting?: string; allowedTurn: boolean }
interface PendingStart { invocation: Invocation; settings: Settings; nonce: string }
// Session-local runtime overrides for one run: verification commands must settle in the cell, native isolation must exist for
// worktree assignments, and native scratch must never auto-apply into the parent checkout. Restored exactly when the run releases.
const SESSION_OVERRIDES = { "bash.autoBackground.enabled": false, "task.isolation.enabled": true, "task.isolation.apply": false } as const;
// Every override here is Supership's own layer: release clears it, so the configuration current at that moment shows through instead of a copy captured at run start.
function scopeSettings(settings: Settings): () => void {
  for (const path of Object.keys(SESSION_OVERRIDES) as Array<keyof typeof SESSION_OVERRIDES>) settings.override(path, SESSION_OVERRIDES[path]);
  return () => { for (const path of [...Object.keys(SESSION_OVERRIDES), "task.maxConcurrency"] as Array<keyof typeof SESSION_OVERRIDES | "task.maxConcurrency">) settings.clearOverride(path); };
}
/** OMP's WorkPool and task tool read task.maxConcurrency live at each dispatch, so a lower run cap is enforced there, session-locally, never globally.
 * The real OMP ceiling is re-read beneath the run layer every time: a raised or removed run cap follows immediately and a user config change is never masked. */
function syncConcurrencyCap(settings: Settings, cap: number | undefined): number {
  settings.clearOverride("task.maxConcurrency");
  const ceiling = settings.get("task.maxConcurrency");
  if (cap !== undefined && (ceiling <= 0 || cap < ceiling)) settings.override("task.maxConcurrency", cap);
  return ceiling;
}
/** Run-local file evidence counts only while its exact bytes hash to the recorded digest; unknown, escaping, or non-regular paths never count. */
async function observeEvidenceBytes(runPath: string, ref: EvidenceRef): Promise<string> {
  if (ref.kind !== "file" || !ref.digest) return "unverifiable";
  const path = resolve(runPath, ref.uri);
  if (isAbsolute(ref.uri) || ref.uri.split(/[\\/]/).includes("..") || !path.startsWith(runPath + sep)) return "unsafe-path";
  let stats; try { stats = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  if (!stats.isFile()) return "not-a-regular-file";
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
/** Declared effects become an attributed patch; anything outside the declaration is kept as raw evidence and never attributed automatically. */
function attributeParentEffect(before: BaselineRecord, after: BaselineRecord, source: PatchEvidence["source"], declaredPaths: string[]): { declared: boolean; patch: PatchEvidence; undeclaredPaths: string[] } {
  try { return { declared: true, patch: capturePatch(before, after, source, declaredPaths), undeclaredPaths: [] }; }
  catch (error) {
    if (!(error instanceof GitPause) || !error.paths.length) throw error;
    return { declared: false, patch: capturePatch(before, after, source, [...declaredPaths, ...error.paths]), undeclaredPaths: error.paths };
  }
}
const PoolPeekSchema = Type.Object({batches:Type.Array(Type.Object({items:Type.Array(Type.String()),status:Type.String(),output:Type.String()}))});
const PoolStatusSchema = Type.Object({items:Type.Object({cancelled:Type.Integer({minimum:0})})});
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: canonicalJson(details) }], details });
const plain = (message: { content?: unknown }) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(block => block.type === "text" ? block.text : "").join("") : "";
const messageIdentity = (message: Record<string, unknown>) => digestJson(JSON.parse(JSON.stringify({ role: message.role, content: message.content ?? null, customType: message.customType ?? null, timestamp: typeof message.timestamp==="string"?Date.parse(message.timestamp):message.timestamp??null, toolCallId: message.toolCallId ?? null })));

export default function registerSupership(api: ExtensionAPI): void {
  // Children that rebind this factory never re-read settings.extensions: guard and meter them from here.
  observeChildGuard(api); observeChildUsage(api);
  let active: ActiveRun | undefined, pending: PendingStart | undefined, lastRun:{slug:string;path:string;lifecycle:string}|undefined;
  let commandTurn: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let pendingControl:string|undefined;
  async function sendControl(prompt: string) {
    const message=pending?.nonce===prompt?prompt:prompt+"\nSupership control turn "+randomUUID()+".";
    if(commandTurn){pendingControl=message;return commandTurn.promise;}
    const turn=Promise.withResolvers<void>();commandTurn=turn;
    try{api.sendUserMessage(message);await turn.promise;}finally{if(commandTurn===turn)commandTurn=undefined;}
  }
  api.on("agent_end",()=>{if(pendingControl){const message=pendingControl;pendingControl=undefined;api.sendUserMessage(message);}else{const turn=commandTurn;commandTurn=undefined;turn?.resolve();}});
  const workspaceCalls = new Map<string,{binding:WorkspaceBinding;route:ReturnType<typeof routeWorkspaceOperation>;before:BaselineRecord;parentBefore:BaselineRecord;release:()=>void}>();
  // ponytail: serialize parent I/O attribution; per-work locks only after parent-root effects can be separated.
  let parentCall = Promise.resolve();
  async function acquireParentCall() {
    const prior=parentCall,lock=Promise.withResolvers<void>(); parentCall=lock.promise;
    await prior; return lock.resolve;
  }
  const readInputs = new Map<string,string>();
  const callbacks = new Map<string, { before: BaselineRecord; action: ActionRecord; caller: { id: string; revision: number; attemptId: string }; definition: ToolDefinitionRecord; release:()=>void }>();
  let currentBoundary: { baseline?: string; empty: boolean; prompt: string } | undefined;
  const notifyError = (ctx: ExtensionContext, message: string) => { ctx.ui.notify(message, "error"); api.sendMessage({customType:"supership-diagnostic",content:message,display:true}); };
  const requireRun = () => { if (!active) throw new Error("No active Supership run. Start or resume through its slash command."); return active; };
  const persist = async (input: EngineInput, id: string = randomUUID()): Promise<RunRecord> => {
    const run = requireRun();
    const changed = await transact(run.writer, input, { now: Date.now(), inputId: id, ownerSessionId: run.writer.request.sessionId, ownerEpoch: run.state.owner.epoch });
    if (changed.kind === "rejected") throw new Error(`${changed.code}: ${changed.message}`);
    run.state = changed.state;
    await writeFile(join(run.writer.runPath, "plan.html"), renderDashboard(run.state, []), { mode: 0o600 });
    return run.state;
  };
  const evidence = async (name: string, content: unknown, summary: string, mediaType = "application/json"): Promise<EvidenceRef> => {
    const run = requireRun(), text = typeof content === "string" ? content : canonicalJson(JSON.parse(JSON.stringify(content))), id = `${name}-${randomUUID()}`, uri = `evidence/${id}.${mediaType === "application/json" ? "json" : "txt"}`;
    await mkdir(join(run.writer.runPath, "evidence"), { recursive: true, mode: 0o700 });
    const file=await open(join(run.writer.runPath,uri),"wx",0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}
    const directory=await open(join(run.writer.runPath,"evidence"),"r");try{await directory.sync();}finally{await directory.close();}
    return { id, kind: "file", uri, digest: sha256Utf8(text), mediaType, summary, availability: "available" };
  };
  async function observedCode(scopePaths=requireRun().state.plan?.scope.paths??[]) {
    const run=requireRun(),root=run.state.repository.root,observation=await observeCode(root,scopePaths,run.ownership.patches.filter(patch=>patch.source.kind==="parent-callback"));
    const ref=await evidence("git-observation",observation,"Actual Git identity, scope, and parent effect attribution.");return {...observation,evidence:[...observation.evidence,ref]};
  }
  /** Parent usage is every model call this session incurred since the run began; child usage arrives through the observer files. Native task aggregates are never added on top. */
  async function recordUsage(ctx: ExtensionContext) {
    const run = requireRun(), now = Date.now(), sources: UsageSource[] = [];
    const priced = (model: string) => { try { const rates = ctx.models.resolve(model)?.cost; return !!rates && Object.values(rates).some(rate => typeof rate === "number" && rate > 0); } catch { return false; } };
    const source = (id: string, provider: string, model: string, usage: { totalTokens: number; cost: { total: number } } | undefined, stopReason: string, observedAt: number) => {
      const name = `${provider}/${model}`.slice(0, 200), tokens = Number.isSafeInteger(usage?.totalTokens) && usage!.totalTokens >= 0 ? usage!.totalTokens : 0;
      const reported = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total > 0 ? usage.cost.total : null;
      sources.push({ id, complete: stopReason !== "error" && stopReason !== "aborted", tokens, costAmount: reported ?? (priced(name) ? 0 : null), model: name, observedAt: Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : now });
    };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.timestamp >= run.state.createdAt) source(`parent:${run.writer.request.sessionId}:${entry.id}`, entry.message.provider, entry.message.model, entry.message.usage, String(entry.message.stopReason), entry.message.timestamp);
      else if (entry.type === "model_usage" && Date.parse(entry.timestamp) >= run.state.createdAt) source(`parent:${run.writer.request.sessionId}:${entry.id}`, entry.provider, entry.model, entry.usage, String(entry.stopReason), Date.parse(entry.timestamp));
    }
    const observed = await readUsageObservations(run.writer.runPath, run.state, now);
    await persist({ kind: "record-source-usage", sources: [...sources, ...observed.sources], coverage: observed.coverage });
  }
  /** Installs the run-bound guard and usage roots for every managed child route before any spawn. */
  async function bindChildren() {
    const run = requireRun(), parentSessionId = run.writer.request.sessionId;
    const config: ChildGuardConfig = { schemaVersion: 1, runPath: run.writer.runPath, runId: run.state.runId, repositoryRoot: run.state.repository.root, parentSessionId, ownerEpoch: run.state.owner.epoch };
    const guard = guardExtension(config), meter = await prepareUsageMeter({ runPath: run.writer.runPath, runId: run.state.runId, parentSessionId, ownerEpoch: run.state.owner.epoch });
    activateChildGuard(config);
    run.childRoots = [guard.extensionRoot, meter.extensionRoot];
    run.settings.override("extensions", [...new Set([...run.settings.get("extensions"), ...run.childRoots])]);
  }
  const pause = async (reason: string, ctx: ExtensionContext) => {
    const run = requireRun();
    await persist({ kind: "request-pause", recovery: { scope: "run", intent: "resume", primaryReason: reason, triggers: [reason], affectedWork: run.state.work.filter(work => work.status === "running" || work.status === "awaiting-recovery").map(work => ({ id: work.id, revision: work.revision })), unresolvedOwners: run.state.work.flatMap(work => work.runtimeOwners).filter(owner => owner.status !== "observed-terminal"), resumePhase: run.state.phase, requiredChoices: ["inspect", "continue", "stop"], evidence: [] } });
    ctx.ui.notify(reason, "warning");
  };
  const approval = async (ctx: ExtensionContext, kind: ApprovalRecord["kind"], scopeHash: string, description: string, toolVersions: ApprovalRecord["toolVersions"] = [], forceTui = false): Promise<ApprovalRecord> => {
    const run = requireRun();
    const autonomous = !forceTui && run.state.invocation.mode === "autonomous" && ["initial-plan", "material-amendment", "fast-path", "tool"].includes(kind);
    if (!autonomous && (!ctx.hasUI || ctx.mode !== "tui")) throw new Error(`${kind} requires trusted OMP TUI confirmation. Resume this run in the TUI.`);
    const approved = autonomous || await ctx.ui.confirm(`Supership ${kind}`, description);
    return { id: randomUUID(), kind, decision: approved ? "approve" : "decline", authority: autonomous ? "autonomous-policy" : "omp-tui", scopeHash, planRevision: run.state.planRevision, toolVersions, ownerEpoch: run.state.owner.epoch, createdAt: Date.now(), rationale: autonomous ? "Autonomous run policy; native OMP tool approvals still apply." : approved ? "Confirmed through the OMP TUI." : "Declined through the OMP TUI.", evidence: [] };
  };
  const release = async () => {
    if (!active) return;
    const sessionId = active.writer.request.sessionId;
    releaseSeatBindings(active.settings, active.seats);
    removeExtensionRoots(active.settings, [...[...active.workspaces.values()].map(binding => binding.extensionRoot), ...active.childRoots]);
    for (const binding of active.workspaces.values()) revokeWorkspace(binding);
    deactivateChildGuard(sessionId); releaseUsageMeter(sessionId); active.restoreSettings();
    await closeWriter(active.writer);
    lastRun = { slug: active.state.slug, path: active.writer.runPath, lifecycle: active.state.lifecycle }; active = undefined;
    releaseParentCalls();
  };
  /** Every pending parent callback lock is released; the affected invocations stay uncertain in the run record. */
  function releaseParentCalls() {
    for (const call of callbacks.values()) call.release();
    for (const call of workspaceCalls.values()) call.release();
    callbacks.clear(); workspaceCalls.clear();
  }
  /** A passed verification record proves nothing after resume unless every run-local artifact still has its recorded bytes; stale records are invalidated canonically before any action. */
  async function auditVerificationEvidence() {
    const run = requireRun(), stale: Array<{ verificationId: string; evidenceId: string; uri: string; recorded: string | null; observed: string }> = [];
    for (const record of run.state.verification.filter(record => record.outcome === "passed")) for (const ref of record.evidence) {
      const observed = await observeEvidenceBytes(run.writer.runPath, ref);
      if (observed !== ref.digest) stale.push({ verificationId: record.id, evidenceId: ref.id, uri: ref.uri, recorded: ref.digest ?? null, observed });
    }
    if (!stale.length) return;
    const ref = await evidence("verification-evidence-audit", stale, "Run-local verification artifacts whose bytes are missing, changed, or unsafe to read; the records they supported are no longer proof.");
    await persist({ kind: "invalidate-verification", ids: [...new Set(stale.map(item => item.verificationId))], reason: "Persisted verification evidence is missing or changed since it was recorded", evidence: [ref] });
  }
  async function begin(start: PendingStart, ctx: ExtensionContext) {
    if (active) throw new Error("This session already owns a Supership run.");
    const settings = start.settings;
    const capability = await probeCapabilities(api, ctx, settings, "disabled");
    if (!capability.supported) throw new Error(capability.checks.filter(check => !check.available).map(check => `${check.name}: expected ${check.expected}, observed ${check.observed}${check.evidence.length ? ` (${check.evidence.join("; ")})` : ""}`).join("\n"));
    const policy = await loadPolicy(ctx.cwd), sessionId = ctx.sessionManager.getSessionId(), invocation = start.invocation;
    const baseline = await captureBaseline(ctx.cwd), path = join(baseline.repo, ".planning", invocation.slug);
    if (invocation.resume) {
      let loaded:Awaited<ReturnType<typeof readRun>>|undefined;
      try{loaded=await readRun(path);}catch(error){if(!ctx.hasUI||ctx.mode!=="tui")throw error;}
      if(!loaded?.writable){
        const repair=await planStorageRepair(path);
        if(!ctx.hasUI||ctx.mode!=="tui")throw new Error("Stored run needs explicit recovery through the OMP TUI or supership recover.");
        if(!await ctx.ui.confirm("Supership storage recovery","CAUTION: Recovery preserves the original bytes, then changes these exact run files.\n"+canonicalJson(repair)))throw new Error("Storage recovery declined; original files remain unchanged.");
        const confirmed:ApprovalRecord={id:randomUUID(),kind:"recovery",decision:"approve",authority:"omp-tui",scopeHash:repair.digest,planRevision:loaded?.state.planRevision??0,toolVersions:[],ownerEpoch:repair.ownerEpoch,createdAt:Date.now(),rationale:"Confirmed exact storage repair and preserved destination through OMP TUI.",evidence:[]};
        const repaired=await repairRunStorage(repair,{approval:confirmed,reviewedPlanHash:repair.digest});
        if(repaired.kind==="orphan-preserved")throw new Error("Interrupted startup preserved at "+repaired.preservedPath+". Start a new run explicitly; no worker was replayed.");
        loaded=await readRun(path);
      }
      const requests = loaded.state.seats.map(seat => ({ seatId: seat.seatId, agentName: seat.baseAgent, ...(seat.requestedModel ? {model:seat.requestedModel} : {}), ...(seat.source.kind === "explicit" ? { sourcePath: seat.source.path } : {}) }));
      const seats = await resolveSeats(ctx, settings, requests, loaded.state.runId, loaded.state.kernelGeneration, loaded.state.policy.namedFallbackSeats);
      let writer: RunWriter;
      try { writer = await openWriter(path, { sessionId, expectedEpoch: loaded.state.owner.epoch, purpose: "resume" }); } catch (error) { releaseSeatBindings(settings, seats); throw error; }
      const ownership = JSON.parse(await readFile(join(path, "ownership.json"), "utf8")) as OwnershipRecord;
      active = { state: loaded.state, writer, settings, seats, ownership, cells: new Map(), native: new Map(), workspaces:new Map(), capturedWorkspaces:new Set(), scopeRevision:-1, childRoots: [], restoreSettings: scopeSettings(settings), kernelToken: randomUUID(), allowedTurn: true };
      await persist({ kind: "resume", sessionId, leaseId: writer.leaseId, reconciliation: reconcileRuntime(loaded.state, readRuntimeSnapshot(ctx, loaded.state, syncConcurrencyCap(settings, loaded.state.limits.concurrency))) });
      await auditVerificationEvidence();
      await restoreWorkspaces();
      await persist({kind:"record-seat-bindings",seats:seats.bindings,evidence:[]});
      if (Object.keys(invocation.limits).length) await persist({kind:"configure-limits",limits:{...active.state.limits,...invocation.limits},rationale:"Explicit trusted resume command limits."});
      await persist({ kind: "record-kernel-generation", generation: active.state.kernelGeneration + 1, reason: "Explicit resume requires fresh parent kernel registrations; captured source is never replayed.", evidence: [] });
      await bindChildren();
      if (invocation.invocation.intent) await recordInstruction(invocation.invocation.intent, ctx);
      return;
    }
    const limits = { ...policy.limits, ...invocation.limits };
    if (invocation.invocation.mode === "interactive") {
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Interactive Supership requires the OMP TUI for its interview and limits. Use /shipit for autonomous mode.");
      const answer = await ctx.ui.input("Supership: goal, exclusions, acceptance checks, and risks", invocation.invocation.intent);
      if (answer === undefined) throw new Error("Supership interview cancelled before run creation.");
      invocation.invocation.intent = answer;
      const unspecified = ["concurrency", "tokens", "cost", "wallMs", "reviewRounds"].filter(key => !Object.hasOwn(limits, key));
      if (unspecified.length) {
        const ceiling = settings.get("task.maxConcurrency"), recommendation = { concurrency: ceiling > 0 ? Math.min(2, ceiling) : 2, reviewRounds: invocation.invocation.intent.length > 300 ? 4 : 3 };
        const chosen = await ctx.ui.input(`Optional limits (${unspecified.join(", ")}). Recommendation ${canonicalJson(recommendation)}: concurrency from the OMP ceiling (${ceiling > 0 ? ceiling : "unlimited"}), reviewRounds a fixed policy cap, not an estimate. tokens, cost, wallMs: unlimited, no credible estimate exists before research and scope. {} keeps every limit unset. Unknown pricing stays unknown.`, "{}");
        if (chosen === undefined) throw new Error("Limits interview cancelled before run creation.");
        const extra = JSON.parse(chosen); assertSchema(LimitsSchema, extra); Object.assign(limits, extra);
      }
    }
    assertSchema(LimitsSchema, limits);
    const seats = await resolveSeats(ctx, settings, requestedSeats(invocation, policy), randomUUID(), 0, policy.namedFallbackSeats);
    let writer: RunWriter;
    try { writer = await openWriter(path, { sessionId, purpose: "start" }); } catch (error) { releaseSeatBindings(settings, seats); throw error; }
    const baselineText = canonicalJson(baseline), baselineRef: EvidenceRef = { id: "baseline", kind: "file", uri: "baseline.json", digest: sha256Utf8(baselineText), mediaType: "application/json", summary: "User-owned tracked, staged, unstaged, and untracked baseline bytes.", availability: "available" };
    await writeFile(join(path, "baseline.json"), baselineText, { flag: "wx", mode: 0o600 });
    const repository = { root: baseline.repo, gitDir: baseline.gitDir, commonDir: baseline.commonDir, initialHead: baseline.identity.head, baselineRef, baselineDigest: digestJson(baseline) };
    const preflight = { schemaVersion: 1 as const, observedVersion: capability.observedVersion, checks: capability.checks.map(check => ({ name: check.name, passed: check.available, expected: check.expected, observed: check.observed, evidence: [] })), repository, planMode: false as const, ownerAvailable: true as const, ignoreVerified: true as const, seats: seats.bindings };
    const created = await createRun(writer, { kind: "start", start: { schemaVersion: 1, runId: randomUUID(), slug: invocation.slug, owner: { sessionId, epoch: 0, leaseId: writer.leaseId }, repository, invocation: invocation.invocation, seats: seats.bindings, limits, policy, preflight, clarificationCompleted: invocation.invocation.mode === "interactive" } }, preflight);
    if (created.kind === "rejected") { releaseSeatBindings(settings, seats); await closeWriter(writer); throw new Error(created.message); }
    active = { state: created.state, writer, settings, seats, ownership: { baseline, patches: [] }, cells: new Map(), native: new Map(), workspaces:new Map(), capturedWorkspaces:new Set(), scopeRevision:0, childRoots: [], restoreSettings: scopeSettings(settings), kernelToken: randomUUID(), allowedTurn: true };
    await writeFile(join(path, "ownership.json"), canonicalJson(active.ownership), { flag: "wx", mode: 0o600 });
    await bindChildren();
    await persist({ kind: "record-git-observation", observation: await observedCode([]) });
    if (invocation.invocation.mode === "review-only") await evidence("review-scope", await selectReviewScope(baseline.repo, invocation.invocation.base), "Exact review-only Git scope.");
  }
  async function recordInstruction(text: string, ctx: ExtensionContext) {
    const run = requireRun(), ref = await evidence("instruction", text, "User instruction", "text/plain");
    const paths = [...new Set(run.state.work.flatMap(work => work.expectedPaths).filter(path => text.includes(path)))];
    const affected = run.state.work.filter(work => work.expectedPaths.some(path => paths.includes(path)));
    await persist({ kind: "record-instruction", instruction: { id: randomUUID(), receivedAt: Date.now(), textRef: ref, summary: text.slice(0, 2000), affectedWork: affected.map(work => ({ id: work.id, revision: work.revision })), classification: /delete|credential|production|publish|force.push/i.test(text) ? "safety" : "material", status: "pending-boundary", evidence: [ref] } });
    ctx.ui.notify("Instruction recorded. The engine applies it at a safe boundary; unrelated workers continue.", "info");
  }
  function boundaryBaseline(ctx: ExtensionContext): { baseline?: string; empty: boolean } {
    const entries = ctx.sessionManager.getBranch();
    const entry = entries.findLast(entry => entry.type === "message" || entry.type === "custom_message");
    if (!entry) return { empty: true };
    if (entry.type === "message") return { baseline: messageIdentity(entry.message as unknown as Record<string, unknown>), empty: false };
    if (entry.type === "custom_message") return { baseline: messageIdentity({ role: "custom", customType: entry.customType, content: entry.content, timestamp: entry.timestamp }), empty: false };
    return { empty: false };
  }
  api.on("before_agent_start", (event, ctx) => { if (pending || active) { currentBoundary = { ...boundaryBaseline(ctx), prompt: event.prompt }; if (active) active.allowedTurn = false; } });
  api.on("context", async (event, ctx) => {
    if (!currentBoundary) return;
    const boundary = currentBoundary; currentBoundary = undefined;
    const messages = event.messages as unknown as Array<Record<string, unknown>>;
    const users = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "user" && plain(message) === boundary.prompt);
    const user = users.at(-1)?.index;
    const matches = boundary.baseline ? messages.map((message, index) => ({ message, index })).filter(({ message }) => messageIdentity(message) === boundary.baseline) : [];
    const before = boundary.empty ? -1 : matches.length === 1 ? matches[0]!.index : undefined;
    const known = users.length === 1 && user !== undefined && before !== undefined && user > before;
    const plan = known && messages.slice(before! + 1, user).some(message => message.role === "custom" && message.customType === "plan-mode-context");
    if (!known || plan) {
      const reason = plan ? "Supership refuses OMP Plan Mode. Exit Plan Mode and start or resume again." : "Supership cannot verify the fresh native mode boundary. Retry from a new user turn.";
      pending = undefined; if (active) { active.allowedTurn = false; await pause(reason, ctx); } else notifyError(ctx, reason);
      return;
    }
    if (pending) {
      const start = pending;
      if (boundary.prompt !== start.nonce) { pending = undefined; notifyError(ctx, "Supership preflight nonce changed; no run was created."); return; }
      pending = undefined;
      try { await begin(start, ctx); } catch (error) { notifyError(ctx, String(error)); return; }
    }
    if (active) active.allowedTurn = true;
  });
  for (const command of COMMANDS) api.registerCommand(command, { description: `Supership ${command} workflow`, async handler(raw, ctx) {
    if (active) {
      if(["completed","cancelled"].includes(active.state.lifecycle) && ["status","continue","cancel"].includes(raw.trim())) {ctx.ui.notify(active.state.slug+": "+active.state.lifecycle+". "+active.writer.runPath+"/plan.html. Nothing restarts.","info");return;}
      if (raw.trim() === "cancel") {
        const release = await acquireParentCall();
        try {
          if (!active || ["completed", "cancelled"].includes(active.state.lifecycle)) return;
          await persist({ kind: "request-cancel", reason: "User cancellation", evidence: [] });
        } finally { release(); }
        await sendControl("Use supership_next and execute only its exact cancellation control cell.");
        return;
      }
      if (raw.trim() === "status") { ctx.ui.notify(`${active.state.slug}: ${active.state.phase}/${active.state.lifecycle}. ${active.writer.runPath}/plan.html`, "info"); return; }
      if (raw.trim() === "continue") { await sendControl("Continue Supership through supership_next. Do not repeat an already consumed control cell."); return; }
      throw new Error("One active Supership run per session. Use status, continue, or cancel; resume only after releasing the prior run.");
    }
    if(["status","continue","cancel"].includes(raw.trim())) {ctx.ui.notify(lastRun?lastRun.slug+": "+lastRun.lifecycle+". "+lastRun.path+"/plan.html. No run restarts; use an explicit start or resume command.":"No active Supership run. Start or resume explicitly.","info");return;}
    if (pending) throw new Error("A Supership startup preflight is already pending.");
    const invocation = parseInvocation(command, raw), nonce = `Supership preflight ${randomUUID()}. After the extension validates startup, call supership_next (through eval only as display(await tool.supership_next({})); with timeout:0). Follow each exact next expression in a separate eval/display until next is null. Concatenate the ordered page code strings without separators, then execute that original JavaScript with timeout:0. Never edit the code or approve through tools or HTML.`;
    pending = { invocation, settings: await SettingsManager.create(ctx.cwd), nonce };
    try { await sendControl(nonce); } catch (error) { pending = undefined; throw error; }
  } });
  // An instruction supersedes work and changes the engine's selection, so it commits only between draft/issue windows and callback effects.
  api.on("input", async (event, ctx) => { if (active && event.source !== "extension" && !event.text.startsWith("/")) { const release = await acquireParentCall(); try { if (active) await recordInstruction(event.text, ctx); } finally { release(); } } });

  async function restoreWorkspaces() {
    const run=requireRun();let names:string[];
    try {names=await readdir(join(run.writer.runPath,"worktrees"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT" && !run.state.worktrees.length)return;throw error;}
    for(const name of names.filter(name=>/^[a-f0-9]{64}$/.test(name))) {
      let binding:WorkspaceBinding;try{binding=JSON.parse(await readFile(join(run.writer.runPath,"worktrees",name,"manifest.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT" && !run.state.worktrees.some(tree=>tree.path===join(run.writer.runPath,"worktrees",name,"checkout")))continue;throw error;}
      validateWorkspaceBinding(binding,false);
      if(binding.runId!==run.state.runId || binding.runPath!==run.writer.runPath || binding.repositoryRoot!==run.state.repository.root)throw new Error("Retained workspace belongs to another run.");
      const action=run.state.actions.find(action=>action.id===binding.actionId);if(!action)continue;
      if(action.ownerEpoch!==binding.ownerEpoch || !action.recipients.some(recipient=>recipient.workId===binding.work.id && recipient.workRevision===binding.work.revision && recipient.attemptId===binding.work.attemptId))throw new Error("Retained workspace has no matching issued recipient.");
      revokeWorkspace(binding);run.workspaces.set(binding.work.attemptId,binding);
    }
  }
  async function captureFinishedWork() {
    const run=requireRun();
    for(const binding of run.workspaces.values()) {
      const work=run.state.work.find(work=>work.id===binding.work.id && work.revision===binding.work.revision && work.attempt.id===binding.work.attemptId);
      if(!work || !["succeeded","superseded","cancelled","awaiting-recovery"].includes(work.status) || work.status!=="succeeded" && (!work.runtimeOwners.length || work.runtimeOwners.some(owner=>owner.status!=="observed-terminal")) || run.capturedWorkspaces.has(binding.work.attemptId)) continue;
      if(work.mutation!=="read-only") {
        const captured=await captureWorkspace(binding),ref=await evidence("workspace-patch",captured.patch,"Observed retained workspace output; native scratch patch is not code authority.");
        if(binding.isolationKind==="worktree" && !run.state.patches.some(patch=>digestJson(patch.work)===digestJson(binding.work))) {
          await persist({kind:"record-patch",patch:{schemaVersion:1,work:binding.work,actionId:binding.actionId,patchRef:ref,before:captured.before.identity,changedPaths:captured.patch.changes.map(change=>change.path),ownershipEvidence:[ref]},observation:{kind:"runtime-confirmed",toolCallId:"workspace-capture:"+binding.work.attemptId,evidence:[ref]}});
        } else if(binding.isolationKind==="active-checkout" && captured.patch.changes.length>0 && !run.ownership.patches.some(patch=>patch.digest===captured.patch.digest)) {
          run.ownership.patches.push(captured.patch);await writeFile(join(run.writer.runPath,"ownership.json"),canonicalJson(run.ownership),{mode:0o600});
          await persist({kind:"record-git-observation",observation:await observedCode(run.state.plan?.scope.paths??[])});
        }
      }
      revokeWorkspace(binding);run.capturedWorkspaces.add(binding.work.attemptId);
    }
  }
  async function claim(action: ActionRecord, callId: string) {
    await persist({ kind: "claim-action", actionId: action.id, expectedStateRevision: action.expectedStateRevision, toolCallId: callId, inputHash: action.inputHash, ...(action.programHash ? { programHash: action.programHash } : {}) });
    const run=requireRun();
    for(const binding of run.workspaces.values()) if(binding.actionId===action.id && binding.isolationKind==="worktree") {
      const ref=await evidence("workspace-created",binding,"Runtime-created retained builder checkout; native isolation is disposable scratch.");
      await persist({kind:"record-worktree",worktree:{schemaVersion:1,runId:run.state.runId,path:binding.path,actionId:action.id,work:binding.work,createdAt:binding.createdAt,evidence:[ref]},observation:{kind:"runtime-confirmed",toolCallId:"workspace-setup:"+action.id,verifiedProgramHash:action.programHash,evidence:[ref]}});
    }
  }
  /** A GitPause is the operation's own refusal (ambiguous hunk, changed code, missing remote): it settles the action as a failure so the engine opens its inspect/adopt/retry/discard/stop recovery, never as an unhandled error. */
  async function trustedAction(action: ActionRecord, ctx: ExtensionContext) {
    try { await performTrusted(action, ctx); }
    catch (error) {
      if (!(error instanceof GitPause) || !["claimed", "running"].includes(requireRun().state.actions.find(item => item.id === action.id)?.status ?? "")) throw error;
      const ref = await evidence("git-pause", { actionId: action.id, operation: action.input.kind, message: error.message, paths: error.paths }, "Git operation paused before any mutation; the named paths need inspection.");
      await persist({ kind: "settle-action", actionId: action.id, result: { kind: "failure", diagnostic: { code: "git-pause", message: error.message, ...(error.paths[0] ? { path: error.paths[0] } : {}), severity: "error", evidence: [ref] }, evidence: [ref] } });
      ctx.ui.notify(error.message, "warning");
    }
  }
  async function performTrusted(action: ActionRecord, ctx: ExtensionContext) {
    const run = requireRun(); await claim(action, `trusted-${randomUUID()}`);
    const settle = async (refs: EvidenceRef[] = [], output?: GitOperationResult) => persist({ kind: "settle-action", actionId: action.id, result: { kind: "success", evidence: refs, ...(output ? {output} : {}) } });
    const input = action.input;
    if (input.kind === "collect_input") {
      if (input.request.kind === "clarification") {
        if (!ctx.hasUI || ctx.mode !== "tui") { await pause("Clarification requires the OMP TUI.", ctx); return; }
        const answer = await ctx.ui.input(input.request.prompt);
        if (answer === undefined) { await pause("Clarification cancelled.", ctx); return; }
        const ref = await evidence("clarification", answer, "Trusted TUI clarification", "text/plain"); await persist({ kind: "resolve-input", actionId: action.id, answer, evidence: [ref] }); return;
      }
      if (input.request.kind === "recovery") {
        if(!ctx.hasUI||ctx.mode!=="tui"){ctx.ui.notify((run.state.recovery?.primaryReason??input.request.prompt)+". Resume in the OMP TUI for the required decision.","warning");return;}
        const selected=await ctx.ui.select(input.request.prompt,input.request.choices);
        if(!selected){ctx.ui.notify("Recovery decision cancelled; the original pause remains.","warning");return;}
        const kind=selected.toLowerCase().split(/[ :]/)[0]!;
        const runtime=reconcileRuntime(run.state,readRuntimeSnapshot(ctx,run.state,syncConcurrencyCap(run.settings,run.state.limits.concurrency)));
        const retained=[];for(const binding of run.workspaces.values()){const captured=await captureWorkspace(binding);retained.push({work:binding.work,path:binding.path,before:captured.before.identity,after:captured.after.identity,patchRef:await evidence("recovery-workspace",captured.patch,"Observed retained code for explicit recovery; no mutation replay.")});}
        const inspection=await evidence("recovery-inspection",{runtime,retained,tools:run.state.toolInvocations,recovery:run.state.recovery},"Current runtime, retained code, and unresolved parent callbacks.");
        if(kind==="inspect"){ctx.ui.notify(inspection.uri+"\n"+canonicalJson({runtime,retained,tools:run.state.toolInvocations}),"info");await settle([inspection]);return;}
        if(kind==="resolve-judges"){
          const round=run.state.reviewRounds.at(-1);if(!round)throw new Error("No review round exists to resolve.");
          const text=await ctx.ui.input("JSON verdicts for every disputed finding. Inspect "+inspection.uri+" and the read-only dashboard.");if(text===undefined)return;
          const decisions=JSON.parse(text);assertSchema(JudgeOutputSchema.properties.verdicts,decisions);
          const approved=await approval(ctx,"judge-disagreement",digestJson({round:round.round,decisions}),canonicalJson({round:round.round,decisions}),[],true);if(approved.decision!=="approve")return;
          await persist({kind:"resolve-judges",round:round.round,decisions,approval:approved});await settle([inspection]);return;
        }
        if(kind==="override-stall"){
          const rationale=await ctx.ui.input("Why can another round make progress? A non-empty rationale is required.");if(!rationale?.trim())return;
          const text=await ctx.ui.input("JSON reviewer seat IDs in mandatory-lens order; [] keeps the same seats.","[]");if(text===undefined)return;const newSeatIds=JSON.parse(text);assertSchema(Type.Array(Type.String({minLength:1})),newSeatIds);
          const scope={round:run.state.reviewRounds.at(-1)?.round,newSeatIds};if(!scope.round)throw new Error("No stalled review round exists.");
          const approved=await approval(ctx,"stall-override",digestJson(scope),rationale+"\n"+canonicalJson(scope),[],true);if(approved.decision!=="approve")return;approved.rationale=rationale;
          await persist({kind:"override-stall",newSeatIds,approval:approved});await settle([inspection]);return;
        }
        if(kind==="repair-seat"){
          const text=await ctx.ui.input("JSON logical seat requests to add. Each needs seatId and agentName; model and sourcePath are optional.");if(text===undefined)return;
          const requests=JSON.parse(text);assertSchema(Type.Array(SeatRequestSchema,{minItems:1}),requests);
          if(requests.some(request=>run.state.seats.some(seat=>seat.seatId===request.seatId)))throw new Error("Existing binding evidence cannot be replaced. Add the missing logical seat or an explicitly named fallback.");
          const added=await resolveSeats(ctx,run.settings,requests,run.state.runId,run.state.kernelGeneration,run.state.policy.namedFallbackSeats),seats=[...run.state.seats,...added.bindings];
          const approved=await approval(ctx,"recovery",digestJson({seats}),canonicalJson(seats),[],true);if(approved.decision!=="approve"){releaseSeatBindings(run.settings,added);return;}
          const ref=await evidence("seat-repair",seats,"Resolved public definitions and authenticated logical seats.");await persist({kind:"repair-seat-bindings",seats,approval:approved,evidence:[ref]});run.seats.bindings=seats;await settle([inspection,ref]);return;
        }
        const choice:RecoveryChoice={kind:kind as RecoveryChoice["kind"],affectedWork:run.state.recovery?.affectedWork??[],reason:selected};
        if(kind==="adopt"){
          choice.adoptions=[];
          for(const ref of choice.affectedWork){const work=run.state.work.find(work=>work.id===ref.id&&work.revision===ref.revision)!;let output=work.result;
            if(!output){const text=await ctx.ui.input("Paste the inspected worker JSON result for "+work.id+". This is explicit adoption, never a worker rerun.");if(text===undefined)return;output=await captureWorkerOutput(JSON.parse(text),proposal=>captureProposal(proposal,{runPath:run.writer.runPath,existingNames:api.getAllTools().map(tool=>tool.name)}));}
            const outputRef=await evidence("adopted-output",output,"Exact result explicitly inspected for adoption.");choice.adoptions.push({work:{id:work.id,revision:work.revision,attemptId:work.attempt.id},output,effectEvidence:[inspection,outputRef,...retained.filter(item=>item.work.attemptId===work.attempt.id).map(item=>item.patchRef)]});
          }
        }
        if(kind==="recreate-tool"||kind==="reproposal"){
          const text=await ctx.ui.input("Paste fresh literal tool proposals as a JSON array. Recorded source is never evaluated or prefilled.");if(text===undefined)return;const proposals=JSON.parse(text);assertSchema(Type.Array(ToolProposalSchema,{minItems:1}),proposals);
          choice.toolProposals=await Promise.all(proposals.map(proposal=>captureProposal(proposal,{runPath:run.writer.runPath,existingNames:api.getAllTools().map(tool=>tool.name)})));
        }
        if(kind==="continue"&&run.state.recovery?.triggers.some(trigger=>["token-cap","wall-time-cap","cost-cap","review-round-cap"].includes(trigger))){
          const text=await ctx.ui.input("New exact limits. {} removes Supership caps but never the OMP concurrency ceiling.",canonicalJson(run.state.limits));if(text===undefined)return;const limits=JSON.parse(text);assertSchema(LimitsSchema,limits);await persist({kind:"configure-limits",limits,rationale:"Explicit trusted recovery limits."});
        }
        // Every running/uncertain parent callback needs a trusted disposition; the engine refuses adopt/retry/discard/continue while one is pending.
        // For the affected work's own callbacks the chosen work disposition is that decision (adopt keeps the inspected bytes, retry/discard disown them);
        // any other pending callback, and every one under continue, is decided explicitly.
        const pendingInvocations=run.state.toolInvocations.filter(invocation=>["running","uncertain"].includes(invocation.outcome));
        if(kind!=="stop"&&pendingInvocations.length){
          const inspectedGit=await observedCode();choice.toolResults=[];
          for(const invocation of pendingInvocations){
            const affected=kind!=="continue"&&choice.affectedWork.some(ref=>ref.id===invocation.caller.id&&ref.revision===invocation.caller.revision);
            let outcome:"success"|"failed";
            if(affected) outcome=kind==="adopt"?"success":"failed";
            else {
              const undeclared=invocation.evidence.filter(ref=>/undeclared/.test(ref.id)).map(ref=>ref.uri);
              const selected=await ctx.ui.select(`Parent callback ${invocation.name}@${invocation.version} by ${invocation.caller.id} is ${invocation.outcome}${undeclared.length?`; it changed paths outside its declared effects (${undeclared.join(", ")})`:""}. Inspect ${inspection.uri} and decide its actual effect. No callback is re-run.`,["success: the observed parent effects are the intended, attributable output","failed: the observed parent effects are not attributable output"]);
              if(!selected)return;
              outcome=selected.startsWith("success")?"success":"failed";
            }
            choice.toolResults.push({id:invocation.id,outcome,parentAfter:inspectedGit.identity,evidence:[inspection,...inspectedGit.evidence]});
          }
        }
        assertSchema(RecoveryChoiceSchema,choice);
        // The dialog shows the decision and the run-local files it rests on; the exact choice bytes are bound through scopeHash and the persisted approval.
        const shown={affectedWork:choice.affectedWork,...(choice.adoptions?{adoptions:choice.adoptions.map(adoption=>({work:adoption.work,outcome:adoption.output.kind==="build"?adoption.output.outcome:adoption.output.kind,effectEvidence:adoption.effectEvidence.map(ref=>ref.uri)}))}:{}),...(choice.toolProposals?{toolProposals:choice.toolProposals.map(proposal=>proposal.name)}:{}),...(choice.toolResults?{toolResults:choice.toolResults.map(result=>({id:result.id,outcome:result.outcome}))}:{})};
        const approved=await approval(ctx,"recovery",digestJson(choice),canonicalJson({kind:choice.kind,reason:choice.reason})+"\n"+canonicalJson(shown)+"\nExact choice digest "+digestJson(choice)+". Inspect "+inspection.uri+" before confirming; unresolved owners never count as complete.",[],true);if(approved.decision!=="approve")return;
        await persist({kind:"resolve-recovery",choice,approval:approved,evidence:{writerExclusive:!run.writer.closed,runtime,git:await observedCode(),evidence:[inspection,...retained.map(item=>item.patchRef)]}});
        // The engine settles every open control action inside resolve-recovery; a second settlement is rejected as stale.
        if(["claimed","running"].includes(run.state.actions.find(item=>item.id===action.id)?.status??""))await settle([inspection]);
        return;
      }
      const matchingTool = run.state.tools.find(tool => tool.approvalScopeHash === input.scopeHash && tool.registration === "proposed");
      const kind = input.request.approvalKind ?? (input.request.id === "push" ? "push" : matchingTool ? "tool" : /fast.path/i.test(input.request.id) ? "fast-path" : /safety/i.test(input.request.id) ? "safety" : /disagreement/i.test(input.request.id) ? "judge-disagreement" : /stall/i.test(input.request.id) ? "stall-override" : run.state.approvals.some(approval => approval.kind === "initial-plan") ? "material-amendment" : "initial-plan");
      const description = kind === "push" ? `CAUTION: This publishes commits.\n${canonicalJson(run.state.pushTarget)}` : matchingTool ? `${input.request.prompt}\n${await readCapturedSource(run.writer.runPath, matchingTool)}\nSchema ${canonicalJson(matchingTool.parameters)}\nGrants ${canonicalJson(matchingTool.grants)}\nEffects ${canonicalJson(matchingTool.effects)}\n${TOOL_POLICY_LIMIT}` : `${input.request.prompt}\n${canonicalJson(run.state.plan ?? {})}`;
      const approved = await approval(ctx, kind, input.scopeHash, description, matchingTool ? [{ name: matchingTool.name, version: matchingTool.version }] : [], Boolean(matchingTool&&toolApprovalNeedsTui(run.state,matchingTool)));
      await persist({ kind: "record-trusted-approval", approval: approved }); await settle();
      if (approved.decision !== "approve" && kind !== "push") await pause("Approval declined.", ctx);
      return;
    }
    if (input.kind === "observe_git") { const observation = await observedCode(input.scopePaths); await persist({ kind: "record-git-observation", observation }); await settle(observation.evidence); return; }
    if (input.kind === "create_branch") { const output = await createOutputBranch({ repo: run.state.repository.root, slug: run.state.slug, userBranch: input.branch, expected: input.expectedCode, planApproved: true, needed: true }); const refs = [await evidence("branch", output, "Output branch operation")]; await settle(refs, {...output,kind:"git",operation:"create_branch",ownershipEvidence:refs}); return; }
    if (input.kind === "integrate") {
      const before=await observedCode();if(digestJson(before.identity)!==digestJson(input.expectedBefore))throw new Error("Code or attribution changed before patch integration.");
      const incoming=JSON.parse(await readFile(join(run.writer.runPath,input.patchRef.uri),"utf8")),output=await integrateChecked({repo:run.state.repository.root,ownership:run.ownership,incoming,expected:input.expectedBefore});
      run.ownership.patches.push(output.patch);await writeFile(join(run.writer.runPath,"ownership.json"),canonicalJson(run.ownership),{mode:0o600});
      const after=await observedCode(),refs=[...before.evidence,...after.evidence,await evidence("integration",output,"Controller-captured retained checkout patch integrated into the parent.")];
      await settle(refs,{kind:"git",operation:"integrate",before:before.identity,after:after.identity,branch:(await captureBaseline(run.state.repository.root)).branch??"",commits:[],work:input.work,ownershipEvidence:refs});return;
    }
    if (input.kind === "commit") {
      const before=await observedCode(),plan=await prepareCommitGroups(run.state,before,run.ownership),output=await commitApproved(plan,{approval:plan.authorization,reviewedPlanHash:plan.approvedPlanHash}),after=await observedCode(),refs=[...before.evidence,...after.evidence,await evidence("commits",output,"Explicitly requested, approved commit groups")];
      await settle(refs,{...output,kind:"git",operation:"commit",before:before.identity,after:after.identity,groupIds:plan.groups.map(item=>item.group.id),ownershipEvidence:refs});return;
    }
    if (input.kind === "prepare_push") {
      const remotes = (await api.exec("git", ["remote"], {cwd:run.state.repository.root})).stdout.trim().split("\n").filter(Boolean);
      if (!remotes.length) { await pause("No configured Git push remote. Configure an explicit destination before continuing.", ctx); return; }
      const remote = remotes.length === 1 ? remotes[0]! : ctx.hasUI && ctx.mode === "tui" ? await ctx.ui.select("Select the remote for the final push preview", remotes) : undefined;
      if (!remote) { await pause("Select the exact push remote through the OMP TUI.", ctx); return; }
      const branch = (await captureBaseline(run.state.repository.root)).branch;
      if (!branch) throw new Error("Push requires an output branch.");
      const plan = await preparePush({repo:run.state.repository.root,remote,branch,commits:input.commits,expected:input.expectedCode,planRevision:run.state.planRevision,ownerEpoch:run.state.owner.epoch,requested:run.state.invocation.pushRequested});
      await mkdir(join(run.writer.runPath,"evidence"),{recursive:true,mode:0o700});
      await writeFile(join(run.writer.runPath,"evidence", "push-"+plan.scopeHash+".json"),canonicalJson(plan),{mode:0o600});
      await persist({kind:"record-push-target",actionId:action.id,target:{remote:plan.remote,url:plan.url,branch:plan.branch,commits:plan.commits,codeIdentity:plan.expected,scopeHash:plan.scopeHash}}); return;
    }
    if (input.kind === "push") {
      const approved = run.state.approvals.find(approval=>approval.id===input.approvalId && approval.kind==="push" && approval.authority==="omp-tui" && approval.scopeHash===input.approvalScopeHash && approval.decision==="approve");
      if (!approved) throw new Error("Push has no matching exact TUI approval.");
      const plan = JSON.parse(await readFile(join(run.writer.runPath,"evidence","push-"+input.approvalScopeHash+".json"),"utf8"));
      if (plan.remote!==input.remote || plan.branch!==input.branch || digestJson(plan.commits)!==digestJson(input.commits)) throw new Error("Push target changed after approval.");
      const output = await pushConfirmed(plan,{approval:approved,reviewedPlanHash:input.approvalScopeHash});
      const refs = [await evidence("push",output,"Exact confirmed remote publication")]; await settle(refs,{...output,kind:"git",operation:"push",ownershipEvidence:refs}); return;
    }
    if (input.kind === "conclude") {
      const observed=await observedCode(run.state.plan?.scope.paths??[]);
      if(digestJson(observed.identity)!==digestJson(run.state.code?.identity??null)) {await persist({kind:"record-git-observation",observation:observed});throw new Error("Code changed before conclusion; the current code needs review and verification.");}
      const ref=await evidence("conclusion",{code:observed.identity,reviewRounds:run.state.reviewRounds,verification:run.state.verification,conclusion:input.conclusion},"Final code identity and observed review/verification records.");
      await persist({ kind: "conclude", conclusion: {...input.conclusion,evidence:[...input.conclusion.evidence,ref]} }); return;
    }
    throw new Error(`Action ${input.kind} is a parent native control cell.`);
  }
  function currentControl(cellId: string): IssuedControl {
    const run = requireRun(), issued = [...run.cells.values()].find(issued => issued.cellId === cellId);
    const cell = issued?.cell, action = cell && run.state.actions.find(action => action.id === cell.actionId);
    if (!run.allowedTurn || !issued || !cell || !action || action.status !== "issued" ||
      action.runId !== run.state.runId || cell.runId !== action.runId ||
      run.state.owner.sessionId !== run.writer.request.sessionId || run.state.owner.leaseId !== run.writer.leaseId ||
      action.ownerEpoch !== run.state.owner.epoch || cell.ownerEpoch !== action.ownerEpoch ||
      action.expectedStateRevision !== run.state.eventSequence || cell.expectedStateRevision !== action.expectedStateRevision ||
      action.planRevision !== run.state.planRevision || cell.inputHash !== action.inputHash || cell.programHash !== action.programHash) {
      throw new Error("Supership control cell is unknown, stale, claimed, or no longer authorized.");
    }
    return issued;
  }
  async function next(ctx:ExtensionContext) {
    const run = requireRun(); if (!run.allowedTurn) throw new Error("Current native Plan Mode preflight has not passed.");
    if (["completed", "cancelled"].includes(run.state.lifecycle)) { const completed = { lifecycle: run.state.lifecycle, message: "Run finished. Inspect the retained dashboard for its conclusion." }; await release(); return controlResult(completed); }
    // Snapshot, advance, draft and issue must commit against one state revision: a parent callback return or a user
    // instruction landing in between re-selects a different action and the stale draft is rightly rejected. The lock
    // covers the whole window and noninteractive trusted effects through settlement, so a Git mutation cannot
    // enter a callback's before/after attribution window. Prompts and native cells run after release.
    const releaseIssue = await acquireParentCall();
    let action: ActionRecord, cell: ControlCell | undefined;
    try {
    await captureFinishedWork();
    if(run.scopeRevision!==run.state.planRevision){await persist({kind:"record-git-observation",observation:await observedCode()});run.scopeRevision=run.state.planRevision;}
    const existing = run.state.actions.find(action => action.status === "issued" && action.expectedStateRevision === run.state.eventSequence);
    if (existing) { const issued = run.cells.get(existing.id); if (!issued) throw new Error("Issued control code is unavailable; resume through the OMP TUI."); return controlResult(controlManifest(currentControl(issued.cellId))); }
    const snapshot = readRuntimeSnapshot(ctx, run.state, syncConcurrencyCap(run.settings, run.state.limits.concurrency));
    await persist({ kind: "record-runtime-snapshot", snapshot });
    await recordUsage(ctx);
    let draft: ReturnType<typeof selectNextAction>;
    for (;;) {
      const sequence = run.state.eventSequence;
      await persist({ kind: "advance" });
      draft = selectNextAction(run.state, snapshot);
      if (draft || run.state.eventSequence === sequence) break;
    }
    if (!draft) return controlResult({ lifecycle: run.state.lifecycle, phase: run.state.phase, message: "No eligible action. Inspect retained owners and required decisions through the OMP TUI. Do not repeat an action." });
    const prospective: ActionRecord = { schemaVersion: 1, id: `a-${run.state.eventSequence + 1}`, runId: run.state.runId, ownerEpoch: run.state.owner.epoch, expectedStateRevision: run.state.eventSequence + 1, ...draft, inputHash: digestJson(draft.input), status: "issued", issuedAt: Date.now(), receiptIds: [] };
    const native = ["run_finite", "wait", "cancel_runtime", "pool_create", "pool_push", "pool_close", "register_tool", "retire_tool", "verify"].includes(draft.input.kind);
    if(draft.input.kind==="run_finite") for(const [index,assignment] of draft.input.assignments.entries()) {
      if(assignment.mutation==="read-only" && !assignment.toolGrants.length) continue;
      const work=draft.input.work[index]!;
      const binding=await prepareWorkspace({runPath:run.writer.runPath,runId:run.state.runId,repositoryRoot:run.state.repository.root,parentSessionId:run.state.owner.sessionId,ownerEpoch:run.state.owner.epoch,actionId:prospective.id,work,assignment,grantedToolNames:assignment.toolGrants.map(grant=>{const definition=run.state.tools.find(tool=>tool.name===grant.name&&tool.version===grant.version);if(!definition)throw new Error("Required dynamic tool definition is absent.");return runtimeToolName(definition,{workId:work.id,workRevision:work.revision,seatId:assignment.seatId});})});
      run.workspaces.set(work.attemptId,binding);
      if(!run.settings.get("extensions").includes(binding.extensionRoot)) run.settings.override("extensions",[...run.settings.get("extensions"),binding.extensionRoot]);
    }
    if (native) {
      let source: string | undefined; const initialization: Record<string, unknown> = {};
      if (draft.input.kind === "register_tool") {
        const definition = run.state.tools.find(tool => tool.name === (draft.input.kind === "register_tool" ? draft.input.toolName : "") && tool.version === (draft.input.kind === "register_tool" ? draft.input.toolVersion : 0))!;
        source = await readCapturedSource(run.writer.runPath, definition);
        for (const input of definition.initialization) { if (input.ref.kind !== "file") throw new Error("Initialization needs a captured run-local JSON file or a new proposal."); const text = await readFile(join(run.writer.runPath, input.ref.uri), "utf8"); if (sha256Utf8(text) !== input.ref.digest) throw new Error("Initialization input changed. Re-propose the tool."); initialization[input.name] = JSON.parse(text); }
      }
      cell = renderControlCell(prospective, { ...run.state, seats: run.seats.bindings }, source, initialization,[...run.workspaces.values()]);
    }
    await persist({ kind: "issue-action", draft, ...(cell ? { programHash: cell.programHash } : {}) });
    action = run.state.actions.find(action => action.id === prospective.id) ?? (() => { throw new Error(`Issued action ${prospective.id} is absent from the committed run record.`); })();
    if (!cell && action.input.kind !== "collect_input" && action.input.kind !== "prepare_push") await trustedAction(action, ctx);
    } finally { releaseIssue(); }

    if(run.workspaces.size) await writeFile(join(run.writer.runPath,"workspace-bindings.json"),canonicalJson([...run.workspaces.values()]),{mode:0o600});
    if (cell) { const issued = issueControl(cell); run.cells.set(action.id, issued); return controlResult(controlManifest(currentControl(issued.cellId))); }
    if (action.input.kind === "collect_input" || action.input.kind === "prepare_push") await trustedAction(action, ctx);
    return controlResult({completedAction:action.id,lifecycle:run.state.lifecycle,...(run.state.recovery?{message:"A recovery decision is required. Resume through the OMP TUI."}:{}),next:run.state.recovery?"Do not repeat this action without its required decision.":"Call supership_next."});
  }
  let nextInFlight:ReturnType<typeof next>|undefined;
  api.registerTool({name:"supership_next",label:"Supership next action",description:"Issue a bounded control manifest, or read one ordered page of its original code. Follow each exact next expression in a separate eval/display. At next:null, concatenate page code without separators and execute the original JavaScript with timeout:0. Bootstrap may ask trusted TUI decisions and also needs timeout:0. Pages are read-only and cannot approve or execute anything.",parameters:NextRequestSchema,async execute(_id,args,_signal,_update,ctx){
    const { i: _intent, ...parameters } = args as Record<string, unknown>;
    const requestArgs: unknown = parameters;
    assertSchema(NextRequestSchema,requestArgs);
    // Device dispatch bypasses inner tool_call hooks; authorization must hold here too.
    if (!requireRun().allowedTurn) throw new Error("Current native Plan Mode preflight has not passed.");
    if ("cellId" in requestArgs) return controlResult(controlPage(currentControl(requestArgs.cellId),requestArgs.page));
    if(nextInFlight)return nextInFlight;const request=next(ctx);nextInFlight=request;try{return await request;}finally{if(nextInFlight===request)nextInFlight=undefined;}
  }});
  api.registerTool({ name: "supership_propose_tool", label: "Supership tool proposal", description: "Capture JavaScript source, schema, effects and requested grants for approval. This does not register or execute source.", parameters: Type.Object({ proposal: ToolProposalSchema, grants: Type.Array(ToolGrantSchema) }, { additionalProperties: false }), async execute(_id, args) {
    const run = requireRun();
    const captured = await captureProposal(args.proposal, { runPath: run.writer.runPath, existingNames: api.getAllTools().map(tool => tool.name) });
    for (const grant of args.grants) if (!run.state.work.some(work => work.id === grant.workId && work.revision === grant.workRevision && work.seatId === grant.seatId) || !args.proposal.intendedUsers.includes(grant.seatId)) throw new Error("Proposal grant is not an intended current work recipient.");
    const definition: ToolDefinitionRecord = { ...captured, version: Math.max(0, ...run.state.tools.filter(tool => tool.name === captured.name).map(tool => tool.version)) + 1, grants: args.grants, approvalScopeHash: toolApprovalScope(captured, args.grants), parent: { cwd: run.state.repository.root, sessionId: run.state.owner.sessionId, ownerEpoch: run.state.owner.epoch }, kernelGeneration: run.state.kernelGeneration, registration: "proposed", evidence: [] };
    await persist({ kind: "record-tool", definition }); return result({ name: definition.name, version: definition.version, approvalScopeHash: definition.approvalScopeHash, registered: false, policy: inspectProposal(args.proposal) });
  } });
  api.registerTool({ name: "supership_runtime", label: "Supership runtime receipt", description: "Internal typed control-cell lifecycle adapter. Never call outside the issued cell.", parameters: Type.Object({ actionId: Type.String(), operation: Type.String(), data: Type.Unknown() }, { additionalProperties: false }), async execute(id, args, _signal, _update, ctx) {
    const run = requireRun(), action = run.state.actions.find(action => action.id === args.actionId);
    if (!action || run.evalAction !== action.id || !["claimed", "running"].includes(action.status)) throw new Error("Runtime report has no active verified action.");
    const observation: ReceiptObservation = { kind: "runtime-confirmed", toolCallId: id, verifiedProgramHash: action.programHash, evidence: [] };
    const data = args.data as Record<string, unknown>;
    if (args.operation === "kernel") {
      // Registered tools of the current generation and live WorkPools exist only inside the parent kernel registry; agent handles survive through hub ids.
      const lost = run.state.tools.some(tool => tool.registration === "registered" && tool.kernelGeneration === run.state.kernelGeneration) || run.state.pools.some(pool => pool.status === "running" || pool.status === "closing");
      if (data.present !== true && lost) { releaseParentCalls(); run.kernelToken = randomUUID(); await persist({ kind: "record-kernel-generation", generation: run.state.kernelGeneration + 1, reason: "Parent JavaScript kernel lost; source was not replayed.", evidence: [] }); throw new Error("Supership kernel lost. Recreate or re-propose through trusted recovery."); }
      // Only the claimed cell's own bridge reaches this operation, so the token stays inside the kernel and bridged results.
      return result({ accepted: true, token: run.kernelToken });
    }
    if (args.operation === "verification-results") {
      if (action.input.kind !== "verify" || !Array.isArray(data.observations) || typeof data.startedAt !== "number" || typeof data.endedAt !== "number" || !["passed", "failed", "unavailable"].includes(String(data.outcome))) throw new Error("Malformed verification observation.");
      const commands = data.observations.filter(item => item && typeof item === "object" && item.kind === "command");
      for (const command of commands) {
        const received = command.value;
        if (!received || typeof received !== "object" || ![...run.native.values()].some(value => value && typeof value === "object" && "details" in value && digestJson(value.details ?? {}) === digestJson(received.details ?? {}))) throw new Error("Verification command lacks an observed native result.");
      }
      const scenario = action.input.check.scenario;
      const expectedOperations = scenario.kind === "command" ? 1 : scenario.operations.length;
      if (data.outcome === "passed" && data.observations.length !== expectedOperations) throw new Error("Verification did not execute every required operation.");
      const refs: EvidenceRef[] = [await evidence("verification", data, "Observed native command/browser verification")];
      for (const item of data.observations) if (item && typeof item === "object" && item.kind === "browser-screenshot" && typeof item.path === "string") {
        const bytes = await readFile(item.path), name = randomUUID(), uri = "evidence/" + name + ".png";
        await writeFile(join(run.writer.runPath, uri), bytes, {flag:"wx",mode:0o600});
        refs.push({id:name,kind:"file",uri,digest:createHash("sha256").update(bytes).digest("hex"),mediaType:"image/png",summary:"Actual browser verification screenshot",availability:"available"});
      }
      const observation = await observedCode(run.state.plan?.scope.paths ?? []);
      const sameCode = digestJson(observation.identity) === digestJson(action.input.expectedCode);
      const outcome = sameCode ? data.outcome as "passed" | "failed" | "unavailable" : "failed";
      await persist({kind:"record-verification",verification:{schemaVersion:1,id:randomUUID(),checkId:action.input.check.id,scenario,codeIdentity:action.input.expectedCode,scopePaths:action.input.check.scopePaths,startedAt:data.startedAt,endedAt:data.endedAt,outcome,...(scenario.kind === "command" ? {exitCode:outcome === "passed" ? 0 : 1} : {}),evidence:refs,verifier:{kind:"runtime",id},actionId:action.id}});
      await persist({kind:"settle-action",actionId:action.id,result:{kind:"success",evidence:refs}});
      await persist({kind:"record-git-observation",observation});
      return result({accepted:true,outcome});
    }
    if (args.operation === "native-results") {
      const observed = run.native.get(action.id);
      if (!observed || digestJson((observed as { details?: unknown }).details ?? {}) !== digestJson(JSON.parse(JSON.stringify((args.data as { details?: unknown }).details ?? {})))) throw new Error("Native result does not match the inner tool_result observation.");
      for (const input of await normalizeNativeResult(action, observed, run.state, observation, proposal => captureProposal(proposal, { runPath: run.writer.runPath, existingNames: api.getAllTools().map(tool => tool.name) }))) { if (input.kind === "observe-receipt" || input.kind==="record-invalid-output") { const original = run.state.actions.find(action => action.id === (input.kind==="observe-receipt"?input.receipt.actionId:input.actionId))!; input.observation.verifiedProgramHash = original.programHash; } await persist(input, input.kind === "observe-receipt" ? input.receipt.receiptId : randomUUID()); }
      
      return result({ accepted: true });
    }
    if (args.operation === "native-replay") {
      if(action.input.kind!=="wait" || typeof data.ownerId!=="string" || typeof data.path!=="string") throw new Error("No authorized task result replay.");
      const owner=action.input.owners.find(owner=>owner.id===data.ownerId);
      if(!owner || data.path!=="agent://"+String(data.agentId)+"?q=.") throw new Error("Result replay targets another owner.");
      const native=run.native.get("read:"+data.path) as {details?:unknown;content?:Array<{type:string;text?:string}>}|undefined;
      const reported=data.source as {details?:unknown;text?:string};
      if(!native || digestJson(native.details??{})!==digestJson(JSON.parse(JSON.stringify(reported.details??{})))) throw new Error("Result replay lacks an observed native read.");
      const original=run.state.actions.find(action=>action.id===owner.actionId)!;
      const text=native.content?.filter(block=>block.type==="text").map(block=>block.text??"").join("\n")??"";
      let output:unknown; try {output=JSON.parse(text);} catch {throw new Error("Native structured result artifact is unreadable JSON.");}
      const rows={details:{results:[{id:owner.id,status:"completed"}]}};
      for(const input of await normalizeNativeResult(original,rows,run.state,{...observation,verifiedProgramHash:original.programHash},proposal=>captureProposal(proposal,{runPath:run.writer.runPath,existingNames:api.getAllTools().map(tool=>tool.name)}),new Map([[owner.id,output]]))) await persist(input,input.kind==="observe-receipt"?input.receipt.receiptId:randomUUID());
      return result({accepted:true});
    }
    if (args.operation === "wait-complete") {
      if(action.input.kind!=="wait") throw new Error("No wait action.");
      // The native wait has returned; serialize only capture and settlement, never the child wait itself.
      const release = await acquireParentCall();
      try { await captureFinishedWork(); await persist({kind:"settle-action",actionId:action.id,result:{kind:"success",evidence:[]}}); return result({accepted:true}); }
      finally { release(); }
    }
    if (args.operation === "pool-created") {
      if(action.input.kind!=="pool_create" || data.id!==action.input.poolId) throw new Error("WorkPool identity changed.");
      const owner={kind:"pool" as const,id:action.input.poolId,actionId:action.id,workId:action.input.poolId,workRevision:action.planRevision,attemptId:action.id,sessionId:run.state.owner.sessionId,ownerEpoch:run.state.owner.epoch,status:"observed-running" as const};
      const receipt:Receipt={...receiptBase(action,"created",owner.id),kind:"created",kernelGeneration:run.state.kernelGeneration,owner};
      await persist({kind:"observe-receipt",receipt,observation},receipt.receiptId); return result({accepted:true});
    }
    if (args.operation === "pool-pushed") {
      if(action.input.kind!=="pool_push" || !Array.isArray(data.keys) || data.keys.length!==action.input.items.length || data.keys.some(key=>typeof key!=="string" || !key.startsWith(action.input.kind==="pool_push"?action.input.poolId+"#":"") || !/^[1-9][0-9]*$/.test(key.slice(key.lastIndexOf("#")+1)) || !Number.isSafeInteger(Number(key.slice(key.lastIndexOf("#")+1))))) throw new Error("WorkPool keys differ from issued items.");
      for(const [index,item] of action.input.items.entries()) {
        const owner={kind:"pool-item" as const,id:String(data.keys[index]),parentId:action.input.poolId,logicalKey:String(data.keys[index]),actionId:action.id,workId:item.work.id,workRevision:item.work.revision,attemptId:item.work.attemptId,sessionId:run.state.owner.sessionId,ownerEpoch:run.state.owner.epoch,status:"observed-running" as const};
        const receipt:Receipt={...receiptBase(action,"created",item.work.id),kind:"created",work:item.work,kernelGeneration:run.state.kernelGeneration,owner};
        await persist({kind:"observe-receipt",receipt,observation},receipt.receiptId);
      }
      return result({accepted:true});
    }
    if (args.operation === "pool-results") {
      if(action.input.kind!=="wait" || typeof data.poolId!=="string") throw new Error("No observed WorkPool batch results.");
      const peek=data.peek; assertSchema(PoolPeekSchema,peek);
      for(const batch of peek.batches) {
        if(!["completed","failed","cancelled"].includes(batch.status)) continue;
        let outputs:Record<string,unknown>={}; try {outputs=JSON.parse(batch.output);} catch { /* Malformed batch results enter the correction policy. */ }
        for(const key of batch.items ?? []) {
          const work=run.state.work.find(work=>!["succeeded","failed","cancelled"].includes(work.status) && work.runtimeOwners.some(owner=>owner.id===key && owner.parentId===data.poolId));
          if(!work) continue;
          const owner=work.runtimeOwners.find(owner=>owner.id===key)!;
          const original=run.state.actions.find(action=>action.id===owner.actionId)!;
          const observed={details:{results:[{id:key,status:Object.hasOwn(outputs,key)?"completed":batch.status}]}};
          for(const input of await normalizeNativeResult(original,observed,run.state,{...observation,verifiedProgramHash:original.programHash},proposal=>captureProposal(proposal,{runPath:run.writer.runPath,existingNames:api.getAllTools().map(tool=>tool.name)}),new Map([[key,outputs[key]]]))) await persist(input,input.kind==="observe-receipt"?input.receipt.receiptId:randomUUID());
        }
      }
      return result({accepted:true});
    }
    if (args.operation === "pool-closed") {
      if(action.input.kind!=="pool_close") throw new Error("No observed WorkPool closure.");
      const poolId=action.input.poolId,peek=data.peek,status=data.status; assertSchema(PoolPeekSchema,peek); assertSchema(PoolStatusSchema,status);
      const pool=run.state.pools.find(pool=>pool.id===poolId)!;
      const assigned=new Set(peek.batches.flatMap(batch=>batch.items));
      const cancelled=pool.items.filter(item=>item.key!==undefined && !assigned.has(item.key)).map(item=>item.key!);
      if(cancelled.length!==status.items.cancelled) throw new Error("Queued cancellation keys differ from native WorkPool count.");
      const runningOwners=run.state.work.flatMap(work=>work.runtimeOwners).filter(owner=>owner.parentId===pool.id && owner.status!=="observed-terminal" && !cancelled.some(key=>owner.id===key));
      const receipt:Receipt={...receiptBase(action,"pool-closed",pool.id),kind:"pool-closed",poolId:pool.id,queuedKeysCancelled:cancelled,runningOwners};
      await persist({kind:"observe-receipt",receipt,observation},receipt.receiptId); return result({accepted:true});
    }
    if (args.operation === "handle-created") {
      const index = action.recipients.findIndex((_recipient, index) => data.label === nativeName(action, index)), recipient = action.recipients[index];
      if (!recipient) throw new Error("Handle does not match action recipients.");
      const snapshot = ctx.getAsyncJobSnapshot(); if (![...snapshot?.running ?? [], ...snapshot?.recent ?? []].some(job => job.id === data.id)) throw new Error("Created handle is absent from the public runtime snapshot.");
      const owner = { kind: "agent" as const, id: String(data.id), actionId: action.id, workId: recipient.workId, workRevision: recipient.workRevision, attemptId: recipient.attemptId, sessionId: run.state.owner.sessionId, ownerEpoch: run.state.owner.epoch, status: "observed-running" as const };
      const receipt: Receipt = { ...receiptBase(action, "created", recipient.workId), kind: "created", work: { id: recipient.workId, revision: recipient.workRevision, attemptId: recipient.attemptId }, kernelGeneration: run.state.kernelGeneration, owner };
      await persist({ kind: "observe-receipt", receipt, observation }, receipt.receiptId); return result({ accepted: true });
    }
    if (args.operation === "tool-registered") { const receipt = { ...receiptBase(action, "tool-registered", String(data.name)), kind: "tool-registered", ...data }; assertSchema(ReceiptSchema, receipt); await persist({ kind: "observe-receipt", receipt, observation }, receipt.receiptId); return result({ accepted: true }); }
    if (args.operation === "retired") { await persist({ kind: "settle-action", actionId: action.id, result: { kind: "success", evidence: [] } }); return result({ accepted: true }); }
    if (args.operation === "cancel-requested" || args.operation === "cancel-observed") {
      if (action.input.kind !== "cancel_runtime") throw new Error("No cancellation operation.");
      if (args.operation === "cancel-requested") { const receipt: Receipt = { ...receiptBase(action, "cancel-requested", "all"), kind: "cancel-requested", owners: action.input.owners, requestEvidence: [] }; await persist({ kind: "observe-receipt", receipt, observation }, receipt.receiptId); }
      else {
        const snapshot = readRuntimeSnapshot(ctx, run.state, syncConcurrencyCap(run.settings, run.state.limits.concurrency));
        await persist({ kind: "record-runtime-snapshot", snapshot });
        if (snapshot.unknownOwners.length || snapshot.activeOwners.length) return result({ cancelled: false, unresolved: [...snapshot.activeOwners, ...snapshot.unknownOwners] });
        const ref = await evidence("cancel-runtime", ctx.getAsyncJobSnapshot(), "Public snapshot confirms every managed owner terminal.");
        const receipt: Receipt = { ...receiptBase(action, "cancel-confirmed", "all"), kind: "cancel-confirmed", owners: snapshot.knownCompletedOwners, settlementEvidence: [ref] }; await persist({ kind: "observe-receipt", receipt, observation }, receipt.receiptId);
      }
      return result({ accepted: true });
    }
    throw new Error(`Runtime operation ${args.operation} has no matching action normalization.`);
  } });
  api.registerTool({name:"supership_workspace",label:"Supership retained workspace",description:"Internal exact grant callback for retained builder I/O.",parameters:Type.Object({actionId:Type.String(),work:WorkRefSchema,manifestDigest:Type.String(),token:Type.String(),stage:Type.Union([Type.Literal("begin"),Type.Literal("end")]),operation:Type.Optional(Type.Union([Type.Literal("read"),Type.Literal("write"),Type.Literal("edit"),Type.Literal("bash")])),input:Type.Optional(Type.Record(Type.String(),Type.Unknown())),invocationId:Type.Optional(Type.String()),outcome:Type.Optional(Type.String())},{additionalProperties:false}),async execute(id,args,_signal,_update,ctx) {
    const run=requireRun(),binding=run.workspaces.get(args.work.attemptId);
    if(!binding || binding.actionId!==args.actionId || binding.manifestDigest!==args.manifestDigest || digestJson(binding.work)!==digestJson(args.work)) throw new Error("Workspace callback does not match its immutable work grant.");
    if(args.stage==="begin") {
      const release=await acquireParentCall();
      try {
        const work=run.state.work.find(work=>work.id===args.work.id && work.revision===args.work.revision && work.attempt.id===args.work.attemptId);
        const action=run.state.actions.find(action=>action.id===binding.actionId);
        if(!work || work.status!=="running" || !action || !["claimed","running"].includes(action.status) || !run.allowedTurn || run.state.owner.epoch!==binding.ownerEpoch || !args.operation || !args.input) throw new Error("Workspace work is no longer authorized to start I/O.");
        const route=routeWorkspaceOperation(binding,args.operation,args.input),before=await captureBaseline(binding.path),parentBefore=binding.path===run.state.repository.root?before:await captureBaseline(run.state.repository.root),invocationId=randomUUID();
        const startRef=await evidence("workspace-start",{invocationId,work:binding.work,manifestDigest:binding.manifestDigest,parentSessionId:run.state.owner.sessionId,operation:route.toolName,inputHash:digestJson(route.input),before:before.identity,parentBefore:parentBefore.identity},"Parent callback started; no completion means effects require inspection.");
        // The engine attributes active-checkout bytes only through this invocation pair; a begin without a return stays a running invocation for recovery.
        const receipt:Receipt={...receiptBase(action,"workspace-called",invocationId),kind:"workspace-called",invocationId,caller:binding.work,parentBefore:parentBefore.identity,manifestDigest:binding.manifestDigest,evidence:[startRef]};
        await persist({kind:"observe-receipt",receipt,observation:{kind:"runtime-confirmed",toolCallId:id,verifiedProgramHash:action.programHash,evidence:[startRef]}},receipt.receiptId);
        workspaceCalls.set(invocationId,{binding,route,before,parentBefore,release});
        return result({invocationId,...route});
      } catch(error) {release();throw error;}
    }
    const call=args.invocationId?workspaceCalls.get(args.invocationId):undefined;
    if(!call || call.binding.manifestDigest!==binding.manifestDigest) throw new Error("Unknown workspace callback completion.");
    try {
      const after=await captureBaseline(binding.path),parentAfter=binding.path===run.state.repository.root?after:await captureBaseline(run.state.repository.root);
      const ref=await evidence("workspace-operation",{invocationId:args.invocationId,work:binding.work,manifestDigest:binding.manifestDigest,parentSessionId:run.state.owner.sessionId,operation:call.route.toolName,inputHash:digestJson(call.route.input),outcome:args.outcome,before:call.before.identity,after:after.identity,parentBefore:call.parentBefore.identity,parentAfter:parentAfter.identity},"Observed parent callback into "+binding.path+"; "+PARENT_ACCESS);
      let outcome:"success"|"failed"|"uncertain"=args.outcome==="success"?"success":"failed";const effectEvidence:EvidenceRef[]=[ref];
      if(binding.path!==run.state.repository.root && digestJson(call.parentBefore.identity)!==digestJson(parentAfter.identity)) {
        const attributed=attributeParentEffect(call.parentBefore,parentAfter,{kind:"parent-callback",workId:binding.work.id},binding.expectedPaths);
        if(attributed.declared) { if(attributed.patch.changes.length){run.ownership.patches.push(attributed.patch);await writeFile(join(run.writer.runPath,"ownership.json"),canonicalJson(run.ownership),{mode:0o600});} }
        else { outcome="uncertain"; effectEvidence.push(await evidence("workspace-effect-undeclared",{invocationId:args.invocationId,work:binding.work,undeclaredPaths:attributed.undeclaredPaths,patch:attributed.patch},"Parent-root changes outside the assignment during a workspace callback; unattributed until inspected.")); }
      }
      const action=run.state.actions.find(action=>action.id===binding.actionId)!;
      const receipt:Receipt={...receiptBase(action,"workspace-returned",args.invocationId!),kind:"workspace-returned",invocationId:args.invocationId!,parentAfter:parentAfter.identity,outcome,parentEffectEvidence:effectEvidence,evidence:[ref]};
      await persist({kind:"observe-receipt",receipt,observation:{kind:"runtime-confirmed",toolCallId:id,verifiedProgramHash:action.programHash,evidence:[ref]}},receipt.receiptId);
      await persist({kind:"record-git-observation",observation:await observedCode(run.state.plan?.scope.paths??[])});
      return result({recorded:true});
    } finally {workspaceCalls.delete(args.invocationId!);call.release();}
  }});
  api.registerTool({ name: "supership_callback", label: "Supership parent callback", description: "Record a grant-bound parent callback and its separately attributed Git effects.", parameters: Type.Object({ actionId: Type.String(), name: Type.String(), version: Type.Integer(), grant: ToolGrantSchema, token: Type.String(), stage: Type.Union([Type.Literal("begin"), Type.Literal("end")]), data: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }), async execute(id, args, _signal, _update, ctx) {
    const run=requireRun(),prior=args.stage==="end"?callbacks.get(String(args.data.invocationId)):undefined;
    const definition=prior?.definition??run.state.tools.find(tool=>tool.name===args.name&&tool.version===args.version);
    const work=run.state.work.find(work=>work.id===args.grant.workId&&work.revision===args.grant.workRevision);
    if(!definition || !work) throw new Error("Parent callback has no known tool or work.");
    const action=prior?.action??run.state.actions.find(action=>action.recipients.some(recipient=>recipient.workId===work.id&&recipient.workRevision===work.revision&&recipient.attemptId===work.attempt.id)&&["claimed","running"].includes(action.status));
    if(!action) throw new Error("Callback recipient has no known action.");
    const observation:ReceiptObservation={kind:"runtime-confirmed",toolCallId:id,verifiedProgramHash:action.programHash,evidence:[]};
    if(args.stage==="begin") {
      const release=await acquireParentCall();
      try {
        const current=run.state.work.find(item=>item.id===work.id&&item.revision===work.revision);
        const registration=run.state.actions.find(item=>item.id===args.actionId);
        if(!current || current.status!=="running" || !run.allowedTurn || definition.parent.ownerEpoch!==run.state.owner.epoch || definition.parent.sessionId!==run.state.owner.sessionId || registration?.input.kind!=="register_tool" || registration.input.generation!==run.state.kernelGeneration || registration.status!=="settled") throw new Error("Callback registration, work, owner, or native mode authorization changed.");
        const validation=validateGrant(definition,current,run.state.kernelGeneration);if(!validation.valid)throw new Error(validation.issues.map(issue=>issue.message).join("\n"));
        const invocationId=randomUUID(),before=await captureBaseline(run.state.repository.root),caller={id:work.id,revision:work.revision,attemptId:work.attempt.id};
        const receipt:Receipt={...receiptBase(action,"tool-called",invocationId),kind:"tool-called",invocationId,name:definition.name,version:definition.version,kernelGeneration:run.state.kernelGeneration,caller,parentBefore:before.identity};
        await persist({kind:"observe-receipt",receipt,observation},receipt.receiptId);callbacks.set(invocationId,{before,action,caller,definition,release});return result({invocationId});
      } catch(error){release();throw error;}
    }
    const invocationId=String(args.data.invocationId);
    if(!prior || prior.caller.id!==work.id || prior.caller.revision!==work.revision || prior.definition.name!==args.name || prior.definition.version!==args.version)throw new Error("Unknown or mismatched parent callback completion.");
    try {
      const after=await captureBaseline(run.state.repository.root),attributed=attributeParentEffect(prior.before,after,{kind:"parent-callback",workId:work.id},definition.effects.paths);
      const ref=await evidence(attributed.declared?"parent-effect":"parent-effect-undeclared",attributed.declared?attributed.patch:{undeclaredPaths:attributed.undeclaredPaths,patch:attributed.patch},definition.name+"@"+definition.version+": "+PARENT_ACCESS+(attributed.declared?"; separate parent patch.":"; changed paths outside its declared effects, unattributed until inspected."));
      if(attributed.declared && attributed.patch.changes.length){run.ownership.patches.push(attributed.patch);await writeFile(join(run.writer.runPath,"ownership.json"),canonicalJson(run.ownership),{mode:0o600});}
      const receipt:Receipt={...receiptBase(action,"tool-returned",invocationId),kind:"tool-returned",invocationId,name:definition.name,version:definition.version,kernelGeneration:definition.kernelGeneration,outcome:!attributed.declared?"uncertain":args.data.outcome==="success"?"success":"failed",parentAfter:after.identity,parentEffectEvidence:[ref]};
      await persist({kind:"observe-receipt",receipt,observation},receipt.receiptId);await persist({kind:"record-git-observation",observation:await observedCode(run.state.plan?.scope.paths??[])});return result({recorded:true});
    } finally {callbacks.delete(invocationId);prior.release();}
  } });
  api.on("tool_call", async (event, ctx) => {
    if (!active) return;
    const run = active;
    const parameters=event.input as Record<string,unknown>,internal=["supership_runtime","supership_callback","supership_workspace"].includes(event.toolName),privileged=internal||["task","hub","bash","write","edit"].includes(event.toolName);
    // OMP prepares every call of an assistant message before any executes, so a model-authored call always reaches this hook
    // outside the claimed cell's execution window; a bridge-shaped id alone proves nothing.
    const executing=run.evalExecuting!==undefined;
    // Outside Code Mode, OMP mounts extension tools as xd:// devices driven through write; that dispatch fires no inner tool_call hook.
    const device = event.toolName === "write" && typeof parameters.path === "string" ? /^\[?xd:\/\/([^\s#\]/?]+)/.exec(parameters.path)?.[1] : undefined;
    if (device !== undefined) { if (device === "supership_next" || device === "supership_propose_tool") { if (!run.allowedTurn) return { block: true, reason: "Supership requires a passed current native mode preflight." }; return; } return { block: true, reason: "Only supership_next and supership_propose_tool are reachable as devices; every other parent operation needs its issued control cell." }; }
    if(privileged&&!event.toolCallId.startsWith("js-"))return {block:true,reason:"Privileged operations require the native eval bridge, never a model-authored direct tool call."};
    if((event.toolName==="supership_runtime"||event.toolName==="task"||event.toolName==="hub")&&!executing)return {block:true,reason:"Runtime, task, and hub operations are accepted only from the executing issued control cell."};
    if((event.toolName==="supership_callback"||event.toolName==="supership_workspace")&&parameters.token!==run.kernelToken)return {block:true,reason:"Parent callbacks are accepted only from the authorized kernel registration."};
    const completing=parameters.stage==="end"&&(event.toolName==="supership_callback"||event.toolName==="supership_workspace");
    if(!run.allowedTurn&&!completing&&event.toolName!=="supership_runtime")return {block:true,reason:"Supership requires a passed current native mode preflight."};
    if(event.toolName==="read" && typeof event.input.path==="string") readInputs.set(event.toolCallId,event.input.path);
    if (event.toolName === "eval") {
      // Trusted TUI decisions (recovery, approvals, clarification) run inside this call; the native default deadline would kill the kernel mid-dialog.
      if (event.input.language === "js" && event.input.reset !== true && typeof event.input.code === "string") {
        const fetch = /^display\(await tool\.supership_next\(([^]*)\)\);$/.exec(event.input.code);
        if (fetch) {
          try {
            const args: unknown = JSON.parse(fetch[1]!); assertSchema(NextRequestSchema,args);
            if (event.input.code !== nextExpression(args)) throw new Error("Use the exact control fetch expression.");
            if (event.input.timeout !== 0) throw new Error("Call supership_next through eval with timeout:0; trusted decisions may outlast the default deadline.");
            if ("cellId" in args) controlPage(currentControl(args.cellId),args.page);
            return;
          } catch (error) { return { block: true, reason: error instanceof Error ? error.message : "Invalid Supership control fetch." }; }
        }
      }
      if (event.input.language === "js" && event.input.reset !== true && typeof event.input.code === "string") {
        const proposal = /^display\(await tool\.supership_propose_tool\(([^]*)\)\);$/.exec(event.input.code);
        if (proposal) { try { const args = JSON.parse(proposal[1]!); assertSchema(ToolProposalSchema, args.proposal); if (Array.isArray(args.grants)) return; } catch { /* Invalid literal proposals cannot bypass the control gate. */ } }
      }
      const cell = [...run.cells.values()].map(issued => issued.cell).find(cell => typeof event.input.code === "string" && cell.programHash === sha256Utf8(event.input.code));
      const action = cell && run.state.actions.find(action => action.id === cell.actionId);
      if (!cell || !action || !validateControlCall(event.input, action, cell).valid) return { block: true, reason: "Use only the exact issued Supership control cell. Unknown, stale, changed, and duplicate cells are refused." };
      await claim(action, event.toolCallId); run.evalAction = action.id; run.evalCallId = event.toolCallId; return;
    }
    if (event.toolName === "task") { const { i: _intent, ...parameters } = event.input; const action = run.state.actions.find(action => action.id === run.evalAction); if (!action || action.input.kind !== "run_finite" || digestJson(parameters) !== digestJson(taskParameters(action, { ...run.state, seats: run.seats.bindings },[...run.workspaces.values()]))) return { block: true, reason: "Task parameters differ from the claimed assignments and exact grants." }; }
    if (event.toolName === "hub") { const action = run.state.actions.find(action => action.id === run.evalAction); if (!action || !["wait", "cancel_runtime"].includes(action.input.kind)) return { block: true, reason: "Hub operation is not part of the current control action." }; const expected = action.input.kind === "wait" || action.input.kind === "cancel_runtime" ? [...new Set(action.input.owners.map(owner => action.input.kind === "wait" && (owner.kind === "pool" || owner.kind === "pool-item") ? owner.parentId ?? owner.id : owner.id))] : []; if (digestJson(event.input.ids) !== digestJson(expected) || event.input.op !== (action.input.kind === "wait" ? "wait" : "cancel")) return { block: true, reason: "Hub recipient or operation changed." }; }
    if (["read","write","edit","bash"].includes(event.toolName) && workspaceCalls.size) {
      const {i:_intent,...input}=event.input as Record<string,unknown>;
      if([...workspaceCalls.values()].some(call=>{const {i:_savedIntent,...expected}=call.route.input;return call.route.toolName===event.toolName && digestJson(input)===digestJson(expected);})) return;
      // The executing wait cell replays native results through read agent://…; that is never a workspace mutation.
      if(event.toolName==="read" && executing && typeof input.path==="string" && input.path.startsWith("agent://")) return;
      return {block:true,reason:"Native workspace operation differs from the exact approved route."};
    }
    if (event.toolName === "bash" && !callbacks.size) {
      if (!executing) return {block:true,reason:"Parent shell commands run only inside the executing verification cell."};
      const action = run.state.actions.find(action => action.id === run.evalAction);
      const operations = action?.input.kind === "verify" ? action.input.check.scenario.kind === "command" ? [action.input.check.scenario] : action.input.check.scenario.operations.filter(operation => operation.kind === "command") : [];
      const matches = operations.some(operation => operation.kind === "command" && event.input.command === operation.command.map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ") && event.input.cwd === operation.cwd && event.input.async === false);
      if (!matches) return {block:true,reason:"Command differs from the issued verification operation."};
      return;
    }
    if (["write", "edit", "bash"].includes(event.toolName)) {
      // A parent callback unlocks only its declared effect paths; bash stays limited to declared non-read-only effects.
      const declared = [...callbacks.values()].map(call => call.definition.effects);
      if (!declared.length) return { block: true, reason: "Parent mutations require a declared engine action or approved parent callback." };
      if (event.toolName === "bash") { if (!declared.some(effects => effects.kind !== "read-only")) return { block: true, reason: "No in-flight parent callback declares shell effects." }; return; }
      const target = typeof parameters.path === "string" ? resolve(run.state.repository.root, parameters.path) : undefined;
      if (!target || !declared.some(effects => effects.paths.some(path => { const declaredPath = resolve(run.state.repository.root, path); return target === declaredPath || target.startsWith(declaredPath + "/"); }))) return { block: true, reason: "Parent path is outside every in-flight callback's declared effects." };
    }
  });
  api.on("tool_execution_start", event => { if (active && event.toolName === "eval" && event.toolCallId === active.evalCallId) active.evalExecuting = event.toolCallId; });
  api.on("tool_result", async (event, ctx) => {
    if (!active) return;
    const run = active;
    if(event.toolName==="read" && readInputs.has(event.toolCallId)) { run.native.set("read:"+readInputs.get(event.toolCallId),JSON.parse(JSON.stringify({content:event.content,details:event.details,isError:event.isError}))); readInputs.delete(event.toolCallId); }
    if (["task", "hub", "bash"].includes(event.toolName) && run.evalAction) { const observed = JSON.parse(JSON.stringify({ content: event.content, details: event.details, isError: event.isError })); run.native.set(run.evalAction, observed); run.native.set(event.toolCallId, observed); }
    if (event.toolName === "eval" && event.toolCallId === run.evalCallId) {
      const action = run.state.actions.find(action => action.id === run.evalAction); run.evalAction = undefined; run.evalCallId = undefined; run.evalExecuting = undefined;
      const details = event.details as {isError?:boolean;cells?:Array<{status?:string}>} | undefined;
      if ((event.isError || details?.isError || details?.cells?.some(cell=>cell.status==="error")) && action) { const ref = await evidence("control-error", { actionId: action.id, content: event.content }, "Control cell failed; execution effects may exist."); await persist({ kind: "record-runtime-snapshot", snapshot: readRuntimeSnapshot(ctx, run.state, syncConcurrencyCap(run.settings, run.state.limits.concurrency)) }); await pause(`Control action ${action.id} failed. Inspect ${ref.uri} and live owners before retry.`, ctx); }
    }
  });
  api.on("session_shutdown", async () => { if (active && !active.state.recovery && !["completed", "cancelled"].includes(active.state.lifecycle)) await persist({ kind: "request-cancel", reason: "Session shutdown; runtime cancellation is not yet confirmed.", evidence: [] }).catch(() => undefined); await release(); });
}
