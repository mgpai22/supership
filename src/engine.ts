import {
  DecisionContextSchema, EngineInputSchema, RunEventSchema, RunRecordSchema, SchedulingSnapshotSchema,
  assertSchema, canonicalJson, digestJson, persistedSchemaByName, toolApprovalScope,
  type ActionDraft, type ActionRecord, type ApprovalRecord, type Decision, type DecisionContext, type EngineInput,
  type CapturedToolProposal, type CommitGroup, type PoolRecord, type FindingRecord, type JudgeOutput, type ReviewRoundRecord, type ToolDefinitionRecord, type WorkContext, type WorkerOutput, type ReceiptObservation, type EvidenceRef, type Fact, type Phase, type PlanRecord, type RecoveryRecord, type RunEvent, type RunRecord,
  type RuntimeOwner, type SchedulingSnapshot, type ValidationIssue, type WorkAssignment, type WorkItem, type WorkRef,
} from "./contracts.ts";

export const GENESIS_HASH = "0".repeat(64);
const terminalWork = (work: WorkItem) => ["succeeded", "failed", "superseded", "cancelled"].includes(work.status);
const workMatches = (work: WorkItem, ref: WorkRef) => work.id === ref.id && work.revision === ref.revision && work.attempt.id === ref.attemptId;
const liveOwners = (state: RunRecord) => [...state.work.flatMap(work => work.runtimeOwners), ...state.pools.flatMap(pool => pool.status !== "closed" && pool.owner ? [pool.owner] : [])].filter(owner => owner.status !== "observed-terminal");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const reject = (code: string, message: string): Decision => ({ kind: "reject", code, message, evidence: [] });
const append = (...facts: Fact[]): Decision => ({ kind: "append", facts });
const recovery = (state: RunRecord, reason: string, affected: WorkItem[] = state.work.filter(work => ["running", "awaiting-output", "awaiting-recovery"].includes(work.status))): RecoveryRecord => ({ scope: "run", intent: "resume", primaryReason: reason, triggers: [reason], affectedWork: affected.map(({ id, revision }) => ({ id, revision })), unresolvedOwners: liveOwners(state), resumePhase: state.phase, requiredChoices: ["inspect", "adopt", "retry", "discard", "stop"], evidence: [] });
const initialWork = (assignment: WorkAssignment): WorkItem => ({ ...assignment, schemaVersion: 1, attempt: { id: `${assignment.id}:r${assignment.revision}:1`, number: 1, validationStage: "initial", seatId: assignment.seatId }, status: "pending", runtimeOwners: [] });

export function classifyAmendment(previous: PlanRecord, next: PlanRecord): "ordinary" | "material" | "safety" {
  if (next.scope.effects.some(effect => !previous.scope.effects.includes(effect) && /destruct|credential|production|publish|delete/i.test(effect))) return "safety";
  const shape = (plan: PlanRecord) => ({ scope: plan.scope, risks: plan.risks, tools: plan.toolProposals, dependencies: plan.items.map(item => ({ id: item.id, dependencies: item.dependencies.map(ref => ref.id), paths: item.expectedPaths, grants: item.toolGrants, mutation: item.mutation })) });
  return same(shape(previous), shape(next)) ? "ordinary" : "material";
}

export function validatePlan(plan: PlanRecord, state: RunRecord): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ code: "invalid-plan", path, message, evidence: [] });
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (ids.has(item.id)) issue("items", `Duplicate item ${item.id}`);
    ids.add(item.id);
    const previous = state.plan?.items.find(previous => previous.id === item.id);
    if (previous && !same(previous, item) && item.revision <= previous.revision) issue("items", `Changed item ${item.id} must advance its revision and migrate dependency references`);
    if (!state.seats.some(seat => seat.seatId === item.seatId)) issue("items", `Missing seat ${item.seatId}`);
    if (!item.expectedPaths.every(path => plan.scope.paths.some(scope => pathsOverlap(scope, path)))) issue("items", `Item ${item.id} expands plan paths`);
    for (const dependency of item.dependencies) if (!plan.items.some(candidate => candidate.id === dependency.id && candidate.revision === dependency.revision)) issue("items", `Missing dependency ${dependency.id}@${dependency.revision}`);
    for (const check of item.verificationCheckIds) if (!plan.verificationChecks.some(candidate => candidate.id === check)) issue("items", `Missing verification check ${check}`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { issue("items", `Dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of plan.items.find(item => item.id === id)?.dependencies ?? []) visit(dependency.id);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  for (const lens of ["correctness", "simplicity", ...state.policy.requiredLenses]) if (!plan.requiredLenses.includes(lens)) issue("requiredLenses", `Missing mandatory lens ${lens}`);
  if (plan.items.length === 0 && !plan.noChangeReason) issue("noChangeReason", "An empty plan needs a no-change reason");
  if (plan.fastPath && (plan.items.filter(item => item.kind === "build").length !== 1 || !ids.has(plan.fastPath.workerId))) issue("fastPath", "Fast path requires one declared builder");
  for (const requirement of state.policy.requiredVerification ?? []) {
    if (requirement.scopePaths.length && !plan.scope.paths.some(path => requirement.scopePaths.some(scope => pathsOverlap(scope, path)))) continue;
    const check = plan.verificationChecks.find(check => check.id === requirement.id && check.required);
    if (!check || !requirement.scopePaths.every(path => check.scopePaths.some(scope => pathsOverlap(scope, path)))) issue("verificationChecks", `Required repository verification ${requirement.id} needs an executable check covering its scope`);
  }
  const requiredSeats = new Set(["judge", ...(state.invocation.topology === "normal" ? [] : ["judge-secondary"]), ...requiredLenses({ ...state, plan }), ...state.policy.pathRouting.filter(rule => plan.items.some(item => item.expectedPaths.some(path => rule.paths.some(scope => scopeMatches(scope, path))))).map(rule => rule.seatId), ...state.policy.phaseGates.flatMap(gate => gate.requirement.kind === "consultation" && (gate.paths.length === 0 || plan.scope.paths.some(path => gate.paths.some(scope => scopeMatches(scope, path)))) ? [gate.requirement.seatId] : []), ...(plan.items.some(item => item.mutation !== "read-only") ? ["builder"] : [])]);
  for (const seat of requiredSeats) if (!state.seats.some(binding => binding.seatId === seat)) issue("seats", "Missing required seat " + seat);
  for (const item of plan.items) {
    for (const route of state.policy.pathRouting) if (item.expectedPaths.some(path => route.paths.some(scope => scopeMatches(scope, path))) && item.seatId !== route.seatId) issue("pathRouting", "Path route " + route.id + " requires " + route.seatId + " for item " + item.id);
    for (const gate of state.policy.phaseGates) {
      if (gate.paths.length && !item.expectedPaths.some(path => gate.paths.some(scope => scopeMatches(scope, path)))) continue;
      if (gate.requirement.kind === "dependency") for (const prerequisite of gate.requirement.prerequisiteIds) if (item.id !== prerequisite && !item.dependencies.some(dependency => dependency.id === prerequisite)) issue("phaseGates", "Item " + item.id + " needs prerequisite " + prerequisite);
      if (gate.requirement.kind === "verification") for (const checkId of gate.requirement.checkIds) if (!plan.verificationChecks.some(check => check.id === checkId && check.required)) issue("verificationChecks", "Required policy check " + checkId + " has no executable plan check");
    }
  }
  for (const group of plan.commitGroups) for (const id of group.workIds) if (!ids.has(id)) issue("commitGroups", `Unknown work ${id}`);
  return issues;
}

function scopeMatches(scope: string, path: string): boolean { if (!/[?*[{]/.test(scope)) return pathsOverlap(scope, path); const glob = new Bun.Glob(scope); return glob.match(path) || glob.match(path + "/"); }

export function pathsOverlap(left: string, right: string): boolean {
  // Declared directory paths reserve their descendants. Wildcards conservatively reserve their literal prefix.
  const prefix = (path: string) => { const wildcard = path.search(/[?*[{]/); return (wildcard < 0 ? path : path.slice(0, wildcard).slice(0, path.slice(0, wildcard).lastIndexOf("/") + 1)).replace(/\/$/, ""); };
  const a = prefix(left), b = prefix(right);
  return !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}


function policyGateScope(state: RunRecord, gate: RunRecord["policy"]["phaseGates"][number]): string { return digestJson({ gateId: gate.id, planRevision: state.planRevision, codeIdentity: state.code?.identity ?? null }); }
function pendingPolicyGate(state: RunRecord): RunRecord["policy"]["phaseGates"][number] | undefined {
  for (const gate of state.policy.phaseGates) {
    const paths = state.plan?.scope.paths ?? state.code?.paths.map(path => path.path) ?? [];
    if (!gate.phases.includes(state.phase) || gate.paths.length && !paths.some(path => gate.paths.some(scope => scopeMatches(scope, path)))) continue;
    const requirement = gate.requirement, scope = policyGateScope(state, gate);
    if (requirement.kind === "approval" && !state.approvals.some(approval => approval.kind === requirement.approvalKind && approval.scopeHash === scope && approval.decision === "approve")) return gate;
    if (requirement.kind === "consultation" && !state.work.some(work => work.context?.kind === "consultation" && work.context.gateId === gate.id && work.context.scopeHash === scope && work.status === "succeeded" && work.evidence.every(ref => ref.availability === "available"))) return gate;
    if (requirement.kind === "verification" && !requirement.checkIds.every(id => state.verification.some(result => result.checkId === id && result.outcome === "passed" && sameRelevantCode(result.codeIdentity, state.code?.identity) && result.evidence.length && result.evidence.every(ref => ref.availability === "available")))) return gate;
  }
  return undefined;
}
function planClassification(state: RunRecord, plan: PlanRecord): "ordinary" | "material" | "safety" {
  if (state.plan) return classifyAmendment(state.plan, plan);
  if (plan.scope.effects.some(effect => /destruct|credential|production|publish|delete/i.test(effect))) return "safety";
  return state.invocation.mode === "review-only" ? "ordinary" : "material";
}

function canRun(state: RunRecord, work: WorkItem): boolean {
  if (work.status !== "pending" || work.mutation !== "read-only" && state.phase !== "build") return false;
  if (state.recovery && (state.recovery.scope === "run" || state.recovery.affectedWork.some(ref => ref.id === work.id && ref.revision === work.revision))) return false;
  if (!work.dependencies.every(dependency => state.work.some(other => other.id === dependency.id && other.revision === dependency.revision && other.status === "succeeded" && (other.mutation === "read-only" || other.isolation.kind !== "worktree" || state.gitOutcomes.some(outcome => outcome.operation === "integrate" && outcome.work && workMatches(other, outcome.work)))))) return false;
  if (!state.seats.some(seat => seat.seatId === work.attempt.seatId)) return false;
  if (work.mutation !== "read-only" && state.work.some(prior => prior.id === work.id && prior.revision < work.revision && prior.status === "succeeded" && prior.mutation !== "read-only" && prior.isolation.kind === "worktree" && !state.gitOutcomes.some(outcome => outcome.operation === "integrate" && outcome.work && workMatches(prior, outcome.work)))) return false;
  if (work.context?.kind !== "consultation" && pendingPolicyGate(state)) return false;
  if (work.mutation !== "read-only" && (!state.plan || (!state.plan.items.some(item => item.id === work.id && item.revision === work.revision) && !(work.context?.kind === "fix" && work.context.findingIds.every(id => unresolvedFindings(state).some(finding => finding.id === id)))) || !planApproved(state))) return false;
  return work.toolGrants.every(grant => state.tools.some(tool => tool.name === grant.name && tool.version === grant.version && tool.registration === "registered" && tool.kernelGeneration === state.kernelGeneration && tool.approvalId === grant.approvalId && tool.grants.some(recipient => recipient.workId === work.id && recipient.workRevision === work.revision && recipient.seatId === work.attempt.seatId)));
}
export function planApprovalScope(plan: PlanRecord): string { return digestJson(plan); }
function planApproved(state: RunRecord): boolean { return state.invocation.mode === "review-only" && state.planChange?.classification === "ordinary" || !!currentPlanApproval(state); }

export function selectNextAction(state: RunRecord, observed: SchedulingSnapshot): ActionDraft | undefined {
  assertSchema(RunRecordSchema, state, "run"); assertSchema(SchedulingSnapshotSchema, observed, "runtime snapshot");
  const draft = (input: ActionDraft["input"], recipients: ActionDraft["recipients"] = []): ActionDraft => ({ input, recipients, planRevision: state.planRevision });
  const collect = (kind: "clarification" | "approval" | "recovery", id: string, prompt: string, choices: string[], scopeHash: string) => draft({ kind: "collect_input", request: { kind, id, prompt, choices }, scopeHash });
  if (["completed", "cancelled"].includes(state.lifecycle) || state.actions.some(action => action.status === "issued" && action.expectedStateRevision === state.eventSequence)) return undefined;
  const pendingCancellation = state.actions.find(action => action.input.kind === "cancel_runtime" && ["claimed", "running"].includes(action.status));
  if (pendingCancellation?.input.kind === "cancel_runtime" && ["active", "cancelling"].includes(state.lifecycle)) return draft({ kind: "wait", owners: pendingCancellation.input.owners });
  const revokedOwners = state.work.filter(work => work.status === "superseded").flatMap(work => work.runtimeOwners).filter(owner => owner.status !== "observed-terminal");
  if (revokedOwners.length) return draft({ kind: "cancel_runtime", owners: revokedOwners, reason: "Stop superseded work without cancelling unrelated workers" });
  if (state.lifecycle === "cancelling") {
    // Runtime termination can precede the cancel action; keep owners until their logical work or pool settles.
    const owners = [...state.work.flatMap(work => work.runtimeOwners.filter(owner => owner.status !== "observed-terminal" || !terminalWork(work))), ...state.pools.flatMap(pool => pool.status !== "closed" && pool.owner ? [pool.owner] : [])];
    if (owners.length) return draft({ kind: "cancel_runtime", owners, reason: state.recovery?.primaryReason ?? "Cancellation requested" });
    return collect("recovery", "cancel-reconciliation", "A spawn has no confirmed runtime receipt. Inspect jobs, worktrees and parent effects before confirming settlement.", ["discard: confirmed stopped", "stop"], digestJson(state.recovery ?? { intent: "cancel" }));
  }
  if (state.recovery?.scope === "run") return collect("recovery", state.recovery.primaryReason, state.recovery.primaryReason + ": " + state.recovery.triggers.join("; "), state.recovery.requiredChoices, digestJson(state.recovery));
  if (state.lifecycle !== "active") return undefined;
  if (observed.unknownOwners.length) return draft({ kind: "wait", owners: observed.unknownOwners });
  const declinedTool = state.tools.find(tool => tool.registration === "proposed" && !state.approvals.some(approval => approval.scopeHash === tool.approvalScopeHash && approval.decision === "decline"));
  if (declinedTool) return collect("approval", "tool-" + declinedTool.name + "-" + declinedTool.version, "Review exact tool source/schema/grants. Worktree isolation with parent access is not a sandbox.", ["approve", "decline"], declinedTool.approvalScopeHash);
  const approvedTool = state.tools.find(tool => tool.registration === "approved");
  if (approvedTool?.approvalId) return { ...draft({ kind: "register_tool", toolName: approvedTool.name, toolVersion: approvedTool.version, approvalId: approvedTool.approvalId, approvalScopeHash: approvedTool.approvalScopeHash, sourceHash: approvedTool.sourceHash, schemaHash: approvedTool.schemaHash, generation: state.kernelGeneration }), kernelGeneration: state.kernelGeneration };
  if (state.phase === "clarify" && !state.clarificationCompleted) return collect("clarification", "clarify", "Confirm the goal, exclusions, acceptance checks, risks and unspecified run limits. Omitted cost/time/round caps remain unlimited.", [], digestJson(state.invocation));
  if ((state.phase === "approval" || state.phase === "build" && !planApproved(state)) && state.plan) {
    if (!planApproved(state)) {
      // A review-only run has no initial plan gate, so its first collected plan decision is already a scope/risk amendment.
      const approvalKind = state.planChange?.classification === "safety" ? "safety" : state.invocation.mode === "review-only" || state.approvals.some(approval => approval.kind === "initial-plan" && approval.decision === "approve") ? "material-amendment" : "initial-plan";
      return draft({ kind: "collect_input", request: { kind: "approval", id: approvalKind === "safety" ? "safety-amendment" : approvalKind, approvalKind, prompt: "Review the proposed plan and its scope, effects, risks and verification checks.", choices: ["approve", "decline"] }, scopeHash: planApprovalScope(state.plan) });
    }
    if (state.plan.fastPath && !state.approvals.some(approval => approval.kind === "fast-path" && approval.decision === "approve" && approval.scopeHash === digestJson(state.plan!.fastPath))) return collect("approval", "fast-path", "Confirm the single-worker downgrade: " + state.plan.fastPath.reason, ["approve", "decline"], digestJson(state.plan.fastPath));
  }
  if (!state.code && ["build", "review", "verify", "commit", "publish", "conclude"].includes(state.phase)) return draft({ kind: "observe_git", scopePaths: state.plan?.scope.paths ?? [], purpose: "Capture current integrated code and dirty baseline ownership" });
  const gate = pendingPolicyGate(state);
  if (gate?.requirement.kind === "approval") return draft({ kind: "collect_input", scopeHash: policyGateScope(state, gate), request: { kind: "approval", id: "gate-" + gate.id, approvalKind: gate.requirement.approvalKind, prompt: "Repository policy requires approval: " + gate.id, choices: ["approve", "decline"] } });
  if (gate?.requirement.kind === "verification" && state.code) {
    const ids = gate.requirement.checkIds, check = state.plan?.verificationChecks.find(check => ids.includes(check.id) && !state.verification.some(result => result.checkId === check.id && result.outcome === "passed" && sameRelevantCode(result.codeIdentity, state.code!.identity)));
    if (check) return draft({ kind: "verify", check, expectedCode: state.code.identity });
  }
  if (state.phase === "build" && state.code && !state.gitOutcomes.some(output => output.operation === "create_branch")) return draft({ kind: "create_branch", branch: state.invocation.outputBranch ?? "supership/" + state.slug, expectedCode: state.code.identity });
  const cap = Math.min(observed.ompCeiling ?? Infinity, state.limits.concurrency ?? Infinity);
  const available = cap - new Set([...observed.activeOwners.filter(owner => owner.kind !== "pool").map(owner => owner.id), ...state.work.filter(work => ["running", "awaiting-recovery"].includes(work.status)).flatMap(work => work.runtimeOwners.length ? work.runtimeOwners.filter(owner => owner.kind !== "pool" && owner.status !== "observed-terminal").map(owner => owner.id) : [work.id + "@" + work.revision])]).size;
  const pooled = new Set(state.pools.filter(pool => !["closed", "lost"].includes(pool.status)).flatMap(pool => pool.items.map(item => item.work.id + "@" + item.work.revision)));
  for (const pool of state.pools) {
    if (pool.status === "pending") return draft({ kind: "pool_create", poolId: pool.id, lens: pool.lens, round: pool.round, seatId: pool.seatId, contextRef: pool.contextRef, contextHash: pool.contextHash, toolGrants: pool.toolGrants });
    // A WorkPool settles and closes on its first full drain, so every pending item goes in one push; the runtime bounds one pool's
    // workers at min(OMP ceiling, run limit), so the push waits until the aggregate has room for the workers this pool can spawn.
    const pending = pool.items.filter(item => item.key === undefined && state.work.some(work => workMatches(work, item.work) && canRun(state, work)));
    if (pool.status === "running" && pending.length && available >= Math.min(pending.length, cap)) {
      const work = pending.map(item => state.work.find(work => workMatches(work, item.work))!);
      return draft({ kind: "pool_push", poolId: pool.id, items: work.map((item, index) => ({ logicalId: pending[index].logicalId, work: pending[index].work, assignment: workAssignment(item) })) }, work.map(workRecipient));
    }
    if (pool.status === "running" && pool.items.every(item => state.work.some(work => workMatches(work, item.work) && terminalWork(work)))) return draft({ kind: "pool_close", poolId: pool.id, reason: "Every logical item settled; close this lens/round pool" });
  }
  const pendingPatch = state.patches.find(patch => state.work.some(work => workMatches(work, patch.work) && work.status === "succeeded") && planApproved(state) && patch.changedPaths.every(path => state.plan?.scope.paths.some(scope => pathsOverlap(scope, path))) && !state.gitOutcomes.some(output => output.operation === "integrate" && output.work && same(output.work, patch.work)));
  if (pendingPatch && state.code) return draft({ kind: "integrate", work: pendingPatch.work, patchRef: pendingPatch.patchRef, expectedBefore: state.code.identity, overlapEvidence: pendingPatch.ownershipEvidence });
  const chosen: WorkItem[] = [], running = state.work.filter(work => ["running", "awaiting-recovery"].includes(work.status));
  if (available > 0) for (const work of state.work) {
    if (!canRun(state, work) || pooled.has(work.id + "@" + work.revision)) continue;
    const paths = reservedPaths(state, work);
    if (work.mutation !== "read-only" && [...running, ...chosen].some(other => other.mutation !== "read-only" && (work.isolation.kind === "active-checkout" || other.isolation.kind === "active-checkout" || paths.some(a => reservedPaths(state, other).some(b => pathsOverlap(a, b)))))) continue;
    chosen.push(work); if (chosen.length >= available) break;
  }
  if (chosen.length) return draft({ kind: "run_finite", scheduler: chosen.some(work => work.mutation !== "read-only" && work.isolation.kind === "worktree" || work.kind === "review" || work.kind === "judge" || work.kind === "critique" || work.context?.kind === "planning" && work.context.stage === "blind-b") ? "agent" : "task", work: chosen.map(work => ({ id: work.id, revision: work.revision, attemptId: work.attempt.id })), assignments: chosen.map(work => currentAssignment(state, work)) }, chosen.map(workRecipient));
  const owners = [...new Map([...liveOwners(state), ...state.work.filter(work => work.status === "running").flatMap(work => work.runtimeOwners)].map(owner => [runtimeIdentity(owner), owner])).values()];
  if (owners.length) return draft({ kind: "wait", owners });
  if (state.phase === "build" && state.code && state.work.some(work => work.mutation !== "read-only" && work.completedAt && work.completedAt > state.code!.observedAt)) return draft({ kind: "observe_git", scopePaths: state.plan?.scope.paths ?? [], purpose: "Observe completed mutation effects; worker assertions are not verification" });
  // Required proof can be invalidated after the verify phase (stale evidence on resume); re-verify wherever the run stands.
  if (["verify", "commit", "publish", "conclude"].includes(state.phase) && state.code) {
    const check = state.plan?.verificationChecks.find(check => check.required && !state.verification.some(result => result.checkId === check.id && result.outcome === "passed" && sameRelevantCode(result.codeIdentity, state.code!.identity) && result.evidence.length && result.evidence.every(ref => ref.availability === "available")));
    if (check) return draft({ kind: "verify", check, expectedCode: state.code.identity });
  }
  if (state.phase === "commit" && state.plan && state.code && planApproved(state)) {
    const group = commitGroups(state).find(group => !state.gitOutcomes.some(output => output.operation === "commit" && (output.groupIds?.includes(group.id) || output.groupId === group.id)));
    const approval = currentPlanApproval(state);
    if (group) return draft({ kind: "commit", group, expectedCode: state.code.identity, ...(approval ? { approvalId: approval.id } : {}) });
  }
  if (state.phase === "publish" && state.code) {
    const commits = [...new Set(state.gitOutcomes.filter(output => output.operation === "commit").flatMap(output => output.commits))];
    if (!state.pushTarget && commits.length) return draft({ kind: "prepare_push", commits, expectedCode: state.code.identity });
    if (state.pushTarget) {
      const approval = state.approvals.find(approval => approval.kind === "push" && approval.scopeHash === state.pushTarget!.scopeHash && approval.ownerEpoch === state.owner.epoch && approval.decision === "approve");
      if (!approval) return collect("approval", "push", "CAUTION: Publish exact commits to " + state.pushTarget.remote + " (" + state.pushTarget.url + ") branch " + state.pushTarget.branch + ": " + state.pushTarget.commits.join(", "), ["approve", "decline"], state.pushTarget.scopeHash);
      return draft({ kind: "push", remote: state.pushTarget.remote, branch: state.pushTarget.branch, commits: state.pushTarget.commits, approvalId: approval.id, approvalScopeHash: approval.scopeHash });
    }
  }
  if (state.recovery) return collect("recovery", state.recovery.primaryReason, state.recovery.primaryReason, state.recovery.requiredChoices, digestJson(state.recovery));
  if (state.phase === "conclude" && !completionError(state)) return draft({ kind: "conclude", conclusion: { kind: generatedChange(state) ? "changed" : "no-change", summary: generatedChange(state) ? "The requested changes passed review and current runtime verification." : noChangeReason(state) ?? "No attributable code change was required after review and verification.", evidence: [...state.verification.filter(result => result.outcome === "passed").flatMap(result => result.evidence), ...(state.code?.evidence ?? [])], lessons: [], unresolvedDeferredFindingIds: state.findings.filter(finding => finding.resolution?.kind === "explicitly-deferred").map(finding => finding.id), completedAt: state.updatedAt } });
  return undefined;
}
function workAssignment({ schemaVersion, attempt, status, runtimeOwners, completedAt, result, ...assignment }: WorkItem): WorkAssignment { return assignment; }
// The plan records the isolation base it was written against; the checkout a worktree starts from is the code observed now.
function currentAssignment(state: RunRecord, work: WorkItem): WorkAssignment { const assignment = workAssignment(work); return assignment.isolation.kind === "worktree" && state.code ? { ...assignment, isolation: { ...assignment.isolation, base: state.code.identity } } : assignment; }
function workRecipient(work: WorkItem): ActionDraft["recipients"][number] { return { workId: work.id, workRevision: work.revision, attemptId: work.attempt.id, seatId: work.attempt.seatId, toolVersions: work.toolGrants.map(({ name, version }) => ({ name, version })) }; }
function reservedPaths(state: RunRecord, work: WorkItem): string[] { return [...work.expectedPaths, ...work.toolGrants.flatMap(grant => state.tools.find(tool => tool.name === grant.name && tool.version === grant.version)?.effects.paths ?? [])]; }

function actionIssueError(state: RunRecord, draft: ActionDraft): string | undefined {
  if (draft.planRevision !== state.planRevision) return "Action targets a stale plan revision";
  if (state.actions.some(action => action.status === "issued" && action.expectedStateRevision === state.eventSequence)) return "An action is already awaiting claim";
  const selected = selectNextAction(state, state.runtime ?? { ompCeiling: state.usage.ompConcurrencyCeiling, activeOwners: [], knownCompletedOwners: [], unknownOwners: [], observedAt: state.updatedAt });
  if (!selected) return "No action is eligible";
  if (draft.input.kind === "run_finite" && selected.input.kind === "run_finite") {
    const selection = selected.input, input = draft.input;
    if (input.scheduler !== selection.scheduler || new Set(input.work.map(work => work.id)).size !== input.work.length || !input.work.every(ref => selection.work.some(candidate => same(ref, candidate)))) return "Work exceeds current dependency, concurrency or isolation policy";
    if (!same(input.assignments, input.work.map(ref => selection.assignments.find(item => item.id === ref.id && item.revision === ref.revision))) || !same(draft.recipients, input.work.map(ref => selected.recipients.find(recipient => recipient.workId === ref.id && recipient.workRevision === ref.revision)))) return "Work assignments or recipients differ from the selected work";
    return undefined;
  }
  return same({ input: draft.input, recipients: draft.recipients, planRevision: draft.planRevision, ...(draft.kernelGeneration !== undefined ? { kernelGeneration: draft.kernelGeneration } : {}) }, selected) ? undefined : "Action differs from the current engine-selected operation";
}

export function toolApprovalNeedsTui(state: RunRecord, definition: ToolDefinitionRecord): boolean {
  return ["external", "unknown"].includes(definition.effects.kind) || definition.effects.kind !== "read-only" && (!definition.effects.paths.length || definition.effects.paths.some(path => !state.plan?.scope.paths.some(scope => scopeMatches(scope, path))));
}
function approvalError(state: RunRecord, approval: ApprovalRecord): string | undefined {
  if (approval.authority === "cli-terminal" && approval.kind !== "cleanup") return "Workflow approval requires OMP TUI authority";
  if (approval.ownerEpoch !== state.owner.epoch || approval.planRevision !== state.planRevision) return "Stale approval";
  if (approval.authority === "autonomous-policy" && (state.invocation.mode !== "autonomous" || !["initial-plan", "material-amendment", "fast-path", "tool"].includes(approval.kind))) return "This decision requires trusted TUI confirmation";
  const gateApproval = state.policy.phaseGates.some(gate => gate.requirement.kind === "approval" && gate.requirement.approvalKind === approval.kind && approval.scopeHash === policyGateScope(state, gate));
  if (["initial-plan", "material-amendment", "safety"].includes(approval.kind) && !gateApproval && (!state.plan || approval.scopeHash !== digestJson(state.plan))) return "Plan approval scope changed";
  if (approval.kind === "tool") {
    const target = approval.toolVersions.length === 1 && state.tools.find(tool => tool.name === approval.toolVersions[0].name && tool.version === approval.toolVersions[0].version);
    if (!target || target.registration !== "proposed" || target.approvalScopeHash !== approval.scopeHash || target.approvalScopeHash !== toolApprovalScope(target, target.grants)) return "Tool approval requires the exact proposed source, schema, effects and grants";
    if (approval.authority === "autonomous-policy" && toolApprovalNeedsTui(state, target)) return "Unknown, external or out-of-scope effects require trusted TUI approval";
  }
  if (approval.kind === "fast-path" && (!state.plan?.fastPath || approval.scopeHash !== digestJson(state.plan.fastPath))) return "Fast-path approval scope changed";
  return undefined;
}
function cancellationReady(state: RunRecord): boolean {
  return liveOwners(state).length === 0 && !state.toolInvocations.some(invocation => ["running", "uncertain"].includes(invocation.outcome)) && state.work.every(work => terminalWork(work)) && state.work.filter(work => work.mutation !== "read-only" && work.isolation.kind === "worktree" && work.runtimeOwners.length > 0).every(work => state.patches.some(patch => workMatches(work, patch.work)));
}
// A failed report correction is obsolete once the work it was correcting has itself settled (adopted, corrected, discarded or superseded).
function obsoleteCorrection(state: RunRecord, work: WorkItem): boolean {
  if (work.status !== "failed" || work.context?.kind !== "correction") return false;
  const ref = work.context.original, original = state.work.find(candidate => candidate.id === ref.id && candidate.revision === ref.revision);
  return !!original && terminalWork(original) && original.status !== "failed";
}
function completionError(state: RunRecord): string | undefined {
  if (state.phase !== "conclude" || state.lifecycle !== "active" || state.recovery) return "Run has not reached an active conclusion";
  if (state.work.some(work => !terminalWork(work) || work.status === "failed" && !obsoleteCorrection(state, work)) || liveOwners(state).length || state.toolInvocations.some(invocation => invocation.outcome === "running" || invocation.outcome === "uncertain")) return "Work or runtime owners remain unresolved";
  if (state.actions.some(action => ["issued", "claimed", "running", "uncertain"].includes(action.status) && action.input.kind !== "conclude")) return "An action remains unsettled";
  if (unresolvedFindings(state).length) return "An accepted finding remains unresolved";
  if (!verificationReady(state)) return "Current runtime verification is required";
  const round = state.reviewRounds.at(-1);
  if (!round?.completedAt || !sameRelevantCode(round.codeIdentity, state.code?.identity)) return "The current code has not completed review";
  if (state.invocation.commitRequested && generatedChange(state) && !state.gitOutcomes.some(output => output.operation === "commit")) return "Requested commits remain unresolved";
  if (state.invocation.pushRequested && generatedChange(state) && !state.gitOutcomes.some(output => output.operation === "push") && !state.approvals.some(approval => approval.kind === "push" && approval.decision === "decline")) return "Requested publication remains unresolved";
  return undefined;
}

export function currentPlanApproval(state: RunRecord): ApprovalRecord | undefined {
  const scope = state.planChange?.classification === "ordinary" ? state.planChange.approvedScopeHash : state.plan && digestJson(state.plan);
  return scope ? state.approvals.find(approval => ["initial-plan", "material-amendment", "safety"].includes(approval.kind) && approval.decision === "approve" && approval.scopeHash === scope) : undefined;
}
function requiredLenses(state: RunRecord): string[] {
  return [...new Set(["correctness", "simplicity", ...state.policy.requiredLenses, ...(state.plan?.requiredLenses ?? []), ...(state.plan?.risks.flatMap(risk => ["security", "data", "performance", "ui"].includes(risk.kind) ? [risk.kind === "data" ? "security" : risk.kind, ...risk.requiredLenses] : risk.requiredLenses) ?? [])])];
}
function unresolvedFindings(state: RunRecord): FindingRecord[] {
  return state.findings.filter(finding => finding.verdicts.some(verdict => verdict.verdict === "accepted") && !finding.resolution);
}

function mergeUsageSources(previous: RunRecord["usageSources"], incoming: RunRecord["usageSources"]): RunRecord["usageSources"] {
  const sources = new Map(previous.map(source => [source.id, source]));
  for (const source of incoming) {
    const old = sources.get(source.id);
    if (old && old.model !== source.model) throw new Error("Usage source changed model identity");
    if (!old) { sources.set(source.id, source); continue; }
    const tokens = Math.max(old.tokens, source.tokens);
    let costAmount = old.costAmount;
    if (source.tokens >= old.tokens) costAmount = source.costAmount === null ? source.tokens > old.tokens ? null : old.costAmount : old.costAmount === null ? source.costAmount : Math.max(old.costAmount, source.costAmount);
    sources.set(source.id, { ...old, complete: source.tokens >= old.tokens ? source.complete || old.complete && source.tokens === old.tokens : old.complete, tokens, costAmount, observedAt: Math.max(old.observedAt, source.observedAt) });
  }
  return [...sources.values()];
}
function mergeUsageCoverage(state: RunRecord, incoming: RunRecord["usageCoverage"]): RunRecord["usageCoverage"] {
  const coverage = new Map(state.usageCoverage.map(record => [record.id, record]));
  for (const record of incoming) {
    const action = state.actions.find(action => action.id === record.actionId);
    if (!action || !record.work.every(ref => action.recipients.some(recipient => recipient.workId === ref.id && recipient.workRevision === ref.revision && recipient.attemptId === ref.attemptId))) throw new Error("Usage coverage names work this run never authorized");
    const old = coverage.get(record.id);
    if (old && (old.actionId !== record.actionId || !same(old.work, record.work))) throw new Error("Usage coverage changed execution identity");
    if (!old || record.observedAt >= old.observedAt) coverage.set(record.id, record);
  }
  return [...coverage.values()];
}
function sourceUsage(state: RunRecord, sources: RunRecord["usageSources"], coverage: RunRecord["usageCoverage"], now: number): RunRecord["usage"] {
  // One absurd child row must not wedge every later usage record: saturate at the schema bound; caps and overshoot still trigger.
  const tokens = sources.reduce((total, source) => source.tokens > Number.MAX_SAFE_INTEGER - total ? Number.MAX_SAFE_INTEGER : total + source.tokens, 0), unknown = sources.filter(source => source.costAmount === null);
  // Individual costs stay canonical in the sources; the subtotal saturates at the largest finite number instead of becoming Infinity.
  const pricedSubtotal = sources.reduce((total, source) => { const next = total + (source.costAmount ?? 0); return Number.isFinite(next) ? next : Number.MAX_VALUE; }, 0);
  const amount = unknown.length || sources.some(source => !source.complete) || coverage.some(record => record.status !== "complete") ? null : pricedSubtotal;
  const cap = state.limits.cost?.currency === "USD" ? state.limits.cost.amount : undefined;
  return { ...state.usage, tokens, cost: { amount, pricedSubtotal, currency: "USD", unpricedModels: [...new Set(unknown.map(source => source.model))].sort() }, activeOwners: state.runtime ? new Set(state.runtime.activeOwners.filter(owner => owner.kind !== "pool").map(owner => owner.id)).size : state.usage.activeOwners, ompConcurrencyCeiling: state.runtime ? state.runtime.ompCeiling : state.usage.ompConcurrencyCeiling, observedAt: now, overshoot: { tokens: state.limits.tokens === undefined ? 0 : Math.max(0, tokens - state.limits.tokens), cost: cap === undefined || unknown.length === sources.length && amount === null ? null : Math.max(0, pricedSubtotal - cap), wallMs: state.limits.wallMs === undefined ? 0 : Math.max(0, now - state.createdAt - state.limits.wallMs) } };
}

function limitTriggers(state: RunRecord, usage: RunRecord["usage"], now = state.updatedAt): string[] {
  const triggers: string[] = [];
  if (state.limits.tokens !== undefined && usage.tokens >= state.limits.tokens) triggers.push("token-cap");
  if (state.limits.wallMs !== undefined && now - state.createdAt >= state.limits.wallMs) triggers.push("wall-time-cap");
  if (state.limits.cost && usage.cost.currency === state.limits.cost.currency && usage.cost.pricedSubtotal >= state.limits.cost.amount) triggers.push("cost-cap");
  if (state.limits.reviewRounds !== undefined && (state.reviewRounds.filter(round => round.completedAt !== undefined).at(-1)?.round ?? 0) >= state.limits.reviewRounds && unresolvedFindings(state).length) triggers.push("review-round-cap");
  return triggers;
}
function noDecision(state: RunRecord): Decision { return { kind: "duplicate", eventSequence: state.eventSequence }; }
function phaseFact(state: RunRecord, to: Phase, reason: string): Fact { return { kind: "phase-changed", from: state.phase, to, reason, evidence: [] }; }
function seatWork(state: RunRecord, id: string, kind: WorkAssignment["kind"], seatId: string, instructions: string, dependencies: WorkItem[] = [], context?: WorkAssignment["context"]): WorkItem {
  const schema: Record<WorkAssignment["kind"], WorkAssignment["outputSchema"]["name"]> = { research: "research", plan: "plan", critique: "critique", synthesis: "plan", build: "build", review: "review", judge: "judge", fix: "build", verify: "verification", correction: "build" };
  const assignment: WorkAssignment = { id, revision: state.planRevision + 1, kind, dependencies: dependencies.map(({ id, revision }) => ({ id, revision })), seatId, expectedPaths: state.plan?.scope.paths ?? [], expectedOutputs: [schema[kind]], verificationCheckIds: [], mutation: kind === "fix" || kind === "build" ? "repository" : "read-only", isolation: { kind: "active-checkout" }, toolGrants: [], outputSchema: { name: schema[kind], version: 1 }, instructions, evidence: dependencies.flatMap(work => work.evidence), ...(context ? { context } : {}) };
  return initialWork(assignment);
}
function unavailableSeat(state: RunRecord, seatId: string): Decision {
  return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "missing-seat", []), requiredChoices: ["repair-seat", "stop"], evidence: [], triggers: [`missing-seat:${seatId}`] } });
}
function recordWave(state: RunRecord, work: WorkItem[]): Decision {
  for (const item of work) if (!state.seats.some(seat => seat.seatId === item.attempt.seatId)) return unavailableSeat(state, item.attempt.seatId);
  return work.length ? append(...work.map(item => ({ kind: "work-recorded" as const, work: item }))) : noDecision(state);
}
function reviewPacket(state: RunRecord, round: number) {
  const reviewers = state.work.filter(work => work.context?.kind === "review" && work.context.round === round);
  return { round, codeIdentity: state.code!.identity, findings: state.findings.filter(finding => !finding.resolution || finding.resolution.kind === "explicitly-deferred"), reviewerEvidence: reviewers.flatMap(work => work.evidence) };
}
function planningWave(state: RunRecord): Decision {
  const research = state.work.find(work => work.id === "research-shared" && work.status === "succeeded");
  if (!research?.result || research.result.kind !== "research") return reject("missing-research", "Shared cited research must finish before planning");
  const packet = { research: research.result, instructions: state.instructions.filter(instruction => instruction.status !== "applied"), policy: state.policy, intent: state.invocation.intent, declinedApprovals: state.approvals.filter(approval => approval.decision === "decline") };
  const sharedEvidenceHash = digestJson(packet), steering = state.instructions.filter(instruction => instruction.status !== "applied" && instruction.affectedWork.length), prefix = `plan-${state.planRevision + 1}-${steering.length ? digestJson(steering.map(instruction => instruction.id)).slice(0, 8) + "-" : ""}`;
  const topology = state.invocation.topology;
  const stages: { name: Extract<WorkContext, { kind: "planning" }>["stage"]; kind: WorkAssignment["kind"]; seat: string; dependencies: string[]; task: string }[] = [
    { name: "blind-a", kind: "plan", seat: "architect", dependencies: [], task: "Write a plan from the shared evidence. No other planner output is available." },
  ];
  if (topology === "crossreview") stages.push({ name: "critique-b", kind: "critique", seat: "critic", dependencies: ["blind-a"], task: "Critique the architect plan with evidence, impact and concrete fixes." }, { name: "revise-a", kind: "plan", seat: "architect", dependencies: ["blind-a", "critique-b"], task: "Revise the architect plan from the critique. Return the final plan." });
  if (topology === "duel" || topology === "debate") {
    stages.push({ name: "blind-b", kind: "plan", seat: "critic", dependencies: [], task: "Write an independent blind alternative plan from the same evidence. You are a planner for this seat." }, { name: "critique-a", kind: "critique", seat: "architect", dependencies: ["blind-b"], task: "Critique the critic seat's blind alternative plan." }, { name: "critique-b", kind: "critique", seat: "critic", dependencies: ["blind-a"], task: "Critique the architect seat's blind plan." });
    if (topology === "debate") stages.push({ name: "revise-a", kind: "plan", seat: "architect", dependencies: ["blind-a", "critique-b"], task: "Revise your own architect plan using its received critique." }, { name: "revise-b", kind: "plan", seat: "critic", dependencies: ["blind-b", "critique-a"], task: "Revise your own alternative plan using its received critique." });
    stages.push({ name: "synthesis", kind: "synthesis", seat: "architect", dependencies: stages.map(stage => stage.name), task: "Synthesize the final plan from every explicit prior output. Preserve required scope, safety, review lenses and verification." });
  }
  const missing: WorkItem[] = [];
  for (const stage of stages) {
    if (state.work.some(work => work.id === prefix + stage.name)) continue;
    const dependencies = stage.dependencies.map(name => state.work.find(work => work.id === prefix + name));
    if (dependencies.some(work => !work || work.status !== "succeeded")) continue;
    const inputs = dependencies.filter((work): work is WorkItem => !!work);
    const instructions = canonicalJson({ assignment: stage.task, requiredPlanRevision: state.planRevision + 1, sharedPacket: packet, sharedEvidenceHash, priorOutputs: inputs.map(work => ({ id: work.id, output: work.result })), contract: "Return only the versioned assigned output. Plans require a DAG, path reservations, risk-selected correctness/simplicity lenses, actual repository verification checks and commit groups. A single-worker fastPath or justified noChangeReason is permitted." });
    missing.push(seatWork(state, prefix + stage.name, stage.kind, stage.seat, instructions, [research, ...inputs], { kind: "planning", stage: stage.name, sharedEvidenceHash }));
  }
  if (missing.length) return recordWave(state, missing);
  const finalStage = stages.at(-1)!;
  const final = state.work.find(work => work.id === prefix + finalStage.name && work.status === "succeeded");
  if (final?.result?.kind !== "plan") return noDecision(state);
  const issues = validatePlan(final.result.plan, state);
  if (issues.length) return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "invalid-plan", []), evidence: final.evidence, triggers: issues.map(issue => issue.message) } });
  if (final.result.plan.revision !== state.planRevision + 1) return reject("stale-plan", "Final planning output targets the wrong revision");
  const classification = planClassification(state, final.result.plan);
  const finalPlan = final.result.plan;
  const affectedWork = state.work.filter(work => !terminalWork(work) && state.plan?.items.some(item => item.id === work.id) && !finalPlan.items.some(item => item.id === work.id && item.revision === work.revision));
  return append({ kind: "plan-recorded", plan: final.result.plan, classification, affectedWork: affectedWork.map(({ id, revision }) => ({ id, revision })) }, { kind: "instructions-applied", ids: state.instructions.filter(instruction => instruction.status !== "applied").map(instruction => instruction.id) }, phaseFact(state, "approval", "Planning graph completed"));
}
function adjudicateRound(state: RunRecord, round: ReviewRoundRecord, now: number): Decision {
  const judges = state.work.filter(work => work.context?.kind === "judge" && work.context.round === round.round);
  const required = state.invocation.topology === "normal" ? 1 : 2;
  if (judges.length !== required || judges.some(work => work.status !== "succeeded" || work.result?.kind !== "judge")) return noDecision(state);
  const outputs = judges.map(work => work.result as JudgeOutput);
  const facts: Fact[] = [];
  let disagreement = false;
  const findings = state.findings.map(finding => {
    const verdicts = outputs.map(output => ({ ...output.verdicts.find(verdict => verdict.findingId === finding.id)!, judgeId: output.judgeSeatId, round: round.round }));
    if (verdicts.some(verdict => !verdict.verdict)) return finding;
    const differs = verdicts.some(verdict => verdict.verdict !== verdicts[0].verdict || verdict.duplicateOf !== verdicts[0].duplicateOf);
    if (differs) disagreement = true;
    const updated = { ...finding, verdicts: [...finding.verdicts.filter(verdict => verdict.round !== round.round), ...verdicts.map(({ findingId, ...verdict }) => verdict)] };
    if (!differs && verdicts.every(verdict => verdict.verdict === "rejected" || verdict.verdict === "duplicate")) updated.resolution = { kind: finding.verdicts.some(verdict => verdict.verdict === "accepted") && !same(round.codeIdentity, state.reviewRounds.find(previous => previous.round === round.round - 1)?.codeIdentity ?? round.codeIdentity) ? "fixed" : verdicts[0].verdict === "duplicate" ? "duplicate" : "rejected", reason: verdicts.map(verdict => verdict.reason).join("; "), codeIdentity: round.codeIdentity, evidence: verdicts.flatMap(verdict => verdict.evidence) };
    if (!differs && verdicts.every(verdict => verdict.verdict === "deferred")) updated.resolution = { kind: "explicitly-deferred", reason: verdicts.map(verdict => verdict.reason).join("; "), codeIdentity: round.codeIdentity, evidence: verdicts.flatMap(verdict => verdict.evidence) };
    return updated;
  });
  for (const finding of findings) facts.push({ kind: "finding-recorded", finding });
  const unresolved = findings.filter(finding => !finding.resolution && finding.verdicts.some(verdict => verdict.round === round.round && verdict.verdict === "accepted")).map(finding => finding.fingerprint).sort();
  const complete = { ...round, completedAt: now, unresolvedFingerprints: unresolved, verdictEvidence: judges.flatMap(work => work.evidence) };
  facts.push({ kind: "review-round-recorded", round: complete });
  const previous = state.reviewRounds.find(previous => previous.round === round.round - 1);
  const triggers: string[] = [];
  if (disagreement) triggers.push("judge-disagreement");
  if (unresolved.length && previous?.completedAt && same(previous.unresolvedFingerprints, unresolved) && previous.relevantCodeDigest === round.relevantCodeDigest) triggers.push("no-progress");
  if (unresolved.length && state.limits.reviewRounds !== undefined && round.round >= state.limits.reviewRounds) triggers.push("review-round-cap");
  if (triggers.length) facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "paused", phase: state.phase, recovery: { ...recovery(state, triggers.includes("no-progress") ? "no-progress" : triggers[0], []), triggers, requiredChoices: disagreement ? ["resolve-judges", "stop"] : triggers.includes("no-progress") ? ["change-reviewers", "override-with-rationale", "stop"] : ["continue", "stop"] } });
  return append(...facts);
}
function advanceWorkflow(state: RunRecord, context: DecisionContext): Decision {
  const settledCancellation = state.actions.find(action => action.input.kind === "cancel_runtime" && ["claimed", "running"].includes(action.status) && action.input.owners.every(owner => [...state.work.flatMap(work => work.runtimeOwners), ...state.pools.flatMap(pool => pool.owner ? [pool.owner] : [])].some(observed => runtimeIdentity(owner) === runtimeIdentity(observed) && observed.status === "observed-terminal")));
  if (settledCancellation) return append({ kind: "action-settled", actionId: settledCancellation.id, result: { kind: "success", evidence: settledCancellation.input.kind === "cancel_runtime" ? settledCancellation.input.owners.flatMap(owner => owner.observation?.availability === "available" ? [owner.observation] : []) : [] } });
  if (state.lifecycle === "cancelling" && cancellationReady(state)) return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "cancelled", phase: state.phase });
  if (state.lifecycle !== "active") return noDecision(state);
  // An uncertain parent callback (effects outside its declared paths, or a lost return) needs a trusted disposition through the
  // recovery tool-result path before any phase boundary: attribution decided later cannot be committed or verified retroactively.
  const uncertain = state.toolInvocations.filter(invocation => invocation.outcome === "uncertain");
  if (uncertain.length && !state.recovery) {
    const callers = state.work.filter(work => uncertain.some(invocation => invocation.caller.id === work.id && invocation.caller.revision === work.revision));
    return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "active", phase: state.phase, recovery: { ...recovery(state, "uncertain-parent-effect", callers), scope: "items", triggers: uncertain.map(invocation => "uncertain-parent-effect:" + invocation.id), requiredChoices: ["inspect", "continue", "stop"], evidence: uncertain.flatMap(invocation => invocation.evidence) } });
  }
  if (uncertain.length || state.work.some(work => work.status === "running" || work.status === "awaiting-recovery") || liveOwners(state).length || state.actions.some(action => ["issued", "claimed", "running", "uncertain"].includes(action.status))) return noDecision(state);
  const gate = pendingPolicyGate(state);
  if (gate?.requirement.kind === "consultation") {
    const scopeHash = policyGateScope(state, gate), id = "consult-" + gate.id + "-" + scopeHash.slice(0, 12);
    if (!state.work.some(work => work.id === id && !["superseded", "cancelled"].includes(work.status))) return recordWave(state, [seatWork(state, id, "research", gate.requirement.seatId, canonicalJson({ task: "Provide the required domain consultation before downstream work. Cite observed evidence; do not modify repository files.", requirement: gate.requirement.before, gate, plan: state.plan ?? null, findings: state.findings, code: state.code ?? null }), [], { kind: "consultation", gateId: gate.id, phase: state.phase, scopeHash })]);
    return noDecision(state);
  }
  if (gate) return noDecision(state);
  const steering = state.instructions.some(instruction => instruction.status !== "applied" && instruction.affectedWork.length);
  if (steering && state.invocation.mode === "review-only") {
    const facts: Fact[] = [{ kind: "instructions-applied", ids: state.instructions.filter(instruction => instruction.status !== "applied").map(instruction => instruction.id) }];
    if (state.phase !== "review") facts.push(phaseFact(state, "review", "Apply review-only steering to the current inspected scope"));
    return append(...facts);
  }
  if (steering && state.phase !== "plan" && state.phase !== "research") return append(phaseFact(state, "plan", "Apply recorded steering at a safe boundary"));
  if (state.code && ["verify", "commit", "publish", "conclude"].includes(state.phase) && state.reviewRounds.at(-1)?.completedAt && !sameRelevantCode(state.reviewRounds.at(-1)!.codeIdentity, state.code.identity)) return append(phaseFact(state, "review", "Current code differs from the reviewed identity"));
  if (state.phase === "preflight") return append(phaseFact(state, state.invocation.mode === "review-only" ? "review" : state.invocation.mode === "interactive" && !state.clarificationCompleted ? "clarify" : "research", "Preflight completed"));
  if (state.phase === "clarify") return state.clarificationCompleted ? append(phaseFact(state, "research", "Trusted interview completed")) : noDecision(state);
  if (state.phase === "research") {
    const shared = state.work.find(work => work.id === "research-shared");
    if (!shared) return recordWave(state, [seatWork(state, "research-shared", "research", "scout", canonicalJson({ task: "Collect one scoped cited research packet for all planners. Read repository instructions and actual relevant scripts. Identify gaps without guessing. Do not modify code.", intent: state.invocation.intent, policy: state.policy, instructions: state.instructions }), [], { kind: "planning", stage: "shared-research", sharedEvidenceHash: digestJson({ intent: state.invocation.intent, policy: state.policy }) })]);
    return shared.status === "succeeded" ? append(phaseFact(state, "plan", "Shared research completed")) : noDecision(state);
  }
  if (state.phase === "plan") return planningWave(state);
  if (state.phase === "approval") {
    if (!state.plan) return reject("missing-plan", "Approval phase requires a validated plan");
    const decline = [...state.approvals].reverse().find(approval => approval.decision === "decline" && approval.scopeHash === digestJson(state.plan));
    if (decline) return append(phaseFact(state, "plan", "Plan was declined; preserve its rationale for a new proposal"));
    if (state.plan.fastPath && state.approvals.some(approval => approval.kind === "fast-path" && approval.decision === "decline" && approval.scopeHash === digestJson(state.plan!.fastPath))) {
      const { fastPath, ...normal } = state.plan;
      return append({ kind: "plan-recorded", plan: { ...normal, revision: state.planRevision + 1 }, classification: "ordinary", affectedWork: [] });
    }
    if (!planApproved(state)) {
      if (state.invocation.mode !== "autonomous" || state.planChange?.classification === "safety") return noDecision(state);
      const approval: ApprovalRecord = { id: `plan-auto-${state.planRevision}`, kind: state.approvals.some(approval => approval.kind === "initial-plan") ? "material-amendment" : "initial-plan", decision: "approve", authority: "autonomous-policy", scopeHash: digestJson(state.plan), planRevision: state.planRevision, toolVersions: [], ownerEpoch: state.owner.epoch, createdAt: context.now, rationale: "Autonomous ordinary plan approval. OMP safety permissions remain in force.", evidence: state.plan.evidence };
      return append({ kind: "approval-recorded", approval });
    }
    if (state.plan.fastPath && !state.approvals.some(approval => approval.kind === "fast-path" && approval.decision === "approve" && approval.scopeHash === digestJson(state.plan!.fastPath))) {
      if (state.invocation.mode !== "autonomous") return noDecision(state);
      return append({ kind: "approval-recorded", approval: { id: `fast-auto-${state.planRevision}`, kind: "fast-path", decision: "approve", authority: "autonomous-policy", scopeHash: digestJson(state.plan.fastPath), planRevision: state.planRevision, toolVersions: [], ownerEpoch: state.owner.epoch, createdAt: context.now, rationale: state.plan.fastPath.reason, evidence: state.plan.evidence } });
    }
    const missingTools = state.plan.toolProposals.filter(proposal => !state.tools.some(tool => tool.name === proposal.name && tool.sourceHash === proposal.sourceHash));
    if (missingTools.length) return append(...missingTools.map(proposal => ({ kind: "tool-recorded" as const, definition: toolDefinition(state, proposal, proposalGrants(state, proposal)) })));
    const items = state.plan.items.filter(item => !state.work.some(work => work.id === item.id && work.revision === item.revision)).map(initialWork);
    for (const work of items) for (const tool of state.tools) if (["approved", "registered"].includes(tool.registration) && tool.approvalId && tool.grants.some(grant => grant.workId === work.id && grant.workRevision === work.revision && grant.seatId === work.seatId)) work.toolGrants = [...work.toolGrants.filter(grant => grant.name !== tool.name), { name: tool.name, version: tool.version, approvalId: tool.approvalId }];
    return append(...items.map(work => ({ kind: "work-recorded" as const, work })), phaseFact(state, state.plan.items.some(item => item.mutation !== "read-only") ? "build" : "review", "Approved plan is ready"));
  }
  if (!state.code) return noDecision(state);
  if (state.phase === "build") {
    if (!planApproved(state)) return append(phaseFact(state, "approval", "Material amendment requires current plan approval"));
    const missing = state.plan!.items.filter(item => !state.work.some(work => work.id === item.id && work.revision === item.revision));
    if (missing.length) return append(...missing.map(item => ({ kind: "work-recorded" as const, work: initialWork(item) })));
    const pending = state.work.filter(work => ["build", "fix"].includes(work.kind) && !terminalWork(work));
    if (pending.length) return noDecision(state);
    const unintegrated = state.work.some(work => work.status === "succeeded" && work.mutation !== "read-only" && work.isolation.kind === "worktree" && !state.gitOutcomes.some(outcome => outcome.operation === "integrate" && outcome.work && workMatches(work, outcome.work)));
    if (unintegrated || state.work.some(work => work.completedAt && work.mutation !== "read-only" && work.completedAt > state.code!.observedAt)) return noDecision(state);
    return append(phaseFact(state, "review", "Build effects were observed and integrated"));
  }
  if (state.phase === "review") {
    const refinement = [...state.work].reverse().find(work => work.context?.kind === "planning" && work.context.stage === "review-refinement" && work.context.sharedEvidenceHash === digestJson(state.plan ?? null) && !["cancelled", "superseded"].includes(work.status));
    if (refinement) {
      if (refinement.status !== "succeeded" || refinement.result?.kind !== "plan") return noDecision(state);
      const proposed = refinement.result.plan;
      if (!state.plan || !same(proposed.scope, state.plan.scope) || proposed.items.length || proposed.toolProposals.length || proposed.revision !== state.planRevision + 1 || validatePlan(proposed, state).length || generatedChange(state) && !proposed.verificationChecks.some(check => check.required)) return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "invalid-review-refinement", [refinement]), requiredChoices: ["replan", "stop"], evidence: refinement.evidence } });
      return append({ kind: "plan-recorded", plan: proposed, classification: "ordinary", affectedWork: [] });
    }
    if (!state.plan) {
      const paths = state.code.paths.map(path => path.path);
      const reviewPlan: PlanRecord = { schemaVersion: 1, revision: state.planRevision + 1, title: "Review selected local scope", objective: state.invocation.intent || "Review local changes", scope: { included: ["Invocation-selected review scope"], excluded: [], paths, effects: ["repair within selected review scope"], publicContracts: [], dependencies: [] }, evidence: state.code.evidence, items: [], risks: [], requiredLenses: requiredLenses(state), verificationChecks: state.policy.verificationChecks, commitGroups: [], toolProposals: [], noChangeReason: paths.length ? "Review-only scope may need no repair" : "No meaningful changed scope exists" };
      return append({ kind: "plan-recorded", plan: reviewPlan, classification: "ordinary", affectedWork: [] });
    }
    const round = state.reviewRounds.at(-1);
    if (!round || round.completedAt && (!sameRelevantCode(round.codeIdentity, state.code.identity) || unresolvedFindings(state).length && state.work.some(work => work.context?.kind === "fix" && work.context.round === round.round) && state.work.filter(work => work.context?.kind === "fix" && work.context.round === round.round).every(terminalWork))) {
      const number = (round?.round ?? 0) + 1, lenses = requiredLenses(state), reviewSeatIds = round?.override?.seatIds.length ? round.override.seatIds : round?.reviewSeatIds ?? lenses;
      const priorEvidencePacket = state.code.evidence[0] ?? state.repository.baselineRef;
      const next: ReviewRoundRecord = { reviewSeatIds, round: number, startedAt: context.now, codeIdentity: state.code.identity, lenses, reviewerOwners: [], judgeOwners: [], priorEvidencePacket, unresolvedFingerprints: [], relevantCodeDigest: digestJson({ scope: state.code.identity.scopeDigest, parent: state.code.identity.parentEffectDigest }), verdictEvidence: [] };
      const focusPaths = [...new Set(state.plan.scope.paths)];
      const groups = lenses.map((lens, index) => {
        const packet = { task: "Review the current integrated code with this lens. Report evidence, impact and a fix target for every finding. Prior findings are explicit input. Do not supply verdicts or resolutions. Inspect focused paths with full-scope cross-file context.", lens, round: number, code: state.code!.identity, priorFindings: state.findings, priorEvidencePacket, scope: state.plan!.scope };
        const focuses = focusPaths.length > 1 ? focusPaths.map(path => [path]) : [focusPaths];
        const work = focuses.map(focus => {
          const id = "review-" + number + "-" + lens + (focuses.length > 1 ? "-" + digestJson(focus).slice(0, 12) : "");
          const item = seatWork(state, id, "review", reviewSeatIds[index], canonicalJson({ ...packet, focusPaths: focus }), [], { kind: "review", round: number, lens, codeIdentity: state.code!.identity });
          item.expectedPaths = focus;
          return item;
        });
        const pool: PoolRecord = { schemaVersion: 1, id: "pool-" + number + "-" + lens, lens, round: number, seatId: reviewSeatIds[index], contextRef: priorEvidencePacket, contextHash: digestJson(packet), toolGrants: [], status: "pending", items: work.map(item => ({ logicalId: item.id, work: { id: item.id, revision: item.revision, attemptId: item.attempt.id } })) };
        return { work, pool };
      });
      for (const group of groups) if (!state.seats.some(seat => seat.seatId === group.pool.seatId)) return unavailableSeat(state, group.pool.seatId);
      return append({ kind: "review-round-recorded", round: next }, ...groups.flatMap(group => [...group.work.map(work => ({ kind: "work-recorded" as const, work })), { kind: "pool-recorded" as const, pool: group.pool }]));
    }
    if (!round.completedAt) {
      const reviewers = state.work.filter(work => work.context?.kind === "review" && work.context.round === round.round);
      if (reviewers.some(work => work.status !== "succeeded")) return noDecision(state);
      const packet = reviewPacket(state, round.round), packetHash = digestJson(packet);
      const judgeSeats = state.invocation.topology === "normal" ? ["judge"] : ["judge", "judge-secondary"];
      const missing = judgeSeats.filter(seat => !state.work.some(work => work.context?.kind === "judge" && work.context.round === round.round && work.seatId === seat)).map(seat => seatWork(state, `judge-${round.round}-${seat}`, "judge", seat, canonicalJson({ task: "Independently adjudicate every assigned finding once. Accepted findings require repair. Reject only with evidence. Defer only with explicit rationale. No confidence cutoff or hidden tie breaker. Prior accepted findings that no longer reproduce after a code change must be rejected with resolution evidence.", packet, packetHash, judgeSeatId: seat }), reviewers, { kind: "judge", round: round.round, packetHash, findingIds: packet.findings.map(finding => finding.id), codeIdentity: state.code!.identity }));
      if (missing.length) return recordWave(state, missing);
      return adjudicateRound(state, round, context.now);
    }
    const unresolved = unresolvedFindings(state);
    if (!unresolved.length) return append(phaseFact(state, "verify", "Judges resolved all accepted findings"));
    const fixes = unresolved.map(finding => seatWork(state, `fix-${round.round}-${finding.id}`, "fix", "builder", canonicalJson({ task: "Repair this accepted finding within the approved scope. Preserve pre-existing user edits. Report observed changes and evidence; do not claim runtime verification from assertions.", finding, scope: state.plan!.scope, code: state.code!.identity }), [], { kind: "fix", round: round.round, findingIds: [finding.id], codeIdentity: state.code!.identity }));
    for (const item of fixes) { item.expectedPaths = [unresolved.find(finding => item.context?.kind === "fix" && item.context.findingIds.includes(finding.id))!.fixTarget.path]; item.verificationCheckIds = state.plan.verificationChecks.filter(check => check.scopePaths.some(path => item.expectedPaths.some(target => pathsOverlap(path, target)))).map(check => check.id); }
    const outOfScope = fixes.some(item => item.expectedPaths.some(path => !state.plan!.scope.paths.some(scope => pathsOverlap(scope, path))));
    if (outOfScope) return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "paused", phase: state.phase, recovery: { ...recovery(state, "material-amendment", []), requiredChoices: ["replan", "stop"] } });
    for (const item of fixes) if (!state.seats.some(seat => seat.seatId === item.seatId)) return unavailableSeat(state, item.seatId);
    return append(...fixes.filter(item => !state.work.some(work => work.id === item.id)).map(work => ({ kind: "work-recorded" as const, work })), phaseFact(state, "build", "Repair accepted findings"));
  }
  if (state.phase === "verify") {
    const checks = state.plan!.verificationChecks.filter(check => check.required);
    if (generatedChange(state) && !checks.length) return append({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "missing-verification", []), requiredChoices: ["replan", "stop"] } });
    if (!verificationReady(state)) return noDecision(state);
    return append(phaseFact(state, state.invocation.commitRequested && generatedChange(state) ? "commit" : state.invocation.pushRequested && generatedChange(state) ? "publish" : "conclude", "Current runtime verification completed"));
  }
  if (state.phase === "commit") {
    if (!commitGroups(state).every(group => state.gitOutcomes.some(outcome => outcome.operation === "commit" && (outcome.groupIds?.includes(group.id) || outcome.groupId === group.id)))) return noDecision(state);
    return append(phaseFact(state, state.invocation.pushRequested ? "publish" : "conclude", "Requested attributable commits completed"));
  }
  if (state.phase === "publish") return state.gitOutcomes.some(outcome => outcome.operation === "push") || state.approvals.some(approval => approval.kind === "push" && approval.decision === "decline") ? append(phaseFact(state, "conclude", "Publication was confirmed or explicitly declined")) : noDecision(state);
  return noDecision(state);
}
// Attribution follows the work's disposition and its observed effects, never a worker's assertion: a succeeded worktree builder owns
// its captured non-empty patch; a succeeded active-checkout builder owns bytes only through a successful workspace bridge return that
// changed the parent; a read-only caller owns only a successful parent callback that changed the parent. A no-op report, discarded,
// failed or cancelled work, a callback the trusted user marked failed, and external drift never deliver change.
function attributedOwners(state: RunRecord): WorkItem[] {
  return state.work.filter(work => {
    if (work.status !== "succeeded" || work.result?.kind === "build" && work.result.outcome !== "changed") return false;
    if (work.mutation !== "read-only" && work.isolation.kind === "worktree") return state.patches.some(patch => workMatches(work, patch.work) && patch.changedPaths.length > 0);
    return state.toolInvocations.some(invocation => invocation.caller.id === work.id && invocation.caller.revision === work.revision && (work.mutation === "read-only" || invocation.name === "supership_workspace") && invocation.outcome === "success" && !!invocation.parentAfter && !same(invocation.parentAfter, invocation.parentBefore));
  });
}
function generatedChange(state: RunRecord): boolean {
  if (!state.code || !state.baselineCode) return false;
  const differs = state.code.identity.parentEffectDigest !== state.baselineCode.parentEffectDigest || state.code.identity.worktreeDigest !== state.baselineCode.worktreeDigest;
  return differs && attributedOwners(state).length > 0;
}
// Every no-change conclusion names why the checkout may still differ, so the drafted conclusion is always the accepted one.
function noChangeReason(state: RunRecord): string | undefined {
  if (state.plan?.noChangeReason) return state.plan.noChangeReason;
  const discarded = state.work.filter(work => work.status === "cancelled" && work.mutation !== "read-only");
  if (discarded.length) return "Trusted recovery discarded the mutation work " + discarded.map(work => work.id).join(", ") + "; its retained bytes are not attributable output.";
  if (state.code && state.baselineCode && !same(state.code.identity, state.baselineCode)) return "Observed bytes differ from the run baseline without a succeeded owner; they are not attributable output.";
  return undefined;
}
/** A plan without commit groups (the review-only scope plan) still owes requested commits for its attributed output, as one group. */
export function commitGroups(state: RunRecord): CommitGroup[] {
  if (!state.plan || state.plan.commitGroups.length || !generatedChange(state)) return state.plan?.commitGroups ?? [];
  const owners = attributedOwners(state);
  return [{ id: "attributed-output", title: "Attributed output", workIds: owners.map(work => work.id), paths: [...new Set(owners.flatMap(work => reservedPaths(state, work)))], dependencies: [] }];
}
/** An ownership patch is attributed only through a known, succeeded owner; a foreign or disowned source stays unattributed checkout bytes. */
export function attributedPatch(state: RunRecord, workId: string): boolean {
  return attributedOwners(state).some(work => work.id === workId);
}
function proposalGrants(state: RunRecord, proposal: CapturedToolProposal, plan = state.plan): ToolDefinitionRecord["grants"] {
  const candidates = new Map<string, WorkAssignment>([...(plan?.items ?? []), ...state.work.filter(work => work.status === "pending")].map(work => [work.id + "@" + work.revision, work]));
  return [...candidates.values()].filter(work => proposal.intendedUsers.includes(work.id) || proposal.intendedUsers.includes(work.seatId)).map(work => ({ workId: work.id, workRevision: work.revision, seatId: work.seatId }));
}
function toolDefinition(state: RunRecord, proposal: CapturedToolProposal, grants: ToolDefinitionRecord["grants"]): ToolDefinitionRecord {
  const version = Math.max(0, ...state.tools.filter(tool => tool.name === proposal.name).map(tool => tool.version)) + 1;
  const approvalScopeHash = toolApprovalScope(proposal, grants);
  return { ...proposal, version, grants, approvalScopeHash, parent: { cwd: state.repository.root, sessionId: state.owner.sessionId, ownerEpoch: state.owner.epoch }, kernelGeneration: state.kernelGeneration, registration: "proposed", evidence: [proposal.sourceRef] };
}


function runtimeIdentity(owner: RuntimeOwner): string { return digestJson({ kind: owner.kind, id: owner.id, actionId: owner.actionId, workId: owner.workId, workRevision: owner.workRevision, attemptId: owner.attemptId, sessionId: owner.sessionId, ownerEpoch: owner.ownerEpoch, parentId: owner.parentId ?? null, logicalKey: owner.logicalKey ?? null }); }
export function findingFingerprint(finding: Pick<FindingRecord, "location" | "condition" | "claim">): string {
  const normalized = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  return digestJson({ path: finding.location.path, symbol: finding.location.symbol ?? "", line: finding.location.startLine ?? 0, condition: normalized(finding.condition), claim: normalized(finding.claim) });
}
function outputProblem(state: RunRecord, work: WorkItem, output: WorkerOutput): string | undefined {
  if (output.workId !== work.id || output.workRevision !== work.revision || output.attemptId !== work.attempt.id || output.kind !== work.outputSchema.name) return "Output identity or kind differs from its assignment";
  if (work.context?.kind === "planning" && work.context.stage === "review-refinement" && output.kind === "plan" && (!state.plan || !same(output.plan.scope, state.plan.scope) || output.plan.items.length || output.plan.toolProposals.length || output.proposedTools?.length || output.plan.revision !== state.planRevision + 1 || validatePlan(output.plan, state).length || generatedChange(state) && !output.plan.verificationChecks.some(check => check.required))) return "Review refinement must retain exact review scope, add no feature work or tools, and provide required executable verification";
  if (output.kind === "research" && output.answers.some(answer => !answer.citations.length || answer.citations.some(ref => ref.availability !== "available"))) return "Research answers require available citations";
  if (output.kind === "plan" && (output.plan.revision !== state.planRevision + 1 || validatePlan(output.plan, state).length)) return "Plan revision, scope or dependency contract is invalid";
  if (output.kind === "review") {
    const context = work.context;
    if (context?.kind !== "review" || context.round !== output.round || context.lens !== output.lens || !same(context.codeIdentity, output.reviewedCodeIdentity)) return "Review lens, round or code identity differs from its assignment";
    if (new Set(output.findings.map(finding => finding.id)).size !== output.findings.length || output.findings.some(finding => finding.verdicts.length || finding.resolution || finding.resolutionHistory?.length || !finding.evidence.length || !finding.claim.trim() || !finding.impact.trim() || !finding.fixTarget.description.trim())) return "Findings require evidence, impact and a fix target without self-adjudication";
  }
  if (output.kind === "judge") {
    const context = work.context;
    if (context?.kind !== "judge" || output.round !== context.round || output.judgeSeatId !== work.attempt.seatId || output.reviewPacketHash !== context.packetHash) return "Judge identity or review packet differs from its assignment";
    if (output.verdicts.length !== context.findingIds.length || new Set(output.verdicts.map(verdict => verdict.findingId)).size !== output.verdicts.length || !context.findingIds.every(id => output.verdicts.some(verdict => verdict.findingId === id)) || output.verdicts.some(verdict => !verdict.reason.trim() || !verdict.evidence.length || verdict.verdict === "duplicate" && (!verdict.duplicateOf || verdict.duplicateOf === verdict.findingId || !context.findingIds.includes(verdict.duplicateOf)))) return "Judge must adjudicate each assigned finding exactly once with evidence and a reason";
  }
  return undefined;
}
function invalidOutputDecision(state: RunRecord, work: WorkItem, action: ActionRecord, outputRef: EvidenceRef, observation: ReceiptObservation, context: DecisionContext): Decision {
  const settled = observation.settledOwners ?? [];
  const confirmed = observation.kind === "runtime-confirmed" && work.runtimeOwners.length > 0 && work.runtimeOwners.every(owner => settled.some(terminal => runtimeIdentity(terminal) === runtimeIdentity(owner) && terminal.status === "observed-terminal"));
  if (!confirmed) {
    return append({ kind: "work-recorded", work: { ...work, status: "awaiting-recovery", evidence: [...work.evidence, outputRef] } }, { kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "invalid-output", [work]), evidence: [outputRef] } });
  }
  const priorCorrection = work.context?.kind === "correction" ? work.context : undefined;
  const original = priorCorrection ? state.work.find(candidate => workMatches(candidate, priorCorrection.original))! : work;
  const originalRef = { id: original.id, revision: original.revision, attemptId: original.attempt.id };
  const fallback = priorCorrection ? state.seats.find(seat => seat.seatId === original.attempt.seatId)?.fallbackSeatIds[0] : undefined;
  const facts: Fact[] = [{ kind: "work-recorded", work: { ...work, status: priorCorrection ? "failed" : "awaiting-output", completedAt: context.now, runtimeOwners: work.runtimeOwners.map(owner => settled.find(terminal => runtimeIdentity(terminal) === runtimeIdentity(owner))!), evidence: [...work.evidence, outputRef] } }];
  if (priorCorrection) facts.push({ kind: "action-settled", actionId: action.id, result: { kind: "failure", diagnostic: { code: "invalid-output", message: "The report correction did not satisfy its schema", severity: "error", evidence: [outputRef] }, evidence: [outputRef] } });
  if (priorCorrection?.stage === "fallback" || priorCorrection && (!fallback || !state.seats.some(seat => seat.seatId === fallback))) {
    facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, priorCorrection?.stage === "fallback" ? "output-attempts-exhausted" : "missing-named-fallback", [original]), evidence: [outputRef], requiredChoices: ["adopt", "discard", "stop"] } });
    return append(...facts);
  }
  const stage = priorCorrection ? "fallback" : "correction", seat = fallback ?? original.attempt.seatId;
  const report = seatWork(state, original.id + "-report-" + stage, "correction", seat, canonicalJson({ task: "Correct only the structured report from retained evidence. Do not repeat any repository, tool, network, process, commit or publication mutation. The original effects already occurred. Return the assigned schema with this report task identity.", original: originalRef, originalAssignment: workAssignment(original), originalOutput: outputRef, evidence: original.evidence }), [], { kind: "correction", original: originalRef, stage, outputRef });
  report.outputSchema = original.outputSchema;
  facts.push({ kind: "work-recorded", work: report });
  return append(...facts);
}

export function decide(state: RunRecord | undefined, input: EngineInput, context: DecisionContext): Decision {
  try { assertSchema(EngineInputSchema, input, "engine input"); assertSchema(DecisionContextSchema, context, "decision context"); if (state) assertSchema(RunRecordSchema, state, "run"); }
  catch (error) { return reject("invalid-schema", String(error)); }
  const inputDigest = digestJson(input);
  const priorInput = state?.inputReceipts.find(receipt => receipt.id === context.inputId);
  if (priorInput) return priorInput.digest === inputDigest ? { kind: "duplicate", eventSequence: priorInput.sequence } : reject("input-id-conflict", "Input ID already committed with different content");
  if (!state) {
    if (input.kind !== "start") return reject("missing-run", "Create a new run before this transition");
    const start = input.start;
    if (start.owner.sessionId !== context.ownerSessionId || start.owner.epoch !== context.ownerEpoch || start.owner.epoch !== 0) return reject("owner-mismatch", "Start owner does not match epoch zero context");
    if (!start.preflight.checks.every(check => check.passed) || !same(start.repository, start.preflight.repository) || !same(start.seats, start.preflight.seats)) return reject("preflight-failed", "All preflight observations must pass and match the start record");
    if (!/^18\.(?:1\.(?:1[0-9]|[2-9][0-9]|[1-9][0-9]{2,})|2\.\d+)$/.test(start.preflight.observedVersion)) return reject("unsupported-version", "OMP must be >=18.1.10 <18.3.0");
    const expectedMode = start.invocation.command === "superreview" ? "review-only" : ["shipit", "ultrashipit"].includes(start.invocation.command) ? "autonomous" : "interactive";
    if (start.invocation.mode !== expectedMode || (["ultraship", "ultrashipit", "superreview"].includes(start.invocation.command) && start.invocation.topology === "normal")) return reject("invalid-invocation", "Command mode/topology does not match its public meaning");
    if (new Set(start.seats.map(seat => seat.seatId)).size !== start.seats.length) return reject("duplicate-seat", "Seat IDs must be unique");
    return append({ kind: "run-created", start });
  }
  if (context.now < state.updatedAt) return reject("clock-regression", "Decision time precedes the last committed event");
  if (input.kind !== "resume" && (context.ownerEpoch !== state.owner.epoch || context.ownerSessionId !== state.owner.sessionId)) return reject("stale-owner", "A previous owner cannot mutate this run");
  if (input.kind === "observe-receipt") {
    const prior = state.receiptDigests.find(receipt => receipt.id === input.receipt.receiptId);
    if (prior) return prior.digest === digestJson(input.receipt) ? { kind: "duplicate", eventSequence: prior.sequence } : reject("receipt-id-conflict", "Receipt ID has different content");
  }
  if (["completed", "cancelled"].includes(state.lifecycle) && input.kind !== "record-storage-recovery") return reject("terminal-run", "A terminal run cannot accept new transitions");
  switch (input.kind) {
    case "repair-seat-bindings": {
      const error = approvalError(state, input.approval);
      const stable = ({ alias, bindingGeneration, ...seat }: RunRecord["seats"][number]) => seat;
      if (error || input.approval.authority !== "omp-tui" || input.approval.kind !== "recovery" || input.approval.decision !== "approve" || input.approval.scopeHash !== digestJson({ seats: input.seats }) || !input.evidence.length || input.evidence.some(ref => ref.availability !== "available") || new Set(input.seats.map(seat => seat.seatId)).size !== input.seats.length || state.seats.some(previous => !input.seats.some(seat => seat.seatId === previous.seatId && same(stable(previous), stable(seat))))) return reject("invalid-seat-repair", error ?? "Seat repair requires exact trusted approval and must retain existing logical bindings");
      return append({ kind: "approval-recorded", approval: input.approval }, { kind: "seat-bindings-recorded", seats: input.seats, evidence: input.evidence }, ...(state.recovery?.primaryReason === "missing-seat" ? [{ kind: "lifecycle-changed" as const, from: state.lifecycle, to: "active" as const, phase: state.recovery.resumePhase }] : []));
    }
    case "record-seat-bindings": {
      if (input.seats.length !== state.seats.length || input.seats.some(binding => { const previous = state.seats.find(seat => seat.seatId === binding.seatId); if (!previous) return true; const stable = ({ alias, bindingGeneration, ...seat }: typeof binding) => seat; return !same(stable(previous), stable(binding)); })) return reject("changed-seat-source", "Resume cannot silently change logical seats, model policy or source provenance");
      return append({ kind: "seat-bindings-recorded", seats: input.seats, evidence: input.evidence });
    }
    case "record-patch": {
      const work = state.work.find(work => workMatches(work, input.patch.work)), action = state.actions.find(action => action.id === input.patch.actionId);
      if (!work || !action || !["succeeded", "superseded", "cancelled", "awaiting-recovery", "running"].includes(work.status) || work.mutation === "read-only" || input.observation.kind !== "runtime-confirmed" || input.patch.patchRef.availability !== "available" || !input.patch.ownershipEvidence.length || input.patch.ownershipEvidence.some(ref => ref.availability !== "available")) return reject("unobserved-patch", "Patch integration needs current captured runtime ownership evidence");
      if (work.status === "running" && (!work.runtimeOwners.length || work.runtimeOwners.some(owner => owner.status !== "observed-terminal" && !input.observation.settledOwners?.some(confirmed => runtimeIdentity(confirmed) === runtimeIdentity(owner) && confirmed.status === "observed-terminal")))) return reject("unsettled-patch", "Partial effects can be captured only after actual owner settlement");
      const expands = input.patch.changedPaths.some(path => !reservedPaths(state, work).some(expected => pathsOverlap(expected, path)));
      return append({ kind: "patch-recorded", patch: input.patch }, ...(expands ? [{ kind: "lifecycle-changed" as const, from: state.lifecycle, to: "paused" as const, phase: state.phase, recovery: { ...recovery(state, "overlap-or-scope-expansion", [work]), requiredChoices: ["replan", "adopt", "discard", "stop"], evidence: input.patch.ownershipEvidence } }] : []));
    }
    case "advance": return advanceWorkflow(state, context);
    case "resolve-input": {
      const action = state.actions.find(action => action.id === input.actionId);
      if (!action || action.input.kind !== "collect_input" || action.input.request.kind !== "clarification" || action.status !== "claimed") return reject("invalid-input-action", "Only a claimed clarification action accepts a trusted interview answer");
      const facts: Fact[] = [{ kind: "clarification-completed", evidence: input.evidence }, { kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: input.evidence } }];
      if (input.limits) facts.push({ kind: "limits-configured", limits: input.limits });
      if (input.evidence[0]) facts.push({ kind: "instruction-recorded", instruction: { id: "clarification-" + action.id, receivedAt: context.now, textRef: input.evidence[0], summary: input.answer, affectedWork: [], classification: "ordinary", status: "applied", evidence: input.evidence } });
      return append(...facts);
    }
    case "configure-limits": return append({ kind: "limits-configured", limits: input.limits });
    case "record-storage-recovery": return append({ kind: "storage-recovered", preserved: input.preserved, reason: input.reason }, ...(["completed", "cancelled"].includes(state.lifecycle) ? [] : [{ kind: "lifecycle-changed" as const, from: state.lifecycle, to: "blocked" as const, phase: state.phase, recovery: recovery(state, "storage-recovery") }]));
    case "record-worktree": {
      const action = state.actions.find(action => action.id === input.worktree.actionId), work = state.work.find(work => workMatches(work, input.worktree.work));
      if (!action || !work || input.worktree.runId !== state.runId || input.observation.kind !== "runtime-confirmed" || !input.worktree.evidence.length || input.worktree.evidence.some(ref => ref.availability !== "available") || !action.recipients.some(recipient => recipient.workId === work.id && recipient.attemptId === work.attempt.id)) return reject("unattested-worktree", "Worktree ownership requires the actual runtime creation receipt");
      return append({ kind: "worktree-recorded", worktree: input.worktree });
    }
    case "record-push-target": {
      const action = state.actions.find(action => action.id === input.actionId);
      if (!action || action.input.kind !== "prepare_push" || action.status !== "claimed" || !same(action.input.commits, input.target.commits) || !same(action.input.expectedCode, input.target.codeIdentity)) return reject("invalid-push-target", "Push target must match a claimed preparation on current commits and code");
      return append({ kind: "push-target-recorded", target: input.target }, { kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: [] } });
    }
    case "resolve-judges": {
      if (!state.recovery?.triggers.includes("judge-disagreement") || input.approval.authority !== "omp-tui" || input.approval.kind !== "judge-disagreement" || input.approval.decision !== "approve" || input.approval.scopeHash !== digestJson({ round: input.round, decisions: input.decisions })) return reject("invalid-judge-resolution", "Disagreement requires an exact trusted verdict decision");
      const packet = reviewPacket(state, input.round);
      if (input.decisions.length !== packet.findings.length || new Set(input.decisions.map(verdict => verdict.findingId)).size !== input.decisions.length || !packet.findings.every(finding => input.decisions.some(verdict => verdict.findingId === finding.id))) return reject("incomplete-verdicts", "Resolve every disputed packet finding exactly once");
      const findings: Fact[] = input.decisions.map(verdict => { const finding = state.findings.find(finding => finding.id === verdict.findingId)!; const { resolution, ...unresolved } = finding; const { findingId, ...decision } = verdict; return { kind: "finding-recorded", finding: { ...unresolved, verdicts: [...finding.verdicts, { ...decision, judgeId: "trusted-user", round: input.round }], ...(verdict.verdict !== "accepted" ? { resolution: { kind: verdict.verdict === "deferred" ? "explicitly-deferred" as const : verdict.verdict === "duplicate" ? "duplicate" as const : "rejected" as const, reason: verdict.reason, codeIdentity: state.code!.identity, evidence: verdict.evidence } } : {}) } }; });
      const projected = { ...state, findings: state.findings.map(finding => findings.find((fact): fact is Extract<Fact, { kind: "finding-recorded" }> => fact.kind === "finding-recorded" && fact.finding.id === finding.id)?.finding ?? finding) };
      const unresolved = unresolvedFindings(projected), caps = limitTriggers(projected, state.usage, context.now);
      const triggers = [...new Set([...state.recovery.triggers.filter(trigger => trigger !== "judge-disagreement" && !trigger.endsWith("-cap") && (trigger !== "no-progress" || unresolved.length > 0)), ...caps])];
      const round = state.reviewRounds.find(round => round.round === input.round);
      if (!round || state.reviewRounds.at(-1)?.round !== input.round) return reject("stale-judge-resolution", "Resolve the latest completed review round");
      return append({ kind: "approval-recorded", approval: input.approval }, ...findings, { kind: "review-round-recorded", round: { ...round, unresolvedFingerprints: unresolved.map(finding => finding.fingerprint).sort() } }, { kind: "lifecycle-changed", from: state.lifecycle, to: triggers.length ? "paused" : "active", phase: state.phase, ...(triggers.length ? { recovery: { ...state.recovery, triggers, primaryReason: triggers[0], requiredChoices: triggers.includes("no-progress") ? ["change-reviewers", "override-with-rationale", "stop"] : ["continue", "stop"] } } : {}) });
    }
    case "override-stall": {
      const round = state.reviewRounds.at(-1), error = approvalError(state, input.approval);
      if (!round || !state.recovery?.triggers.includes("no-progress") || state.recovery.triggers.includes("judge-disagreement") || error || input.approval.authority !== "omp-tui" || input.approval.kind !== "stall-override" || input.approval.decision !== "approve" || input.approval.scopeHash !== digestJson({ round: round.round, newSeatIds: input.newSeatIds }) || !input.approval.rationale.trim() || input.newSeatIds.length > 0 && (input.newSeatIds.length !== requiredLenses(state).length || new Set(input.newSeatIds).size !== input.newSeatIds.length || input.newSeatIds.some(id => !state.seats.some(seat => seat.seatId === id)))) return reject("invalid-stall-override", error ?? "Resolve disagreement first; stall override requires an exact rationale and one available seat per required lens");
      const triggers = [...new Set([...state.recovery.triggers.filter(trigger => trigger !== "no-progress" && !trigger.endsWith("-cap")), ...limitTriggers(state, state.usage, context.now)])];
      return append({ kind: "approval-recorded", approval: input.approval }, { kind: "review-round-recorded", round: { ...round, override: { approvalId: input.approval.id, seatIds: input.newSeatIds, rationale: input.approval.rationale } } }, { kind: "lifecycle-changed", from: state.lifecycle, to: triggers.length ? "paused" : "active", phase: state.phase, ...(triggers.length ? { recovery: { ...state.recovery, primaryReason: triggers[0], triggers, requiredChoices: ["continue", "stop"] } } : {}) });
    }
    case "start": return reject("run-exists", "This run already exists");
    case "record-work": {
      const item = input.assignment;
      if (state.lifecycle !== "active" || state.work.some(work => work.id === item.id && work.revision === item.revision)) return reject("invalid-work", "Work must be new and the run active");
      if (!state.seats.some(seat => seat.seatId === item.seatId)) return reject("missing-seat", `Seat ${item.seatId} is unavailable`);
      if (item.mutation !== "read-only" && !state.plan?.items.some(assignment => same(assignment, item))) return reject("unplanned-mutation", "Mutation work requires an exact plan assignment");
      return append({ kind: "work-recorded", work: initialWork(item) });
    }
    case "record-plan": {
      const issues = validatePlan(input.plan, state);
      if (issues.length) return { kind: "reject", code: "invalid-plan", message: issues.map(issue => issue.message).join("; "), evidence: [] };
      if (input.plan.revision !== state.planRevision + 1) return reject("stale-plan", "Plan revision must advance once");
      if (input.sourceWork && !state.work.some(work => workMatches(work, input.sourceWork!) && work.status === "succeeded" && work.result?.kind === "plan" && same(work.result.plan, input.plan))) return reject("unverified-plan", "Plan does not match a successful planning result");
      const classification = planClassification(state, input.plan);
      const affectedWork = state.work.filter(work => !terminalWork(work) && state.plan?.items.some(item => item.id === work.id) && !input.plan.items.some(item => item.id === work.id && item.revision === work.revision));
      return append({ kind: "plan-recorded", plan: input.plan, classification, affectedWork: affectedWork.map(({ id, revision }) => ({ id, revision })) });
    }
    case "record-trusted-approval": {
      const error = approvalError(state, input.approval);
      if (error) return reject("invalid-approval", error);
      if (state.approvals.some(approval => approval.id === input.approval.id)) return reject("approval-id-conflict", "Approval ID already exists");
      return append({ kind: "approval-recorded", approval: input.approval });
    }
    case "record-instruction": {
      if (state.instructions.some(instruction => instruction.id === input.instruction.id)) return reject("instruction-id-conflict", "Instruction ID already exists");
      if (!input.instruction.affectedWork.every(ref => state.work.some(work => work.id === ref.id && work.revision === ref.revision))) return reject("unknown-work", "Instruction targets unknown work");
      return append({ kind: "instruction-recorded", instruction: input.instruction });
    }
    case "issue-action": {
      const error = actionIssueError(state, input.draft);
      if (error) return reject("invalid-action", error);
      const action: ActionRecord = { schemaVersion: 1, id: `a-${state.eventSequence + 1}`, runId: state.runId, ownerEpoch: state.owner.epoch, expectedStateRevision: state.eventSequence + 1, ...input.draft, inputHash: digestJson(input.draft.input), status: "issued", issuedAt: context.now, receiptIds: [] };
      if (input.programHash) action.programHash = input.programHash;
      return append({ kind: "action-issued", action });
    }
    case "claim-action": {
      const action = state.actions.find(action => action.id === input.actionId);
      if (action?.status === "superseded" && !action.claimedAt) return reject("stale-action", "Action was superseded by a later state revision");
      if (!action || action.status !== "issued") return reject("action-not-claimable", "Action is missing, stale or already consumed");
      if (action.expectedStateRevision !== state.eventSequence || input.expectedStateRevision !== state.eventSequence || action.planRevision !== state.planRevision || action.ownerEpoch !== state.owner.epoch || action.inputHash !== input.inputHash || action.programHash !== input.programHash) return reject("stale-action", "Action revision, owner or program/input hash differs");
      if (state.lifecycle !== "active" && action.input.kind !== "collect_input" && !(state.lifecycle === "cancelling" && ["cancel_runtime", "wait"].includes(action.input.kind))) return reject("inactive-run", "The run cannot start this action");
      return append({ kind: "action-claimed", actionId: action.id, claimToolCallId: input.toolCallId, at: context.now });
    }
    case "observe-receipt": {
      const receipt = input.receipt, action = state.actions.find(action => action.id === receipt.actionId);
      const retainedCompletion = receipt.kind === "completed" && state.work.some(work => workMatches(work, receipt.work) && ["superseded", "awaiting-recovery", "awaiting-output"].includes(work.status));
      const knownReturn = (receipt.kind === "tool-returned" || receipt.kind === "workspace-returned") && state.toolInvocations.some(invocation => invocation.id === receipt.invocationId && invocation.actionId === receipt.actionId && ["running", "uncertain"].includes(invocation.outcome));
      if (!action || !["claimed", "running", "uncertain"].includes(action.status) && !knownReturn && !retainedCompletion) return reject("stale-result", "Result belongs to an unclaimed, settled or superseded action");
      if (receipt.runId !== state.runId || receipt.ownerEpoch !== state.owner.epoch || receipt.planRevision !== action.planRevision || receipt.inputHash !== action.inputHash || action.programHash !== input.observation.verifiedProgramHash) return reject("receipt-mismatch", "Receipt does not match the claimed owner, input or verified program");
      const operation = action.input;
      const facts: Fact[] = [{ kind: "receipt-recorded", receiptId: receipt.receiptId, receiptDigest: digestJson(receipt), actionId: action.id, receiptKind: receipt.kind, verification: input.observation.kind, evidence: receipt.evidence }];
      if (receipt.kind === "created" && operation.kind === "pool_create") {
        const pool = state.pools.find(pool => pool.id === operation.poolId);
        if (!pool || pool.owner || receipt.owner.kind !== "pool" || receipt.owner.actionId !== action.id || receipt.owner.ownerEpoch !== state.owner.epoch || receipt.owner.sessionId !== state.owner.sessionId) return reject("unexpected-pool-owner", "Pool creation does not match its current pool action");
        facts.push({ kind: "pool-recorded", pool: { ...pool, status: "running", owner: receipt.owner } }, { kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: receipt.evidence } });
      } else if (receipt.kind === "created" || receipt.kind === "completed") {
        const ref = receipt.work, work = ref && state.work.find(work => workMatches(work, ref)), owner = receipt.owner;
        if (!work || !["running", "superseded", "awaiting-recovery", "awaiting-output"].includes(work.status) || !action.recipients.some(recipient => recipient.workId === work.id && recipient.workRevision === work.revision && recipient.attemptId === work.attempt.id)) return reject("stale-result", "Result does not belong to a current running work attempt");
        if (owner.actionId !== action.id || owner.workId !== work.id || owner.workRevision !== work.revision || owner.attemptId !== work.attempt.id || owner.ownerEpoch !== state.owner.epoch || owner.sessionId !== state.owner.sessionId) return reject("owner-mismatch", "Runtime owner does not match the action and work attempt");
        if (receipt.kind === "created") {
          if (work.runtimeOwners.some(previous => runtimeIdentity(previous) === runtimeIdentity(owner))) return reject("duplicate-runtime-owner", "Runtime owner already recorded");
          facts.push({ kind: "work-recorded", work: { ...work, runtimeOwners: [...work.runtimeOwners, owner] } });
          if (work.context?.kind === "review" || work.context?.kind === "judge") { const roundNumber = work.context.round, round = state.reviewRounds.find(round => round.round === roundNumber); if (round) facts.push({ kind: "review-round-recorded", round: { ...round, ...(work.context.kind === "review" ? { reviewerOwners: [...round.reviewerOwners, owner] } : { judgeOwners: [...round.judgeOwners, owner] }) } }); }
          if (receipt.worktree) {
            const observation = receipt.worktree;
            if (observation.runId !== state.runId || !same(observation.work, { id: work.id, revision: work.revision, attemptId: work.attempt.id }) || observation.actionId !== action.id || input.observation.kind !== "runtime-confirmed" || !observation.evidence.length || observation.evidence.some(ref => ref.availability !== "available")) return reject("unobserved-worktree", "Worktree provenance differs from the observed runtime creation");
            facts.push({ kind: "worktree-recorded", worktree: observation });
          }
          if (operation.kind === "pool_push") {
            const pool = state.pools.find(pool => pool.id === operation.poolId), item = operation.items.find(item => workMatches(work, item.work));
            if (!pool || !item || owner.logicalKey === undefined || !owner.parentId || pool.owner?.id !== owner.parentId) return reject("pool-item-mismatch", "Pool result lacks its stable logical key and runtime key");
            facts.push({ kind: "pool-recorded", pool: { ...pool, items: pool.items.map(previous => previous.logicalId === item.logicalId ? { ...previous, key: owner.logicalKey } : previous) } });
          }
        } else {
          if (!work.runtimeOwners.some(previous => runtimeIdentity(previous) === runtimeIdentity(owner)) || input.observation.kind !== "runtime-confirmed" || owner.status !== "observed-terminal") return reject("unconfirmed-result", "Completion requires observed terminal runtime ownership");
          const owners = work.runtimeOwners.map(previous => runtimeIdentity(previous) === runtimeIdentity(owner) ? owner : previous);
          if (owners.some(previous => previous.status !== "observed-terminal")) return reject("unsettled-owner", "Other work owners remain unsettled");
          if (work.status !== "running") return append(...facts, { kind: "work-recorded", work: { ...work, runtimeOwners: owners, evidence: [...work.evidence, ...receipt.evidence] } }, { kind: "output-retained", result: { work: receipt.work, actionId: action.id, outputRef: receipt.evidence[0] ?? state.repository.baselineRef, reason: work.status === "superseded" ? "superseded" : "recovery", evidence: receipt.evidence } });
          try { assertSchema(persistedSchemaByName(work.outputSchema.name, work.outputSchema.version), receipt.output, "worker output"); } catch (error) { return reject("invalid-output", String(error)); }
          const problem = outputProblem(state, work, receipt.output);
          if (problem) {
            const correction = invalidOutputDecision(state, work, action, receipt.evidence[0] ?? work.evidence[0] ?? state.repository.baselineRef, { ...input.observation, settledOwners: owners }, context);
            return correction.kind === "append" ? append(...facts, ...correction.facts) : correction;
          }
          let output = receipt.output;
          if (output.kind === "review") output = { ...output, findings: output.findings.map(finding => { const fingerprint = findingFingerprint(finding), prior = state.findings.find(previous => previous.fingerprint === fingerprint); return { ...finding, id: prior?.id ?? `${work.id}:${finding.id}`, fingerprint, verdicts: prior?.verdicts ?? [] }; }) };
          const succeeded: WorkItem = { ...work, status: output.kind === "build" && output.outcome === "failed" ? "failed" : "succeeded", runtimeOwners: owners, result: output, completedAt: context.now, evidence: [...work.evidence, ...receipt.evidence] };
          facts.push({ kind: "work-recorded", work: succeeded });
          if (output.kind === "review") for (const finding of output.findings) facts.push({ kind: "finding-recorded", finding });
          if (work.context?.kind === "correction") {
            const originalRef = work.context.original;
            const original = state.work.find(candidate => workMatches(candidate, originalRef));
            if (!original || original.status !== "awaiting-output") return reject("stale-correction", "Original work no longer awaits this report");
            const corrected = { ...output, workId: original.id, workRevision: original.revision, attemptId: original.attempt.id };
            facts.push({ kind: "work-recorded", work: { ...original, status: corrected.kind === "build" && corrected.outcome === "failed" ? "failed" : "succeeded", result: corrected, completedAt: context.now, evidence: [...original.evidence, ...receipt.evidence] } });
            const originalAction = state.actions.find(candidate => candidate.recipients.some(recipient => recipient.workId === original.id && recipient.attemptId === original.attempt.id) && ["claimed", "running"].includes(candidate.status));
            if (originalAction && originalAction.recipients.every(recipient => recipient.workId === original.id || state.work.some(other => other.id === recipient.workId && other.revision === recipient.workRevision && terminalWork(other)))) facts.push({ kind: "action-settled", actionId: originalAction.id, result: { kind: "success", evidence: receipt.evidence } });
            output = corrected;
          }
          const proposals = [...(output.proposedTools ?? []), ...(output.kind === "plan" ? output.plan.toolProposals : [])];
          for (const proposal of proposals) {
            const previous = [...state.tools].reverse().find(tool => tool.name === proposal.name);
            if (!previous || previous.sourceHash !== proposal.sourceHash || previous.schemaHash !== proposal.schemaHash || !same(previous.effects, proposal.effects) || !same(previous.initialization, proposal.initialization) || !same(previous.intendedUsers, proposal.intendedUsers)) facts.push({ kind: "tool-recorded", definition: toolDefinition(state, proposal, proposalGrants(state, proposal, output.kind === "plan" ? output.plan : state.plan)) });
          }
          if (action.recipients.every(recipient => recipient.workId === work.id || state.work.some(other => other.id === recipient.workId && other.revision === recipient.workRevision && terminalWork(other)))) facts.push({ kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: receipt.evidence } });
          if (output.kind === "build" && output.proposedAmendment) {
            const amendment = output.proposedAmendment;
            if (!state.plan || amendment.baseRevision !== state.planRevision || amendment.proposedPlan.revision !== state.planRevision + 1 || validatePlan(amendment.proposedPlan, state).length) return reject("invalid-amendment", "Builder amendment does not target the current validated plan");
            const projected = { ...state, work: state.work.map(candidate => candidate.id === work.id && candidate.revision === work.revision ? succeeded : candidate) };
            const accepted = decide(projected, { kind: "record-plan", plan: amendment.proposedPlan }, context);
            if (accepted.kind !== "append") return accepted;
            facts.push(...accepted.facts);
          }
          if (succeeded.status === "failed") facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "build-failed", [succeeded]), evidence: receipt.evidence } });
        }
      } else if (receipt.kind === "failed") {
        const work = receipt.work && state.work.find(work => workMatches(work, receipt.work!));
        if (receipt.work && (!work || work.status !== "running" || !action.recipients.some(recipient => recipient.workId === work.id && recipient.attemptId === work.attempt.id))) return reject("stale-result", "Failure targets a stale attempt");
        if (work) facts.push({ kind: "work-recorded", work: { ...work, status: "awaiting-recovery", evidence: [...work.evidence, ...receipt.effectEvidence] } });
        facts.push({ kind: "action-settled", actionId: action.id, result: { kind: "uncertain", reason: receipt.diagnostic.message, unresolvedOwners: liveOwners(state), evidence: receipt.effectEvidence } }, { kind: "lifecycle-changed", from: state.lifecycle, to: work ? "active" : "blocked", phase: state.phase, recovery: { ...recovery(state, "execution-failed", work ? [work] : undefined), ...(work ? { scope: "items" as const } : {}), evidence: receipt.effectEvidence } });
      } else if (receipt.kind === "cancel-requested") {
        if (operation.kind !== "cancel_runtime") return reject("unexpected-receipt", "No cancellation action is pending");
      } else if (receipt.kind === "cancel-confirmed") {
        if (operation.kind !== "cancel_runtime" || input.observation.kind !== "runtime-confirmed" || !receipt.settlementEvidence.length || receipt.settlementEvidence.some(ref => ref.availability !== "available") || receipt.owners.some(owner => owner.status !== "observed-terminal")) return reject("unconfirmed-cancellation", "Cancellation acknowledgment does not prove termination");
        if (!operation.owners.every(owner => receipt.owners.some(confirmed => runtimeIdentity(confirmed) === runtimeIdentity(owner)))) return reject("unresolved-cancellation", "Managed runtime owners remain unresolved");
        for (const work of state.work) {
          const owners = work.runtimeOwners.map(owner => receipt.owners.find(confirmed => runtimeIdentity(confirmed) === runtimeIdentity(owner)) ?? owner);
          if (owners.some((owner, index) => owner !== work.runtimeOwners[index])) facts.push({ kind: "work-recorded", work: { ...work, status: terminalWork(work) ? work.status : state.lifecycle === "cancelling" || state.recovery?.intent === "cancel" ? "cancelled" : work.status, runtimeOwners: owners } });
        }
        for (const pool of state.pools) if (pool.owner && receipt.owners.some(owner => runtimeIdentity(owner) === runtimeIdentity(pool.owner!))) facts.push({ kind: "pool-recorded", pool: { ...pool, status: "closed", owner: { ...pool.owner, status: "observed-terminal" } } });
        facts.push({ kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: receipt.settlementEvidence } });
        const cancelsRun = state.lifecycle === "cancelling" || state.recovery?.intent === "cancel";
        if (cancelsRun && liveOwners(state).every(owner => receipt.owners.some(confirmed => runtimeIdentity(confirmed) === runtimeIdentity(owner))) && !state.toolInvocations.some(invocation => ["running", "uncertain"].includes(invocation.outcome)) && state.work.filter(work => work.mutation !== "read-only" && work.isolation.kind === "worktree" && work.runtimeOwners.length > 0).every(work => state.patches.some(patch => workMatches(work, patch.work)))) facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "cancelled", phase: state.phase });
      } else if (receipt.kind === "pool-closed") {
        if (operation.kind !== "pool_close" || operation.poolId !== receipt.poolId || input.observation.kind !== "runtime-confirmed") return reject("unexpected-pool-close", "Pool close does not match a claimed close operation");
        const pool = state.pools.find(pool => pool.id === receipt.poolId);
        if (!pool || receipt.queuedKeysCancelled.some(key => !pool.items.some(item => item.key === key && state.work.some(work => workMatches(work, item.work) && work.status === "pending")))) return reject("pool-key-mismatch", "Close discarded an unknown or running key");
        const running = pool.items.filter(item => state.work.some(work => workMatches(work, item.work) && work.status === "running"));
        if (running.some(item => !receipt.runningOwners.some(owner => owner.logicalKey === item.key && owner.parentId === pool.owner?.id))) return reject("unresolved-pool-close", "Close omitted a running owner");
        facts.push({ kind: "pool-recorded", pool: { ...pool, status: running.length ? "closing" : "closed", ...(pool.owner && !running.length ? { owner: { ...pool.owner, status: "observed-terminal" as const } } : {}) } }, { kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: receipt.evidence } });
      } else if (receipt.kind === "tool-registered") {
        if (operation.kind !== "register_tool" || receipt.name !== operation.toolName || receipt.version !== operation.toolVersion || receipt.sourceHash !== operation.sourceHash || receipt.schemaHash !== operation.schemaHash || receipt.kernelGeneration !== state.kernelGeneration || input.observation.kind !== "runtime-confirmed") return reject("unapproved-registration", "Tool registration differs from its approved version or kernel");
        const definition = state.tools.find(tool => tool.name === operation.toolName && tool.version === operation.toolVersion);
        if (!definition || definition.approvalId !== operation.approvalId || definition.approvalScopeHash !== operation.approvalScopeHash) return reject("changed-tool-approval", "Registration approval no longer matches its scope");
        facts.push({ kind: "tool-recorded", definition: { ...definition, registration: "registered", runtimeName: receipt.runtimeName, evidence: [...definition.evidence, ...receipt.evidence] } }, { kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: receipt.evidence } });
      } else if (receipt.kind === "tool-called") {
        const definition = state.tools.find(tool => tool.name === receipt.name && tool.version === receipt.version), work = state.work.find(work => workMatches(work, receipt.caller));
        if (!definition || !work || work.status !== "running" || !action.recipients.some(recipient => recipient.workId === work.id && recipient.attemptId === work.attempt.id) || definition.registration !== "registered" || definition.kernelGeneration !== state.kernelGeneration || definition.kernelGeneration !== receipt.kernelGeneration || definition.approvalScopeHash !== toolApprovalScope(definition, definition.grants) || !work.toolGrants.some(grant => grant.name === definition.name && grant.version === definition.version && grant.approvalId === definition.approvalId) || !definition.grants.some(grant => grant.workId === work.id && grant.workRevision === work.revision && grant.seatId === work.attempt.seatId) || input.observation.kind !== "runtime-confirmed" || state.toolInvocations.some(invocation => invocation.id === receipt.invocationId)) return reject("unapproved-tool-call", "Tool call lacks its exact approved version, work grant or kernel");
        facts.push({ kind: "tool-invocation-recorded", invocation: { schemaVersion: 1, id: receipt.invocationId, actionId: action.id, caller: receipt.caller, name: receipt.name, version: receipt.version, kernelGeneration: receipt.kernelGeneration, parentBefore: receipt.parentBefore, evidence: receipt.evidence, outcome: "running" } });
      } else if (receipt.kind === "workspace-called") {
        const work = state.work.find(work => workMatches(work, receipt.caller));
        if (!work || work.status !== "running" || !action.recipients.some(recipient => recipient.workId === work.id && recipient.workRevision === work.revision && recipient.attemptId === work.attempt.id) || input.observation.kind !== "runtime-confirmed" || state.toolInvocations.some(invocation => invocation.id === receipt.invocationId) || !receipt.evidence.length || receipt.evidence.some(ref => ref.availability !== "available")) return reject("unapproved-workspace-call", "Workspace invocation requires the exact running work and captured manifest evidence");
        facts.push({ kind: "tool-invocation-recorded", invocation: { schemaVersion: 1, id: receipt.invocationId, actionId: action.id, caller: receipt.caller, name: "supership_workspace", version: 1, kernelGeneration: state.kernelGeneration, parentBefore: receipt.parentBefore, evidence: receipt.evidence, outcome: "running" } });
      } else if (receipt.kind === "tool-returned" || receipt.kind === "workspace-returned") {
        const invocation = state.toolInvocations.find(invocation => invocation.id === receipt.invocationId);
        if (!invocation || invocation.actionId !== action.id || !["running", "uncertain"].includes(invocation.outcome) || (receipt.kind === "tool-returned" ? invocation.name !== receipt.name || invocation.version !== receipt.version || invocation.kernelGeneration !== receipt.kernelGeneration : invocation.name !== "supership_workspace") || input.observation.kind !== "runtime-confirmed") return reject("unexpected-tool-return", "Tool return does not match an observed current invocation");
        facts.push({ kind: "tool-invocation-recorded", invocation: { ...invocation, parentAfter: receipt.parentAfter, outcome: receipt.outcome, evidence: [...invocation.evidence, ...receipt.parentEffectEvidence, ...receipt.evidence] } });
      }
      return append(...facts);
    }
    case "record-invalid-output": {
      const work = state.work.find(work => workMatches(work, input.work)), action = state.actions.find(action => action.id === input.actionId);
      if (!work || work.status !== "running" || !action || !["claimed", "running"].includes(action.status) || action.programHash !== input.observation.verifiedProgramHash || !action.recipients.some(recipient => recipient.workId === work.id && recipient.attemptId === work.attempt.id)) return reject("stale-result", "Malformed output targets no current claimed attempt");
      return invalidOutputDecision(state, work, action, input.outputRef, input.observation, context);
    }
    case "settle-action": {
      const action = state.actions.find(action => action.id === input.actionId);
      if (!action || !["claimed", "running"].includes(action.status)) return reject("invalid-settlement", "Action is not currently claimed");
      const operation = action.input;
      if (["run_finite", "pool_create", "pool_push", "pool_close", "register_tool", "cancel_runtime"].includes(operation.kind)) return reject("invalid-settlement", "This action requires its operation-specific runtime receipt");
      const facts: Fact[] = [{ kind: "action-settled", actionId: action.id, result: input.result }];
      if (input.result.kind !== "success") return append(...facts, { kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...recovery(state, "operation-failed"), evidence: input.result.evidence } });
      if (["create_branch", "integrate", "commit", "push"].includes(operation.kind)) {
        const result = input.result.output;
        const expected = operation.kind;
        if (!result || result.kind !== "git" || result.operation !== expected || !input.result.evidence.length || input.result.evidence.some(ref => ref.availability !== "available")) return reject("unproven-git-operation", "Git completion requires captured evidence for the claimed operation");
        if (operation.kind === "integrate" && (!same(result.work, operation.work) || !same(result.before, operation.expectedBefore))) return reject("wrong-integration", "Integration outcome differs from claimed patch and baseline");
        if (operation.kind === "commit" && (!(result.groupIds?.includes(operation.group.id) || result.groupId === operation.group.id) || !result.commits?.length)) return reject("wrong-commit", "Commit outcome omits its approved logical group");
        if (operation.kind === "push" && (!same(result.remote, operation.remote) || !same(result.commits, operation.commits))) return reject("wrong-publication", "Publication outcome differs from its exact approved remote and commits");
        if (state.code) facts.push({ kind: "code-observed", observation: { ...state.code, identity: result.after, observedAt: context.now, evidence: [...state.code.evidence, ...input.result.evidence] } });
      }
      if (operation.kind === "retire_tool") {
        const definition = state.tools.find(tool => tool.name === operation.toolName && tool.version === operation.toolVersion);
        if (!definition) return reject("missing-tool", "Retired tool version no longer exists");
        facts.push({ kind: "tool-recorded", definition: { ...definition, registration: "retired" } });
      }
      return append(...facts);
    }
    case "record-runtime-snapshot": return append({ kind: "runtime-observed", snapshot: input.snapshot });
    case "record-git-observation": {
      const invalidated = state.verification.filter(record => !sameRelevantCode(record.codeIdentity, input.observation.identity)).map(record => record.id);
      return append({ kind: "code-observed", observation: input.observation }, ...(invalidated.length ? [{ kind: "verification-invalidated" as const, ids: invalidated, reason: "Observed code identity changed", codeIdentity: input.observation.identity }] : []));
    }
    case "invalidate-verification": {
      if (input.ids.some(id => !state.verification.some(record => record.id === id))) return reject("unknown-verification", "Invalidation targets an unrecorded verification");
      if (!input.evidence.length || input.evidence.some(ref => ref.availability !== "available")) return reject("unproven-invalidation", "Invalidation requires available evidence of the stale artifact check");
      const stale = state.verification.filter(record => input.ids.includes(record.id) && (record.outcome !== "unavailable" || record.evidence.some(ref => ref.availability === "available")));
      if (!stale.length) return noDecision(state);
      return append({ kind: "verification-invalidated", ids: stale.map(record => record.id), reason: input.reason, codeIdentity: state.code?.identity ?? stale[0].codeIdentity, evidence: input.evidence });
    }
    case "record-verification": {
      const verification = input.verification;
      const action = state.actions.find(action => action.id === verification.actionId);
      if (!state.code || !same(verification.codeIdentity, state.code.identity) || !action || action.input.kind !== "verify" || !["claimed", "running"].includes(action.status) || verification.checkId !== action.input.check.id || !same(verification.scenario, action.input.check.scenario)) return reject("invalid-verification", "Verification does not match a claimed check on current code");
      if (verification.endedAt < verification.startedAt || verification.verifier.kind !== "runtime" || (verification.outcome === "passed" && (!verification.evidence.length || verification.evidence.some(ref => ref.availability !== "available") || (verification.scenario.kind === "command" && verification.exitCode !== 0)))) return reject("unproven-verification", "Passing verification requires successful runtime evidence");
      if (state.verification.some(record => record.id === verification.id)) return reject("verification-id-conflict", "Verification ID already exists");
      return append({ kind: "verification-recorded", verification }, ...(action.input.check.required && verification.outcome !== "passed" ? [{ kind: "lifecycle-changed" as const, from: state.lifecycle, to: "paused" as const, phase: state.phase, recovery: { ...recovery(state, verification.outcome === "failed" ? "verification-failed" : "verification-unavailable", []), evidence: verification.evidence, requiredChoices: ["replan", "retry", "stop"] } }] : []));
    }
    case "record-source-usage": {
      let sources: RunRecord["usageSources"], coverage: RunRecord["usageCoverage"], usage: RunRecord["usage"];
      try { sources = mergeUsageSources(state.usageSources, input.sources); coverage = mergeUsageCoverage(state, input.coverage ?? []); usage = sourceUsage(state, sources, coverage, context.now); } catch (error) { return reject("invalid-usage-source", String(error)); }
      const triggers = limitTriggers(state, usage, context.now), changed = sources.filter(source => !state.usageSources.some(previous => same(previous, source))), changedCoverage = coverage.filter(record => !state.usageCoverage.some(previous => same(previous, record)));
      const facts: Fact[] = [...(changed.length ? [{ kind: "usage-sources-observed" as const, sources: changed }] : []), ...(changedCoverage.length ? [{ kind: "usage-coverage-observed" as const, coverage: changedCoverage }] : []), { kind: "usage-observed", usage }];
      if (triggers.length && state.lifecycle === "active") facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "paused", phase: state.phase, recovery: { ...recovery(state, triggers[0]), triggers, requiredChoices: ["continue", "stop"] } });
      return append(...facts);
    }
    case "request-pause": {
      const retained = state.recovery ? { ...state.recovery, triggers: [...new Set([...state.recovery.triggers, ...input.recovery.triggers])], evidence: [...state.recovery.evidence, ...input.recovery.evidence] } : input.recovery;
      const facts: Fact[] = state.actions.filter(action => action.input.kind === "collect_input" && action.status === "claimed").map(action => ({ kind: "action-settled", actionId: action.id, result: { kind: "failure", diagnostic: { code: "input-deferred", severity: "warning", message: "Input remains required; no approval was inferred", evidence: retained.evidence }, evidence: retained.evidence } }));
      facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: state.lifecycle === "cancelling" ? "blocked" : "paused", phase: state.phase, recovery: { ...retained, intent: state.lifecycle === "cancelling" || state.recovery?.intent === "cancel" ? "cancel" : retained.intent } });
      return append(...facts);
    }
    case "request-cancel": {
      if (state.lifecycle === "cancelling") return reject("already-cancelling", "Cancellation is already pending");
      const unresolved = state.work.some(work => work.status === "running" || work.status === "awaiting-recovery") || liveOwners(state).length > 0;
      const pending: Fact[] = state.work.filter(work => work.status === "pending").map(work => ({ kind: "work-recorded", work: { ...work, status: "cancelled" } }));
      return append(...pending, { kind: "lifecycle-changed", from: state.lifecycle, to: unresolved ? "cancelling" : "cancelled", phase: state.phase, ...(unresolved ? { recovery: { ...recovery(state, input.reason), intent: "cancel" as const, evidence: input.evidence } } : {}) });
    }
    case "resume": {
      if (context.ownerSessionId !== input.sessionId || context.ownerEpoch !== state.owner.epoch) return reject("stale-owner", "Resume must compare the current epoch under its writer lease");
      const sameOwner = input.sessionId === state.owner.sessionId && input.leaseId === state.owner.leaseId;
      const facts: Fact[] = [];
      if (!sameOwner) facts.push({ kind: "owner-claimed", owner: { sessionId: input.sessionId, epoch: state.owner.epoch + 1, leaseId: input.leaseId }, previousEpoch: state.owner.epoch, reconciliation: input.reconciliation.candidateResults });
      const ambiguous = state.work.filter(work => ["running", "awaiting-output", "awaiting-recovery"].includes(work.status));
      if (!sameOwner) for (const pool of state.pools.filter(pool => !["closed", "lost"].includes(pool.status))) facts.push({ kind: "pool-recorded", pool: { ...pool, status: "lost", ...(pool.owner ? { owner: { ...pool.owner, status: "unknown" } } : {}) } });
      for (const work of ambiguous) facts.push({ kind: "work-recorded", work: { ...work, status: "awaiting-recovery", runtimeOwners: work.runtimeOwners.map(owner => input.reconciliation.confirmed.find(confirmed => runtimeIdentity(confirmed) === runtimeIdentity(owner)) ?? owner) } });
      if (ambiguous.length || input.reconciliation.unresolved.length || input.reconciliation.requiredChoices.length || state.recovery) facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "blocked", phase: state.phase, recovery: { ...(state.recovery ?? recovery(state, "resume-reconciliation")), unresolvedOwners: input.reconciliation.unresolved } });
      else facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "active", phase: state.phase });
      return append(...facts);
    }
    case "resolve-recovery": {
      const current = state.recovery, choice = input.choice, inspected = input.evidence, error = approvalError(state, input.approval);
      if (!current || error || input.approval.authority !== "omp-tui" || input.approval.kind !== "recovery" || input.approval.decision !== "approve" || !inspected.writerExclusive || input.approval.scopeHash !== digestJson(choice) || inspected.evidence.some(ref => ref.availability !== "available")) return reject("invalid-recovery", error ?? "Recovery requires current inspected evidence and exact trusted approval");
      if (!choice.affectedWork.every(ref => current.affectedWork.some(affected => same(affected, ref)))) return reject("invalid-recovery", "Recovery cannot expand the affected work");
      if (choice.kind === "continue" && (current.triggers.includes("no-progress") || current.triggers.includes("judge-disagreement"))) return reject("specific-recovery-required", "Resolve the recorded judge disagreement or use a rationale-bound stall override");
      const matches = (owner: RuntimeOwner) => inspected.runtime.confirmed.find(confirmed => runtimeIdentity(owner) === runtimeIdentity(confirmed));
      const scopedOwners = current.scope === "items" && choice.kind !== "stop" ? liveOwners(state).filter(owner => current.affectedWork.some(ref => ref.id === owner.workId && ref.revision === owner.workRevision) || owner.kind === "pool" && state.pools.some(pool => pool.owner?.id === owner.id && pool.status === "lost" && pool.items.some(item => current.affectedWork.some(ref => ref.id === item.work.id && ref.revision === item.work.revision)))) : liveOwners(state);
      const unresolved = scopedOwners.filter(owner => matches(owner)?.status !== "observed-terminal");
      const unknown = inspected.runtime.unresolved.filter(owner => scopedOwners.some(scoped => runtimeIdentity(scoped) === runtimeIdentity(owner)));
      const facts: Fact[] = [{ kind: "approval-recorded", approval: input.approval }, { kind: "code-observed", observation: inspected.git }];
      const toolResults = choice.toolResults ?? [];
      for (const result of toolResults) {
        const invocation = state.toolInvocations.find(invocation => invocation.id === result.id);
        if (!invocation || !["running", "uncertain"].includes(invocation.outcome) || !result.evidence.length || result.evidence.some(ref => ref.availability !== "available")) return reject("unproven-tool-effects", "Tool recovery requires captured results for an unresolved invocation");
        facts.push({ kind: "tool-invocation-recorded", invocation: { ...invocation, outcome: result.outcome, parentAfter: result.parentAfter, evidence: [...invocation.evidence, ...result.evidence] } });
      }
      const pendingTools = state.toolInvocations.filter(invocation => ["running", "uncertain"].includes(invocation.outcome) && !toolResults.some(result => result.id === invocation.id));
      if (choice.kind === "stop" && (unresolved.length || unknown.length || pendingTools.length)) {
        facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "cancelling", phase: state.phase, recovery: { ...current, intent: "cancel", primaryReason: "cancellation-settlement", unresolvedOwners: unresolved, evidence: [...current.evidence, ...inspected.evidence] } });
        return append(...facts);
      }
      if (choice.kind !== "continue" && (unresolved.length || unknown.length || pendingTools.length)) return reject("unconfirmed-owner", "Every prior runtime owner and parent callback must settle before this disposition");
      if (choice.kind === "continue" && (inspected.runtime.unresolved.length || pendingTools.length || liveOwners(state).some(owner => !matches(owner)))) return reject("unconfirmed-owner", "Continue requires known current owners; absence from a snapshot is not settlement");
      const affected = state.work.filter(work => current.affectedWork.some(ref => ref.id === work.id && ref.revision === work.revision));
      const actionable = affected.filter(work => ["awaiting-recovery", "awaiting-output", "failed"].includes(work.status));
      if (choice.kind === "continue" && actionable.length) return reject("item-disposition-required", "Unresolved work needs adoption, retry, discard or stop");
      if (choice.kind === "continue") {
        const triggers = limitTriggers(state, state.usage, context.now);
        if (triggers.length) return reject("limit-still-reached", "Raise the recorded limits before continuing: " + triggers.join(", "));
      }
      const replacements = new Map<string, WorkItem>();
      for (const work of affected) {
        const selected = choice.affectedWork.some(ref => ref.id === work.id && ref.revision === work.revision);
        if (!selected && choice.kind !== "stop" && choice.kind !== "replan") continue;
        const owners = work.runtimeOwners.map(owner => matches(owner) ?? owner);
        if (terminalWork(work) && work.status !== "failed") { if (choice.kind === "adopt") { const adoption = choice.adoptions?.find(adoption => workMatches(work, adoption.work)); if (!adoption || !work.result || !same(adoption.output, work.result) || !adoption.effectEvidence.length || adoption.effectEvidence.some(ref => ref.availability !== "available")) return reject("missing-adoption-evidence", "Adoption of retained effects requires the exact accepted report and effect evidence"); } if (!same(owners, work.runtimeOwners)) replacements.set(work.id + "@" + work.revision, { ...work, runtimeOwners: owners }); continue; }
        if (choice.kind === "adopt") {
          const adoption = choice.adoptions?.find(adoption => workMatches(work, adoption.work));
          if (!adoption || !adoption.effectEvidence.length || adoption.effectEvidence.some(ref => ref.availability !== "available")) return reject("missing-adoption-evidence", "Adoption requires an exact captured report and inspected effect evidence");
          const problem = outputProblem(state, work, adoption.output);
          if (problem || adoption.output.kind === "build" && adoption.output.outcome === "failed") return reject("invalid-adoption", problem ?? "A failed build cannot be adopted as success");
          replacements.set(work.id + "@" + work.revision, { ...work, status: "succeeded", runtimeOwners: owners, result: adoption.output, completedAt: context.now, evidence: [...work.evidence, ...adoption.effectEvidence] });
        } else if (choice.kind === "retry" || choice.kind === "discard" && work.mutation === "read-only" && work.context?.kind !== "correction") {
          // A read-only item has no effect to keep or lose: discarding its attempt drops the report and reschedules the item, so the
          // review round or planning graph still completes with every required seat.
          if (work.mutation !== "read-only" && ["invalid-output", "output-attempts-exhausted", "missing-named-fallback"].includes(current.primaryReason)) return reject("mutation-report-retry", "Malformed mutation output can only be corrected or adopted; the mutation must not repeat");
          const { result, completedAt, ...retry } = work;
          replacements.set(work.id + "@" + work.revision, { ...retry, status: "pending", runtimeOwners: [], attempt: { ...work.attempt, id: work.id + ":r" + work.revision + ":" + (work.attempt.number + 1), number: work.attempt.number + 1, validationStage: "initial" } });
        } else if (["discard", "stop", "replan"].includes(choice.kind)) replacements.set(work.id + "@" + work.revision, { ...work, status: "cancelled", runtimeOwners: owners });
      }
      if (choice.kind === "recreate-tool" || choice.kind === "reproposal") {
        if (!choice.toolProposals?.length) return reject("missing-tool-proposal", "Kernel recovery requires newly captured literal tool proposals; recorded source is never replayed");
        for (const proposal of choice.toolProposals) {
          const prior = [...state.tools].reverse().find(tool => tool.name === proposal.name);
          if (!prior || proposal.sourceRef.availability !== "available" || proposal.schemaHash !== digestJson(proposal.parameters)) return reject("uncaptured-tool", "Recovered tool must have current captured source and schema");
          if (choice.kind === "recreate-tool") {
            if (!prior.approvalId || toolApprovalScope(proposal, prior.grants) !== prior.approvalScopeHash) return reject("changed-tool-scope", "Changed source, schema, effects or grants require a new proposal and approval");
            facts.push({ kind: "tool-recorded", definition: { ...prior, ...proposal, kernelGeneration: state.kernelGeneration, parent: { cwd: state.repository.root, sessionId: state.owner.sessionId, ownerEpoch: state.owner.epoch }, registration: "approved", evidence: [...prior.evidence, proposal.sourceRef] } });
          } else facts.push({ kind: "tool-recorded", definition: toolDefinition(state, proposal, prior.grants) });
        }
        for (const work of affected) if (work.status === "awaiting-recovery" && !work.runtimeOwners.length && !state.actions.some(action => action.recipients.some(recipient => recipient.workId === work.id && recipient.attemptId === work.attempt.id) && action.claimedAt)) replacements.set(work.id + "@" + work.revision, { ...work, status: "pending", runtimeOwners: [], attempt: { ...work.attempt, id: work.id + ":r" + work.revision + ":" + (work.attempt.number + 1), number: work.attempt.number + 1 } });
      }
      for (const work of replacements.values()) facts.push({ kind: "work-recorded", work });
      const projectedWork = state.work.map(work => replacements.get(work.id + "@" + work.revision) ?? work);
      const remaining = actionable.filter(work => !replacements.has(work.id + "@" + work.revision));
      if (remaining.length && current.scope === "run" && !["recreate-tool", "reproposal"].includes(choice.kind)) return reject("incomplete-recovery", "Resolve each actionable item before resuming this run");
      for (const pool of state.pools) {
        const owner = pool.owner && (matches(pool.owner) ?? pool.owner);
        const items = pool.items.map(item => {
          const work = replacements.get(item.work.id + "@" + item.work.revision);
          return work?.status === "pending" ? { logicalId: item.logicalId, work: { id: work.id, revision: work.revision, attemptId: work.attempt.id } } : item;
        });
        const poolLost = pool.status === "lost" || !!owner && owner.status === "observed-terminal";
        if (poolLost || !same(items, pool.items)) facts.push({ kind: "pool-recorded", pool: { ...pool, items, ...(owner ? { owner } : {}), status: poolLost ? "closed" : pool.status } });
      }
      for (const action of state.actions) {
        if (!["claimed", "running", "uncertain"].includes(action.status)) continue;
        const control = action.input.kind === "collect_input" || action.input.kind === "wait" || action.input.kind === "cancel_runtime";
        const disposed = action.recipients.length > 0 && action.recipients.every(recipient => { const work = projectedWork.find(work => work.id === recipient.workId && work.revision === recipient.workRevision); return !!work && (terminalWork(work) || work.attempt.id !== recipient.attemptId); });
        const lostPool = ["pool_create", "pool_push", "pool_close"].includes(action.input.kind) && state.pools.some(pool => pool.owner?.actionId === action.id && pool.owner && matches(pool.owner)?.status === "observed-terminal");
        if (control || disposed || lostPool) facts.push({ kind: "action-settled", actionId: action.id, result: { kind: "failure", diagnostic: { code: "recovered-action", severity: "warning", message: "Trusted recovery disposed the prior operation without replaying effects", evidence: inspected.evidence }, evidence: inspected.evidence } });
      }
      if (choice.kind === "replan") {
        const to = state.invocation.mode === "review-only" ? "review" : "plan";
        if (state.invocation.mode === "review-only") {
          if (!state.plan) return reject("missing-review-scope", "Review refinement requires the inspected review scope");
          const sharedEvidenceHash = digestJson(state.plan);
          const refinement = seatWork(state, "review-refinement-" + (state.planRevision + 1) + "-" + state.eventSequence, "plan", "architect", canonicalJson({ task: "Refine only this existing review plan after explicit recovery. Keep scope exactly unchanged, items empty and toolProposals empty. Inspect repository instructions and runnable commands to supply required verification for repairs. Do not invent new feature work, run the normal planning graph, weaken required lenses, or remove mandatory checks. Return the next plan revision.", plan: state.plan, requiredPlanRevision: state.planRevision + 1, recovery: current, reason: choice.reason, code: inspected.git, policy: state.policy }), [], { kind: "planning", stage: "review-refinement", sharedEvidenceHash });
          if (!state.seats.some(seat => seat.seatId === refinement.seatId)) return reject("missing-seat", "Review refinement requires the architect seat");
          facts.push({ kind: "work-recorded", work: refinement });
        }
        facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: "active", phase: state.phase });
        if (to !== state.phase) facts.push(phaseFact(state, to, "Trusted recovery requested a new plan"));
        return append(...facts);
      }
      facts.push({ kind: "lifecycle-changed", from: state.lifecycle, to: choice.kind === "stop" ? "cancelled" : remaining.length && current.scope === "run" ? "blocked" : "active", phase: state.phase, ...(remaining.length ? { recovery: { ...current, affectedWork: remaining.map(({ id, revision }) => ({ id, revision })), unresolvedOwners: [] } } : {}) });
      return append(...facts);
    }
    case "record-kernel-generation": {
      if (input.generation !== state.kernelGeneration + 1) return reject("invalid-generation", "Kernel generation must advance once");
      const affected = state.work.filter(work => !terminalWork(work) && (work.toolGrants.length > 0 || state.pools.some(pool => pool.status !== "closed" && pool.items.some(item => workMatches(work, item.work)))));
      return append({ kind: "kernel-observed", generation: input.generation, reason: input.reason, evidence: input.evidence }, ...state.pools.filter(pool => !["closed", "lost"].includes(pool.status)).map(pool => ({ kind: "pool-recorded" as const, pool: { ...pool, status: "lost" as const, ...(pool.owner ? { owner: { ...pool.owner, status: "unknown" as const } } : {}) } })), ...state.toolInvocations.filter(invocation => invocation.outcome === "running").map(invocation => ({ kind: "tool-invocation-recorded" as const, invocation: { ...invocation, outcome: "uncertain" as const, evidence: [...invocation.evidence, ...input.evidence] } })), ...affected.map(work => ({ kind: "work-recorded" as const, work: { ...work, status: "awaiting-recovery" as const } })), ...(affected.length ? [{ kind: "lifecycle-changed" as const, from: state.lifecycle, to: "active" as const, phase: state.phase, recovery: { ...recovery(state, "kernel-lost", affected), scope: "items" as const, requiredChoices: ["recreate-tool", "reproposal", "discard", "stop"] } }] : []));
    }
    case "record-tool": {
      const definition = input.definition;
      const versions = state.tools.filter(tool => tool.name === definition.name);
      if (definition.version !== Math.max(0, ...versions.map(tool => tool.version)) + 1 || definition.registration !== "proposed" || definition.approvalId || definition.kernelGeneration !== state.kernelGeneration || definition.parent.ownerEpoch !== state.owner.epoch || definition.parent.sessionId !== state.owner.sessionId) return reject("invalid-tool-version", "A tool starts as an unapproved proposal in the current owner and generation");
      if (definition.sourceRef.availability !== "available" || definition.schemaHash !== digestJson(definition.parameters)) return reject("uncaptured-tool", "Tool source and schema must be captured before a proposal");
      return append({ kind: "tool-recorded", definition });
    }
    case "record-review-round": {
      if (input.round.round !== state.reviewRounds.length + 1) return reject("invalid-review-round", "Review round must advance once");
      return append({ kind: "review-round-recorded", round: input.round });
    }
    case "record-finding": return reject("unadjudicated-finding", "Findings require the review and judge operation policy");
    case "advance-phase": {
      const error = phaseError(state, input.phase);
      return error ? reject("invalid-phase", error) : append({ kind: "phase-changed", from: state.phase, to: input.phase, reason: input.reason, evidence: input.evidence });
    }
    case "conclude": {
      const error = completionError(state);
      if (error) return reject("incomplete-run", error);
      if (!input.conclusion.evidence.length || input.conclusion.evidence.some(ref => ref.availability !== "available") || input.conclusion.kind === "no-change" && !noChangeReason(state)) return reject("unproven-conclusion", "Conclusion requires available evidence and a no-change reason when applicable");
      const action = state.actions.find(action => action.input.kind === "conclude" && action.status === "claimed");
      const stableConclusion = ({ evidence, completedAt, ...conclusion }: RunRecord["conclusion"] & object) => conclusion;
      if (!action || action.input.kind !== "conclude" || !same(stableConclusion(action.input.conclusion), stableConclusion(input.conclusion)) || input.conclusion.completedAt < action.input.conclusion.completedAt || input.conclusion.completedAt > context.now) return reject("unclaimed-conclusion", "Conclusion identity differs from its claimed final action");
      return append({ kind: "action-settled", actionId: action.id, result: { kind: "success", evidence: input.conclusion.evidence } }, { kind: "conclusion-recorded", conclusion: input.conclusion }, { kind: "lifecycle-changed", from: state.lifecycle, to: "completed", phase: "conclude" });
    }
  }
}

function phaseError(state: RunRecord, to: Phase): string | undefined {
  const next: Record<Phase, Phase[]> = { preflight: [state.invocation.mode === "review-only" ? "review" : state.invocation.mode === "interactive" && !state.clarificationCompleted ? "clarify" : "research"], clarify: ["research"], research: ["plan"], plan: ["approval"], approval: ["build", "review", "plan"], build: ["review", "plan", "approval"], review: ["build", "verify", "plan", "approval"], verify: ["build", "review", "commit", "publish", "conclude", "plan"], commit: ["publish", "conclude", "plan", "review"], publish: ["conclude", "plan", "review"], conclude: ["plan", "review"] };
  if (state.lifecycle !== "active" || !next[state.phase].includes(to)) return `Cannot move from ${state.lifecycle}/${state.phase} to ${to}`;
  if (state.work.some(work => ["running", "awaiting-recovery"].includes(work.status)) || state.actions.some(action => ["issued", "claimed", "running", "uncertain"].includes(action.status)) || state.toolInvocations.some(invocation => invocation.outcome === "uncertain")) return "Settle current work, actions and parent callbacks before changing phase";
  if (to === "build" && !planApproved(state)) return "Building requires a current approved plan";
  if (state.phase === "research" && !state.work.some(work => work.kind === "research" && work.status === "succeeded")) return "Planning requires shared research evidence";
  if (state.phase === "plan" && !state.plan) return "Approval requires a validated plan";
  if (state.phase === "review" && to === "verify" && (!state.reviewRounds.at(-1)?.completedAt || unresolvedFindings(state).length)) return "Review requires complete judge verdicts and no accepted unresolved finding";
  if (["commit", "publish", "conclude"].includes(to) && state.phase === "verify" && !verificationReady(state)) return "Required verification is not current and passing";
  if (to === "commit" && !state.invocation.commitRequested) return "Invocation did not request commits";
  if (to === "publish" && !state.invocation.pushRequested) return "Invocation did not request publication";
  return undefined;
}
function sameRelevantCode(left: RunRecord["baselineCode"], right: RunRecord["baselineCode"]): boolean {
  return !!left && !!right && left.worktreeDigest === right.worktreeDigest && left.scopeDigest === right.scopeDigest && left.parentEffectDigest === right.parentEffectDigest;
}
function verificationReady(state: RunRecord): boolean {
  if (!state.plan || !state.code) return false;
  if (generatedChange(state) && !state.plan.verificationChecks.some(check => check.required)) return false;
  return state.plan.verificationChecks.filter(check => check.required).every(check => state.verification.some(result => result.checkId === check.id && result.verifier.kind === "runtime" && result.outcome === "passed" && sameRelevantCode(result.codeIdentity, state.code!.identity) && result.evidence.length > 0 && result.evidence.every(ref => ref.availability === "available") && (result.scenario.kind !== "command" || result.exitCode === 0)));
}

export function makeEvent(state: RunRecord | undefined, input: EngineInput, context: DecisionContext, facts: Fact[]): RunEvent {
  const envelope = { schemaVersion: 1 as const, runId: state?.runId ?? (input.kind === "start" ? input.start.runId : ""), sequence: (state?.eventSequence ?? 0) + 1, previousHash: state?.lastEventHash ?? GENESIS_HASH, ownerEpoch: state?.owner.epoch ?? context.ownerEpoch, inputId: context.inputId, inputDigest: digestJson(input), at: context.now, facts };
  const event = { ...envelope, hash: digestJson(envelope) };
  assertSchema(RunEventSchema, event, "event");
  return event;
}

export function applyEvent(previous: RunRecord | undefined, event: RunEvent): RunRecord {
  assertSchema(RunEventSchema, event, "event");
  const { hash, ...envelope } = event;
  if (hash !== digestJson(envelope)) throw new Error("Event hash mismatch");
  if (event.sequence !== (previous?.eventSequence ?? 0) + 1 || event.previousHash !== (previous?.lastEventHash ?? GENESIS_HASH)) throw new Error("Event sequence/hash chain mismatch");
  if (previous && (event.runId !== previous.runId || event.ownerEpoch !== previous.owner.epoch || event.at < previous.updatedAt)) throw new Error("Event run/owner/time mismatch");
  if (previous?.inputReceipts.some(receipt => receipt.id === event.inputId)) throw new Error("Duplicate input in event log");
  let state = previous ? structuredClone(previous) : undefined;
  for (const fact of structuredClone(event.facts)) {
    if (fact.kind === "run-created") {
      if (state || event.sequence !== 1 || fact.start.runId !== event.runId || fact.start.owner.epoch !== event.ownerEpoch) throw new Error("Invalid run genesis");
      const genesis = decide(undefined, { kind: "start", start: fact.start }, { now: event.at, inputId: event.inputId, ownerSessionId: fact.start.owner.sessionId, ownerEpoch: event.ownerEpoch });
      if (genesis.kind !== "append") throw new Error("Genesis failed its preflight or owner contract");
      const { preflight, ...start } = fact.start;
      state = { ...start, usageSources: [], usageCoverage: [], patches: [], pools: [], toolInvocations: [], worktrees: [], gitOutcomes: [], phase: "preflight", lifecycle: "active", planRevision: 0, eventSequence: 0, lastEventHash: GENESIS_HASH, createdAt: event.at, updatedAt: event.at, usage: { tokens: 0, cost: { amount: null, pricedSubtotal: 0, currency: "USD", unpricedModels: [] }, startedAt: event.at, observedAt: event.at, activeOwners: 0, ompConcurrencyCeiling: 1, overshoot: { tokens: 0, cost: null, wallMs: 0 } }, work: [], actions: [], tools: [], approvals: [], findings: [], reviewRounds: [], verification: [], instructions: [], evidence: [], kernelGeneration: 0, inputReceipts: [], receiptDigests: [] };
      continue;
    }
    if (!state) throw new Error("First event must create the run");
    if (["completed", "cancelled"].includes(state.lifecycle)) throw new Error("Event mutates a terminal run");
    switch (fact.kind) {
      case "output-retained": (state.retainedResults ??= []).push(fact.result); break;
      case "patch-recorded": if (state.patches.some(patch => same(patch.work, fact.patch.work))) throw new Error("Duplicate patch receipt"); state.patches.push(fact.patch); break;
      case "seat-bindings-recorded": state.seats = fact.seats; break;
      case "pool-recorded": { const index = state.pools.findIndex(pool => pool.id === fact.pool.id); if (index < 0) state.pools.push(fact.pool); else state.pools[index] = fact.pool; break; }
      case "tool-invocation-recorded": { const index = state.toolInvocations.findIndex(invocation => invocation.id === fact.invocation.id); if (index < 0) state.toolInvocations.push(fact.invocation); else state.toolInvocations[index] = fact.invocation; break; }
      case "worktree-recorded": if (state.worktrees.some(worktree => worktree.path === fact.worktree.path)) throw new Error("Duplicate worktree ownership"); state.worktrees.push(fact.worktree); break;
      case "limits-configured": state.limits = fact.limits; break;
      case "clarification-completed": state.clarificationCompleted = true; state.evidence.push(...fact.evidence); break;
      case "instructions-applied": for (const instruction of state.instructions) if (fact.ids.includes(instruction.id)) instruction.status = "applied"; break;
      case "push-target-recorded": state.pushTarget = fact.target; break;
      case "storage-recovered": state.evidence.push(...fact.preserved); break;
      case "owner-claimed":
        if (fact.previousEpoch !== state.owner.epoch || fact.owner.epoch !== state.owner.epoch + 1) throw new Error("Owner epoch did not advance once");
        state.owner = fact.owner;
        for (const action of state.actions) if (["issued", "claimed", "running"].includes(action.status)) action.status = action.status === "issued" ? "superseded" : "uncertain";
        for (const tool of state.tools) if (tool.registration === "registered") tool.registration = "unavailable";
        break;
      case "instruction-recorded": {
        state.instructions.push(fact.instruction);
        const affected = new Set(fact.instruction.affectedWork.map(ref => `${ref.id}@${ref.revision}`));
        if (state.phase === "plan") for (const work of state.work) if (work.context?.kind === "planning" && work.context.stage !== "shared-research" && !terminalWork(work)) affected.add(`${work.id}@${work.revision}`);
        let expanded: boolean;
        do { expanded = false; for (const work of state.work) if (!affected.has(`${work.id}@${work.revision}`) && work.dependencies.some(ref => affected.has(`${ref.id}@${ref.revision}`))) { affected.add(`${work.id}@${work.revision}`); expanded = true; } } while (expanded);
        for (const work of state.work) if (affected.has(`${work.id}@${work.revision}`)) work.status = "superseded";
        for (const action of state.actions) if (action.recipients.length && (action.status === "issued" ? action.recipients.some(recipient => affected.has(`${recipient.workId}@${recipient.workRevision}`)) : action.recipients.every(recipient => affected.has(`${recipient.workId}@${recipient.workRevision}`)))) action.status = "superseded";
        break;
      }
      case "plan-recorded":
        if (fact.plan.revision !== state.planRevision + 1 || validatePlan(fact.plan, state).length) throw new Error("Invalid plan revision or structure");
        state.planChange = { classification: fact.classification, ...(fact.classification === "ordinary" && state.plan && planApproved(state) ? { approvedScopeHash: currentPlanApproval(state)?.scopeHash ?? planApprovalScope(state.plan) } : {}) };
        state.plan = fact.plan; state.planRevision = fact.plan.revision;
        for (const ref of fact.affectedWork) { const work = state.work.find(work => work.id === ref.id && work.revision === ref.revision); if (work) work.status = "superseded"; }
        for (const action of state.actions) if (action.status === "issued" || (action.recipients.length && action.recipients.every(recipient => fact.affectedWork.some(ref => ref.id === recipient.workId && ref.revision === recipient.workRevision)))) action.status = "superseded";
        break;
      case "approval-recorded": { const error = approvalError(state, fact.approval); if (error || state.approvals.some(approval => approval.id === fact.approval.id)) throw new Error(error ?? "Duplicate approval"); state.approvals.push(fact.approval);
        if (fact.approval.kind === "tool") {
          const ref = fact.approval.toolVersions[0], tool = state.tools.find(tool => tool.name === ref.name && tool.version === ref.version)!;
          tool.registration = fact.approval.decision === "approve" ? "approved" : "retired";
          if (fact.approval.decision === "approve") {
            tool.approvalId = fact.approval.id;
            for (const grant of tool.grants) {
              const work = state.work.find(work => work.id === grant.workId && work.revision === grant.workRevision && work.seatId === grant.seatId);
              if (!work || work.status !== "pending") continue;
              work.toolGrants = [...work.toolGrants.filter(previous => previous.name !== tool.name), { name: tool.name, version: tool.version, approvalId: fact.approval.id }];
            }
          }
        }
        break; }
      case "action-issued":
        if (fact.action.expectedStateRevision !== event.sequence || fact.action.inputHash !== digestJson(fact.action.input) || fact.action.runId !== state.runId || fact.action.ownerEpoch !== state.owner.epoch || fact.action.status !== "issued" || fact.action.receiptIds.length || fact.action.claimToolCallId || state.actions.some(action => action.id === fact.action.id)) throw new Error("Invalid issued action");
        { const error = actionIssueError(state, fact.action); if (error) throw new Error(error); }
        for (const action of state.actions) if (action.status === "issued") action.status = "superseded";
        state.actions.push(fact.action); break;
      case "action-claimed": {
        const action = state.actions.find(action => action.id === fact.actionId);
        if (!action || action.status !== "issued" || action.expectedStateRevision !== previous?.eventSequence) throw new Error("Invalid action claim");
        action.status = "claimed"; action.claimToolCallId = fact.claimToolCallId; action.claimedAt = fact.at;
        for (const recipient of action.recipients) { const work = state.work.find(work => work.id === recipient.workId && work.revision === recipient.workRevision && work.attempt.id === recipient.attemptId); if (!work || work.status !== "pending") throw new Error("Claim cannot start this work"); work.status = "running"; }
        break;
      }
      case "action-settled": {
        const action = state.actions.find(action => action.id === fact.actionId);
        if (!action || !["claimed", "running", "uncertain"].includes(action.status)) throw new Error("Invalid action settlement");
        if (action.input.kind === "cancel_runtime" && fact.result.kind === "success") {
          const observations = [...state.work.flatMap(work => work.runtimeOwners), ...state.pools.flatMap(pool => pool.owner ? [pool.owner] : [])];
          if (!action.input.owners.every(owner => observations.some(observed => runtimeIdentity(owner) === runtimeIdentity(observed) && observed.status === "observed-terminal"))) throw new Error("Cancellation action lacks terminal owner observations");
        }
        action.result = fact.result; action.status = fact.result.kind === "uncertain" ? "uncertain" : "settled";
        if (fact.result.kind === "success" && fact.result.output) state.gitOutcomes.push(fact.result.output);
        break;
      }
      case "receipt-recorded": {
        const action = state.actions.find(action => action.id === fact.actionId);
        if (!action || state.receiptDigests.some(receipt => receipt.id === fact.receiptId)) throw new Error("Invalid or duplicate receipt fact");
        action.receiptIds.push(fact.receiptId);
        state.receiptDigests.push({ id: fact.receiptId, digest: fact.receiptDigest, sequence: event.sequence }); break;
      }
      case "work-recorded": {
        const index = state.work.findIndex(work => work.id === fact.work.id && work.revision === fact.work.revision);
        if (index < 0) { if (fact.work.status !== "pending") throw new Error("New work must be pending"); state.work.push(fact.work); }
        else {
          const current = state.work[index];
          const allowed: Record<WorkItem["status"], WorkItem["status"][]> = { pending: ["pending", "cancelled", "awaiting-recovery"], running: ["running", "succeeded", "failed", "awaiting-output", "awaiting-recovery", "cancelled"], "awaiting-output": ["awaiting-output", "awaiting-recovery", "succeeded", "failed", "pending", "cancelled"], "awaiting-recovery": ["awaiting-recovery", "pending", "succeeded", "cancelled"], succeeded: ["succeeded"], failed: ["failed", "pending", "cancelled", "succeeded"], superseded: ["superseded"], cancelled: ["cancelled"] };
          if (!allowed[current.status].includes(fact.work.status)) throw new Error("Invalid work status transition");
          const assignment = ({ schemaVersion, attempt, status, runtimeOwners, completedAt, result, evidence, ...work }: WorkItem) => work;
          if (!same(assignment(current), assignment(fact.work))) throw new Error("Work assignment is immutable within a revision");
          if (terminalWork(current) && fact.work.status === current.status && !same({ ...current, runtimeOwners: fact.work.runtimeOwners, evidence: fact.work.evidence }, fact.work)) throw new Error("Terminal work result is immutable");
          const retry = current.status !== "pending" && fact.work.status === "pending";
          if ((retry || current.status === "failed" && fact.work.status !== "failed" || current.status === "awaiting-recovery" && fact.work.status === "succeeded") && !event.facts.some(fact => fact.kind === "approval-recorded" && fact.approval.kind === "recovery" && fact.approval.authority === "omp-tui")) throw new Error("Work disposition requires trusted recovery");
          if (fact.work.attempt.number !== current.attempt.number + (retry ? 1 : 0) || (!retry && !same(fact.work.attempt, current.attempt))) throw new Error("Invalid work attempt");
          if (fact.work.status === "succeeded" && (!fact.work.result || fact.work.result.workId !== current.id || fact.work.result.workRevision !== current.revision || fact.work.result.attemptId !== current.attempt.id || fact.work.runtimeOwners.some(owner => owner.status !== "observed-terminal"))) throw new Error("Unproven successful work");
          state.work[index] = fact.work;
        }
        break;
      }
      case "tool-recorded": {
        const index = state.tools.findIndex(tool => tool.name === fact.definition.name && tool.version === fact.definition.version);
        if (index < 0) {
          if (fact.definition.version !== Math.max(0, ...state.tools.filter(tool => tool.name === fact.definition.name).map(tool => tool.version)) + 1 || fact.definition.registration !== "proposed") throw new Error("Invalid new tool version");
          state.tools.push(fact.definition);
        } else {
          const previous = state.tools[index];
          if (previous.sourceHash !== fact.definition.sourceHash || previous.schemaHash !== fact.definition.schemaHash || previous.approvalScopeHash !== fact.definition.approvalScopeHash || !same(previous.grants, fact.definition.grants)) throw new Error("Tool scope is immutable within a version");
          if (previous.kernelGeneration !== fact.definition.kernelGeneration && !event.facts.some(fact => fact.kind === "approval-recorded" && fact.approval.kind === "recovery")) throw new Error("Tool recreation requires trusted recovery");
          state.tools[index] = fact.definition;
        }
        break;
      }
      case "kernel-observed":
        if (fact.generation !== state.kernelGeneration + 1) throw new Error("Invalid kernel generation");
        state.kernelGeneration = fact.generation;
        for (const tool of state.tools) if (tool.registration === "registered") tool.registration = "unavailable";
        break;
      case "review-round-recorded": { const index = state.reviewRounds.findIndex(round => round.round === fact.round.round); if (index < 0) state.reviewRounds.push(fact.round); else state.reviewRounds[index] = fact.round; break; }
      case "finding-recorded": {
        const index = state.findings.findIndex(finding => finding.id === fact.finding.id);
        if (index < 0) state.findings.push(fact.finding);
        else {
          const previous = state.findings[index], history = [...(previous.resolutionHistory ?? [])];
          if (previous.resolution && !same(previous.resolution, fact.finding.resolution)) history.push(previous.resolution);
          state.findings[index] = { ...fact.finding, ...(history.length ? { resolutionHistory: history } : {}) };
        }
        break;
      }
      case "verification-recorded": state.verification.push(fact.verification); break;
      case "verification-invalidated":
        for (const record of state.verification) if (fact.ids.includes(record.id)) { record.outcome = "unavailable"; if (fact.evidence) for (const ref of record.evidence) ref.availability = "unavailable"; }
        break;
      case "usage-sources-observed": state.usageSources = mergeUsageSources(state.usageSources, fact.sources); break;
      case "usage-coverage-observed": state.usageCoverage = mergeUsageCoverage(state, fact.coverage); break;
      case "usage-observed": if (!same(fact.usage, sourceUsage(state, state.usageSources, state.usageCoverage, event.at))) throw new Error("Usage totals differ from canonical source observations"); state.usage = fact.usage; break;
      case "runtime-observed":
        state.runtime = fact.snapshot;
        for (const work of state.work) work.runtimeOwners = work.runtimeOwners.map(owner => fact.snapshot.knownCompletedOwners.find(confirmed => confirmed.status === "observed-terminal" && runtimeIdentity(owner) === runtimeIdentity(confirmed)) ?? owner);
        for (const pool of state.pools) if (pool.owner) pool.owner = fact.snapshot.knownCompletedOwners.find(confirmed => confirmed.status === "observed-terminal" && runtimeIdentity(pool.owner!) === runtimeIdentity(confirmed)) ?? pool.owner;
        break;
      case "code-observed": state.baselineCode ??= fact.observation.identity; state.code = fact.observation; break;
      case "lifecycle-changed":
        if (state.lifecycle !== fact.from || fact.phase !== state.phase) throw new Error("Invalid lifecycle predecessor");
        if (fact.to === "completed") { const error = completionError(state); if (error) throw new Error(error); }
        if (fact.to === "cancelled" && (liveOwners(state).length || state.work.some(work => ["running", "awaiting-recovery"].includes(work.status)))) throw new Error("Cancellation has unresolved owners");
        state.lifecycle = fact.to;
        if (fact.recovery) state.recovery = fact.recovery; else delete state.recovery;
        if (["cancelling", "cancelled", "blocked", "paused"].includes(fact.to)) for (const action of state.actions) if (action.status === "issued") action.status = "superseded";
        break;
      case "phase-changed": {
        if (state.phase !== fact.from) throw new Error("Invalid phase predecessor");
        const error = phaseError(state, fact.to); if (error) throw new Error(error);
        state.phase = fact.to; break;
      }
      case "conclusion-recorded": { const error = completionError(state); if (error) throw new Error(error); state.conclusion = fact.conclusion; break; }
      case "boundary-violation-recorded": state.evidence.push(...fact.evidence); break;
    }
  }
  if (!state) throw new Error("Event did not create state");
  state.eventSequence = event.sequence; state.lastEventHash = event.hash; state.updatedAt = event.at;
  state.inputReceipts.push({ id: event.inputId, digest: event.inputDigest, sequence: event.sequence });
  for (const action of state.actions) if (action.status === "issued" && action.expectedStateRevision !== event.sequence) action.status = "superseded";
  assertSchema(RunRecordSchema, state, "projected state");
  return state;
}
