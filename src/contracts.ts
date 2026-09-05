import { createHash } from "node:crypto";
import * as Type from "@sinclair/typebox/type";
import type { Static, TProperties, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const tags = <const T extends readonly string[]>(...values: T) => Type.Union(values.map(value => Type.Literal(value as T[number])));
const text = Type.String({ maxLength: 16000 });
const strings = Type.Array(text);
export const SchemaVersion = Type.Literal(1);
export const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
export const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const SequenceSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const TimestampSchema = SequenceSchema;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const RunSlugSchema = Type.String({ pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" });
export const RelativePathSchema = Type.String({ minLength: 1, maxLength: 4096, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\)(?!.*[\\u0000-\\u001f]).+$" });
export const PhaseSchema = tags("preflight", "clarify", "research", "plan", "approval", "build", "review", "verify", "commit", "publish", "conclude");
export const LifecycleSchema = tags("active", "paused", "blocked", "cancelling", "cancelled", "completed");
export const MutationSchema = tags("read-only", "repository", "parent-access", "external", "unknown");
export const WorkKindSchema = tags("research", "plan", "critique", "synthesis", "build", "review", "judge", "fix", "verify", "correction");
export const EvidenceRefSchema = object({ id: IdSchema, kind: tags("artifact", "history", "file"), uri: text, digest: Type.Optional(DigestSchema), mediaType: text, summary: text, availability: tags("available", "unavailable", "unverified") });
const evidence = Type.Array(EvidenceRefSchema);
export const CodeIdentitySchema = object({ head: text, indexTree: text, worktreeDigest: DigestSchema, scopeDigest: DigestSchema, parentEffectDigest: DigestSchema });
export const WorkRefSchema = object({ id: IdSchema, revision: SequenceSchema, attemptId: IdSchema });
export const WorkDependencySchema = object({ id: IdSchema, revision: SequenceSchema });
export const ToolVersionRefSchema = object({ name: IdSchema, version: positive });
export const DiagnosticSchema = object({ code: IdSchema, message: text, path: Type.Optional(text), evidence, severity: tags("info", "warning", "error") });
export const ValidationIssueSchema = object({ code: IdSchema, path: text, message: text, evidence });
export const ValidationResultSchema = Type.Union([object({ valid: Type.Literal(true) }), object({ valid: Type.Literal(false), issues: Type.Array(ValidationIssueSchema) })]);
export const RunOwnerSchema = object({ sessionId: IdSchema, epoch: SequenceSchema, leaseId: IdSchema });
export const RepositoryRecordSchema = object({ root: text, gitDir: text, commonDir: text, initialHead: text, baselineRef: EvidenceRefSchema, baselineDigest: DigestSchema });
export const InvocationRecordSchema = object({ command: tags("supership", "shipit", "ultraship", "ultrashipit", "superreview"), mode: tags("interactive", "autonomous", "review-only"), topology: tags("normal", "crossreview", "duel", "debate"), intent: text, base: Type.Optional(text), outputBranch: Type.Optional(text), commitRequested: Type.Boolean(), pushRequested: Type.Boolean() });
export const SeatSourceRecordSchema = object({ agentName: IdSchema, kind: tags("project", "user", "extension", "bundled", "explicit"), path: text, contentHash: DigestSchema, bodyHash: DigestSchema, metadataHash: DigestSchema });
export const SeatBindingSchema = object({ seatId: IdSchema, baseAgent: IdSchema, alias: IdSchema, requestedModel: Type.Optional(text), resolvedModel: text, fallbackSeatIds: Type.Array(IdSchema), source: SeatSourceRecordSchema, bindingGeneration: SequenceSchema });
export const SeatRequestSchema = object({ seatId: IdSchema, agentName: IdSchema, model: Type.Optional(text), sourcePath: Type.Optional(text) });
export const LimitsSchema = object({ concurrency: Type.Optional(positive), tokens: Type.Optional(SequenceSchema), cost: Type.Optional(object({ amount: Type.Number({ minimum: 0 }), currency: Type.Literal("USD") })), wallMs: Type.Optional(SequenceSchema), reviewRounds: Type.Optional(positive) });
export const UsageSourceSchema = object({ id: IdSchema, complete: Type.Boolean(), tokens: SequenceSchema, costAmount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), model: IdSchema, observedAt: TimestampSchema });
// Coverage states whether the observer saw every managed message of an authorized execution; it never certifies provider billing.
export const UsageCoverageSchema = object({ id: IdSchema, actionId: IdSchema, work: Type.Array(WorkRefSchema, { minItems: 1 }), status: tags("unknown", "partial", "complete"), nativeSessionId: Type.Optional(IdSchema), reason: text, observedAt: TimestampSchema });
export const UsageRecordSchema = object({ tokens: SequenceSchema, cost: object({ amount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), pricedSubtotal: Type.Number({ minimum: 0 }), currency: IdSchema, unpricedModels: strings }), startedAt: TimestampSchema, observedAt: TimestampSchema, activeOwners: SequenceSchema, ompConcurrencyCeiling: Type.Union([positive, Type.Null()]), overshoot: object({ tokens: SequenceSchema, cost: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), wallMs: SequenceSchema }) });
export const IsolationDescriptorSchema = Type.Union([object({ kind: Type.Literal("active-checkout") }), object({ kind: Type.Literal("worktree"), base: CodeIdentitySchema, path: Type.Optional(text) })]);
export const WorkToolGrantSchema = object({ name: IdSchema, version: positive, approvalId: IdSchema });
export const OutputSchemaRefSchema = object({ name: tags("research", "plan", "critique", "build", "review", "judge", "verification"), version: SchemaVersion });
export const WorkContextSchema = Type.Union([
  object({ kind: Type.Literal("consultation"), gateId: IdSchema, phase: PhaseSchema, scopeHash: DigestSchema }),
  object({ kind: Type.Literal("planning"), stage: tags("shared-research", "blind-a", "blind-b", "critique-a", "critique-b", "revise-a", "revise-b", "synthesis", "review-refinement"), sharedEvidenceHash: DigestSchema }),
  object({ kind: Type.Literal("review"), round: positive, lens: IdSchema, codeIdentity: CodeIdentitySchema }),
  object({ kind: Type.Literal("judge"), round: positive, packetHash: DigestSchema, findingIds: Type.Array(IdSchema), codeIdentity: CodeIdentitySchema }),
  object({ kind: Type.Literal("fix"), round: positive, findingIds: Type.Array(IdSchema), codeIdentity: CodeIdentitySchema }),
  object({ kind: Type.Literal("correction"), original: WorkRefSchema, stage: tags("correction", "fallback"), outputRef: EvidenceRefSchema }),
]);
export const WorktreeOwnershipSchema = object({ schemaVersion: SchemaVersion, runId: IdSchema, path: text, actionId: IdSchema, work: WorkRefSchema, createdAt: TimestampSchema, evidence });
export const WorkAssignmentSchema = object({ context: Type.Optional(WorkContextSchema), id: IdSchema, revision: SequenceSchema, kind: WorkKindSchema, dependencies: Type.Array(WorkDependencySchema), seatId: IdSchema, expectedPaths: Type.Array(RelativePathSchema), expectedOutputs: strings, verificationCheckIds: Type.Array(IdSchema), mutation: MutationSchema, isolation: IsolationDescriptorSchema, toolGrants: Type.Array(WorkToolGrantSchema), outputSchema: OutputSchemaRefSchema, instructions: Type.String({ maxLength: 128000 }), evidence });
export const PlannedItemSchema = WorkAssignmentSchema;
export const WorkAttemptSchema = object({ id: IdSchema, number: positive, validationStage: tags("initial", "correction", "fallback"), seatId: IdSchema });
export const RuntimeOwnerSchema = object({ kind: tags("task", "agent", "completion", "pool", "pool-item"), id: IdSchema, parentId: Type.Optional(IdSchema), logicalKey: Type.Optional(IdSchema), actionId: IdSchema, workId: IdSchema, workRevision: SequenceSchema, attemptId: IdSchema, sessionId: IdSchema, ownerEpoch: SequenceSchema, status: tags("reported", "observed-running", "observed-terminal", "unknown"), observation: Type.Optional(EvidenceRefSchema) });
export const VerificationOperationSchema = Type.Union([
  object({ kind: Type.Literal("command"), command: Type.Array(text, { minItems: 1 }), cwd: text }),
  object({ kind: Type.Literal("browser-open"), name: IdSchema, url: text }),
  object({ kind: Type.Literal("browser-click"), name: IdSchema, selector: text }),
  object({ kind: Type.Literal("browser-fill"), name: IdSchema, selector: text, value: text }),
  object({ kind: Type.Literal("browser-assert-text"), name: IdSchema, text }),
  object({ kind: Type.Literal("browser-screenshot"), name: IdSchema }),
  object({ kind: Type.Literal("browser-close"), name: IdSchema }),
]);
export const ScenarioSchema = Type.Union([object({ kind: Type.Literal("command"), command: Type.Array(text, { minItems: 1 }), cwd: text }), object({ kind: Type.Literal("structured"), name: text, steps: Type.Array(text, { minItems: 1 }), operations: Type.Array(VerificationOperationSchema, { minItems: 1 }) })]);
export const VerificationCheckSchema = object({ id: IdSchema, description: text, scenario: ScenarioSchema, scopePaths: Type.Array(RelativePathSchema), required: Type.Boolean(), source: evidence });
export const PlanScopeSchema = object({ included: strings, excluded: strings, paths: Type.Array(RelativePathSchema), effects: strings, publicContracts: strings, dependencies: strings });
export const RiskRecordSchema = object({ id: IdSchema, kind: tags("security", "data", "performance", "ui", "correctness", "other"), description: text, paths: Type.Array(RelativePathSchema), requiredLenses: strings, verificationCheckIds: Type.Array(IdSchema), evidence });
export const CommitGroupSchema = object({ id: IdSchema, title: text, workIds: Type.Array(IdSchema), paths: Type.Array(RelativePathSchema), dependencies: Type.Array(IdSchema) });
export const EffectDeclarationSchema = object({ kind: MutationSchema, paths: Type.Array(RelativePathSchema), description: text });
// Schema documents are the only extensible JSON objects. They are inert data, not state patches.
export const JsonSchemaObjectSchema = Type.Record(Type.String(), Type.Unknown());
export const ToolProposalSchema = object({ schemaVersion: SchemaVersion, name: IdSchema, description: text, purpose: text, source: text, parameters: JsonSchemaObjectSchema, initialization: Type.Array(object({ name: IdSchema, ref: EvidenceRefSchema })), effects: EffectDeclarationSchema, intendedUsers: Type.Array(IdSchema), recreation: tags("recreatable", "requires-reproposal") });
export const CapturedToolProposalSchema = object({ schemaVersion: SchemaVersion, name: IdSchema, description: text, purpose: text, sourceRef: EvidenceRefSchema, sourceHash: DigestSchema, parameters: JsonSchemaObjectSchema, schemaHash: DigestSchema, initialization: Type.Array(object({ name: IdSchema, ref: EvidenceRefSchema })), effects: EffectDeclarationSchema, intendedUsers: Type.Array(IdSchema), recreation: tags("recreatable", "requires-reproposal") });
export const ToolGrantSchema = object({ workId: IdSchema, workRevision: SequenceSchema, seatId: IdSchema });
export const ToolDefinitionRecordSchema = object({ ...CapturedToolProposalSchema.properties, version: positive, grants: Type.Array(ToolGrantSchema), approvalId: Type.Optional(IdSchema), approvalScopeHash: DigestSchema, parent: object({ cwd: text, sessionId: IdSchema, ownerEpoch: SequenceSchema }), kernelGeneration: SequenceSchema, registration: tags("proposed", "approved", "registered", "unavailable", "retired"), runtimeName: Type.Optional(IdSchema), evidence });
export const PlanRecordSchema = object({ schemaVersion: SchemaVersion, revision: SequenceSchema, title: text, objective: text, scope: PlanScopeSchema, evidence, items: Type.Array(PlannedItemSchema), risks: Type.Array(RiskRecordSchema), requiredLenses: strings, verificationChecks: Type.Array(VerificationCheckSchema), commitGroups: Type.Array(CommitGroupSchema), toolProposals: Type.Array(CapturedToolProposalSchema), fastPath: Type.Optional(object({ reason: text, workerId: IdSchema })), noChangeReason: Type.Optional(text) });
export const PlanAmendmentSchema = object({ schemaVersion: SchemaVersion, baseRevision: SequenceSchema, proposedPlan: PlanRecordSchema, reason: text, evidence });
export const ApprovalRecordSchema = object({ id: IdSchema, kind: tags("initial-plan", "material-amendment", "fast-path", "tool", "recovery", "safety", "judge-disagreement", "stall-override", "push", "cleanup"), decision: tags("approve", "decline", "adopt", "retry", "discard", "stop"), authority: tags("omp-tui", "cli-terminal", "autonomous-policy"), scopeHash: DigestSchema, planRevision: SequenceSchema, toolVersions: Type.Array(ToolVersionRefSchema), ownerEpoch: SequenceSchema, createdAt: TimestampSchema, rationale: text, evidence });
export const RecoveryRecordSchema = object({ scope: tags("run", "items"), intent: tags("resume", "cancel"), primaryReason: text, triggers: strings, affectedWork: Type.Array(WorkDependencySchema), unresolvedOwners: Type.Array(RuntimeOwnerSchema), resumePhase: PhaseSchema, requiredChoices: strings, evidence });
export const InstructionRecordSchema = object({ id: IdSchema, receivedAt: TimestampSchema, textRef: EvidenceRefSchema, summary: text, affectedWork: Type.Array(WorkDependencySchema), classification: tags("ordinary", "material", "safety"), status: tags("recorded", "pending-boundary", "applied"), evidence });
export const FindingVerdictSchema = object({ judgeId: IdSchema, round: positive, verdict: tags("accepted", "rejected", "deferred", "duplicate"), reason: text, duplicateOf: Type.Optional(IdSchema), evidence });
export const FindingResolutionSchema = object({ kind: tags("fixed", "explicitly-deferred", "rejected", "duplicate"), reason: text, codeIdentity: CodeIdentitySchema, evidence });
export const FindingRecordSchema = object({ schemaVersion: SchemaVersion, id: IdSchema, fingerprint: DigestSchema, lens: text, location: object({ path: RelativePathSchema, startLine: Type.Optional(positive), endLine: Type.Optional(positive), symbol: Type.Optional(text) }), condition: text, claim: text, impact: text, severity: tags("critical", "high", "medium", "low"), evidence, fixTarget: object({ workId: Type.Optional(IdSchema), path: RelativePathSchema, description: text }), verdicts: Type.Array(FindingVerdictSchema), resolution: Type.Optional(FindingResolutionSchema), resolutionHistory: Type.Optional(Type.Array(FindingResolutionSchema)) });
export const ReviewRoundRecordSchema = object({ reviewSeatIds: Type.Optional(Type.Array(IdSchema)), override: Type.Optional(object({ approvalId: IdSchema, seatIds: Type.Array(IdSchema), rationale: text })), round: positive, startedAt: TimestampSchema, completedAt: Type.Optional(TimestampSchema), codeIdentity: CodeIdentitySchema, lenses: strings, reviewerOwners: Type.Array(RuntimeOwnerSchema), judgeOwners: Type.Array(RuntimeOwnerSchema), priorEvidencePacket: EvidenceRefSchema, unresolvedFingerprints: Type.Array(DigestSchema), relevantCodeDigest: DigestSchema, verdictEvidence: evidence });
export const VerificationRecordSchema = object({ schemaVersion: SchemaVersion, id: IdSchema, checkId: IdSchema, scenario: ScenarioSchema, codeIdentity: CodeIdentitySchema, scopePaths: Type.Array(RelativePathSchema), startedAt: TimestampSchema, endedAt: TimestampSchema, outcome: tags("passed", "failed", "unavailable", "cancelled"), exitCode: Type.Optional(Type.Integer()), evidence, verifier: object({ kind: tags("runtime", "agent"), id: IdSchema }), actionId: IdSchema });
export const ConclusionRecordSchema = object({ kind: tags("changed", "no-change"), summary: text, evidence, lessons: strings, unresolvedDeferredFindingIds: Type.Array(IdSchema), completedAt: TimestampSchema });
export const PolicyGateSchema = object({ id: IdSchema, phases: Type.Array(PhaseSchema), paths: Type.Array(RelativePathSchema), requirement: Type.Union([object({ kind: Type.Literal("approval"), approvalKind: ApprovalRecordSchema.properties.kind }), object({ kind: Type.Literal("verification"), checkIds: Type.Array(IdSchema) }), object({ kind: Type.Literal("consultation"), seatId: IdSchema, before: text }), object({ kind: Type.Literal("dependency"), prerequisiteIds: Type.Array(IdSchema) }), object({ kind: Type.Literal("restriction"), rule: text })]), evidence });
export const PathRoutingRuleSchema = object({ id: IdSchema, paths: Type.Array(RelativePathSchema), seatId: IdSchema, reason: text, evidence });
export const VerificationRequirementSchema = object({ id: IdSchema, description: text, scopePaths: Type.Array(RelativePathSchema), instructions: text, source: evidence });
export const PolicyOverlaySchema = object({ requiredVerification: Type.Optional(Type.Array(VerificationRequirementSchema)), schemaVersion: SchemaVersion, seats: Type.Array(SeatRequestSchema), namedFallbackSeats: Type.Array(object({ seatId: IdSchema, fallbackSeatIds: Type.Array(IdSchema) })), limits: LimitsSchema, requiredLenses: strings, verificationChecks: Type.Array(VerificationCheckSchema), phaseGates: Type.Array(PolicyGateSchema), pathRouting: Type.Array(PathRoutingRuleSchema), instructionRefs: evidence });
export const PreflightEvidenceSchema = object({ schemaVersion: SchemaVersion, observedVersion: text, checks: Type.Array(object({ name: IdSchema, passed: Type.Boolean(), expected: text, observed: text, evidence }), { minItems: 1 }), repository: RepositoryRecordSchema, planMode: Type.Literal(false), ownerAvailable: Type.Literal(true), ignoreVerified: Type.Literal(true), seats: Type.Array(SeatBindingSchema) });
export const StartRecordSchema = object({ clarificationCompleted: Type.Optional(Type.Boolean()), schemaVersion: SchemaVersion, runId: IdSchema, slug: RunSlugSchema, owner: RunOwnerSchema, repository: RepositoryRecordSchema, invocation: InvocationRecordSchema, seats: Type.Array(SeatBindingSchema), limits: LimitsSchema, policy: PolicyOverlaySchema, preflight: PreflightEvidenceSchema });
const outputBase = { schemaVersion: SchemaVersion, workId: IdSchema, workRevision: SequenceSchema, attemptId: IdSchema, proposedTools: Type.Optional(Type.Array(CapturedToolProposalSchema)) };
export const ResearchOutputSchema = object({ ...outputBase, kind: Type.Literal("research"), answers: Type.Array(object({ question: text, answer: text, citations: evidence })), gaps: Type.Array(object({ question: text, reason: text })), proposedPaths: Type.Array(RelativePathSchema) });
export const PlanOutputSchema = object({ ...outputBase, kind: Type.Literal("plan"), plan: PlanRecordSchema });
export const CritiqueOutputSchema = object({ ...outputBase, kind: Type.Literal("critique"), targetPlanIds: Type.Array(IdSchema), issues: Type.Array(object({ id: IdSchema, claim: text, impact: text, fixTarget: text, evidence })), retainedDecisions: strings });
export const BuildOutputSchema = object({ ...outputBase, kind: Type.Literal("build"), outcome: tags("changed", "no-change", "failed"), summary: text, changes: Type.Array(object({ path: RelativePathSchema, description: text })), verificationClaims: Type.Array(object({ checkId: IdSchema, outcome: tags("passed", "failed", "unavailable"), evidence })), evidence, proposedTools: Type.Array(CapturedToolProposalSchema), proposedAmendment: Type.Optional(PlanAmendmentSchema) });
export const ReviewOutputSchema = object({ ...outputBase, kind: Type.Literal("review"), round: positive, lens: text, reviewedCodeIdentity: CodeIdentitySchema, findings: Type.Array(FindingRecordSchema), evidence });
export const JudgeOutputSchema = object({ ...outputBase, kind: Type.Literal("judge"), round: positive, judgeSeatId: IdSchema, reviewPacketHash: DigestSchema, verdicts: Type.Array(object({ findingId: IdSchema, verdict: FindingVerdictSchema.properties.verdict, reason: text, evidence, duplicateOf: Type.Optional(IdSchema) })) });
export const VerificationOutputSchema = object({ ...outputBase, kind: Type.Literal("verification"), checks: Type.Array(object({ checkId: IdSchema, claimedOutcome: tags("passed", "failed", "unavailable"), evidence })), summary: text });
export const WorkerOutputSchema = Type.Union([ResearchOutputSchema, PlanOutputSchema, CritiqueOutputSchema, BuildOutputSchema, ReviewOutputSchema, JudgeOutputSchema, VerificationOutputSchema]);
export const WorkItemSchema = object({ schemaVersion: SchemaVersion, ...WorkAssignmentSchema.properties, attempt: WorkAttemptSchema, status: tags("pending", "running", "awaiting-output", "awaiting-recovery", "succeeded", "failed", "superseded", "cancelled"), runtimeOwners: Type.Array(RuntimeOwnerSchema), completedAt: Type.Optional(TimestampSchema), result: Type.Optional(WorkerOutputSchema) });
export const ActionRecipientSchema = object({ workId: IdSchema, workRevision: SequenceSchema, attemptId: IdSchema, seatId: IdSchema, toolVersions: Type.Array(ToolVersionRefSchema) });
export const ActionInputSchema = Type.Union([
  object({ kind: Type.Literal("collect_input"), request: object({ approvalKind: Type.Optional(ApprovalRecordSchema.properties.kind), kind: tags("clarification", "approval", "recovery"), id: IdSchema, prompt: text, choices: strings }), scopeHash: DigestSchema }),
  object({ kind: Type.Literal("run_finite"), scheduler: tags("task", "agent"), work: Type.Array(WorkRefSchema, { minItems: 1 }), assignments: Type.Array(WorkAssignmentSchema, { minItems: 1 }) }),
  object({ kind: Type.Literal("pool_create"), poolId: IdSchema, lens: text, round: positive, seatId: IdSchema, contextRef: EvidenceRefSchema, contextHash: DigestSchema, toolGrants: Type.Array(WorkToolGrantSchema) }),
  object({ kind: Type.Literal("pool_push"), poolId: IdSchema, items: Type.Array(object({ logicalId: IdSchema, work: WorkRefSchema, assignment: WorkAssignmentSchema }), { minItems: 1 }) }),
  object({ kind: Type.Literal("wait"), owners: Type.Array(RuntimeOwnerSchema, { minItems: 1 }) }),
  object({ kind: Type.Literal("pool_close"), poolId: IdSchema, reason: text }),
  object({ kind: Type.Literal("cancel_runtime"), owners: Type.Array(RuntimeOwnerSchema, { minItems: 1 }), reason: text }),
  object({ kind: Type.Literal("register_tool"), toolName: IdSchema, toolVersion: positive, approvalId: IdSchema, approvalScopeHash: DigestSchema, sourceHash: DigestSchema, schemaHash: DigestSchema, generation: SequenceSchema }),
  object({ kind: Type.Literal("retire_tool"), toolName: IdSchema, toolVersion: positive, generation: SequenceSchema }),
  object({ kind: Type.Literal("observe_git"), scopePaths: Type.Array(RelativePathSchema), purpose: text }),
  object({ kind: Type.Literal("integrate"), work: WorkRefSchema, patchRef: EvidenceRefSchema, expectedBefore: CodeIdentitySchema, overlapEvidence: evidence }),
  object({ kind: Type.Literal("verify"), check: VerificationCheckSchema, expectedCode: CodeIdentitySchema }),
  object({ kind: Type.Literal("create_branch"), branch: text, expectedCode: CodeIdentitySchema }),
  object({ kind: Type.Literal("commit"), group: CommitGroupSchema, expectedCode: CodeIdentitySchema, approvalId: Type.Optional(IdSchema) }),
  object({ kind: Type.Literal("prepare_push"), commits: Type.Array(text, { minItems: 1 }), expectedCode: CodeIdentitySchema }),
  object({ kind: Type.Literal("push"), remote: text, branch: text, commits: Type.Array(text, { minItems: 1 }), approvalId: IdSchema, approvalScopeHash: DigestSchema }),
  object({ kind: Type.Literal("conclude"), conclusion: ConclusionRecordSchema }),
]);
export const WorkPatchSchema = object({ schemaVersion: SchemaVersion, work: WorkRefSchema, actionId: IdSchema, patchRef: EvidenceRefSchema, before: CodeIdentitySchema, changedPaths: Type.Array(RelativePathSchema), ownershipEvidence: evidence });
export const GitOperationResultSchema = object({ kind: Type.Literal("git"), operation: tags("create_branch", "integrate", "commit", "push"), before: CodeIdentitySchema, after: CodeIdentitySchema, branch: text, commits: strings, remote: Type.Optional(text), work: Type.Optional(WorkRefSchema), groupId: Type.Optional(IdSchema), groupIds: Type.Optional(Type.Array(IdSchema)), ownershipEvidence: evidence });
export const PushTargetSchema = object({ remote: text, url: text, branch: text, commits: Type.Array(text, { minItems: 1 }), codeIdentity: CodeIdentitySchema, scopeHash: DigestSchema });
export const PoolRecordSchema = object({ schemaVersion: SchemaVersion, id: IdSchema, lens: IdSchema, round: positive, seatId: IdSchema, contextRef: EvidenceRefSchema, contextHash: DigestSchema, toolGrants: Type.Array(WorkToolGrantSchema), status: tags("pending", "running", "closing", "closed", "lost"), owner: Type.Optional(RuntimeOwnerSchema), items: Type.Array(object({ logicalId: IdSchema, work: WorkRefSchema, key: Type.Optional(IdSchema) })) });
export const ToolInvocationRecordSchema = object({ schemaVersion: SchemaVersion, id: IdSchema, name: IdSchema, version: positive, kernelGeneration: SequenceSchema, caller: WorkRefSchema, actionId: IdSchema, parentBefore: CodeIdentitySchema, parentAfter: Type.Optional(CodeIdentitySchema), outcome: tags("running", "success", "failed", "uncertain"), evidence });
export const ActionResultSchema = Type.Union([object({ kind: Type.Literal("success"), evidence, output: Type.Optional(GitOperationResultSchema) }), object({ kind: Type.Literal("failure"), diagnostic: DiagnosticSchema, evidence }), object({ kind: Type.Literal("uncertain"), reason: text, unresolvedOwners: Type.Array(RuntimeOwnerSchema), evidence })]);
export const ActionDraftSchema = object({ input: ActionInputSchema, recipients: Type.Array(ActionRecipientSchema), planRevision: SequenceSchema, kernelGeneration: Type.Optional(SequenceSchema) });
export const ActionRecordSchema = object({ schemaVersion: SchemaVersion, id: IdSchema, runId: IdSchema, ownerEpoch: SequenceSchema, expectedStateRevision: SequenceSchema, ...ActionDraftSchema.properties, inputHash: DigestSchema, programHash: Type.Optional(DigestSchema), status: tags("issued", "claimed", "running", "settled", "uncertain", "superseded"), issuedAt: TimestampSchema, claimedAt: Type.Optional(TimestampSchema), claimToolCallId: Type.Optional(IdSchema), receiptIds: Type.Array(IdSchema), result: Type.Optional(ActionResultSchema) });
const receiptBase = { schemaVersion: SchemaVersion, receiptId: IdSchema, runId: IdSchema, ownerEpoch: SequenceSchema, actionId: IdSchema, inputHash: DigestSchema, planRevision: SequenceSchema, evidence };
export const ReceiptSchema = Type.Union([
  object({ ...receiptBase, kind: Type.Literal("created"), work: Type.Optional(WorkRefSchema), kernelGeneration: Type.Optional(SequenceSchema), owner: RuntimeOwnerSchema, worktree: Type.Optional(WorktreeOwnershipSchema) }),
  object({ ...receiptBase, kind: Type.Literal("completed"), work: WorkRefSchema, owner: RuntimeOwnerSchema, output: WorkerOutputSchema }),
  object({ ...receiptBase, kind: Type.Literal("failed"), work: Type.Optional(WorkRefSchema), owner: Type.Optional(RuntimeOwnerSchema), diagnostic: DiagnosticSchema, effectEvidence: evidence }),
  object({ ...receiptBase, kind: Type.Literal("cancel-requested"), owners: Type.Array(RuntimeOwnerSchema), requestEvidence: evidence }),
  object({ ...receiptBase, kind: Type.Literal("cancel-confirmed"), owners: Type.Array(RuntimeOwnerSchema), settlementEvidence: evidence }),
  object({ ...receiptBase, kind: Type.Literal("pool-closed"), poolId: IdSchema, queuedKeysCancelled: Type.Array(IdSchema), runningOwners: Type.Array(RuntimeOwnerSchema) }),
  object({ ...receiptBase, kind: Type.Literal("tool-registered"), name: IdSchema, version: positive, kernelGeneration: SequenceSchema, runtimeName: IdSchema, sourceHash: DigestSchema, schemaHash: DigestSchema }),
  object({ ...receiptBase, kind: Type.Literal("tool-called"), invocationId: IdSchema, name: IdSchema, version: positive, kernelGeneration: SequenceSchema, caller: WorkRefSchema, parentBefore: CodeIdentitySchema }),
  object({ ...receiptBase, kind: Type.Literal("tool-returned"), invocationId: IdSchema, name: IdSchema, version: positive, kernelGeneration: SequenceSchema, outcome: tags("success", "failed", "uncertain"), parentAfter: CodeIdentitySchema, parentEffectEvidence: evidence }),
  object({ ...receiptBase, kind: Type.Literal("workspace-called"), invocationId: IdSchema, caller: WorkRefSchema, parentBefore: CodeIdentitySchema, manifestDigest: DigestSchema }),
  object({ ...receiptBase, kind: Type.Literal("workspace-returned"), invocationId: IdSchema, parentAfter: CodeIdentitySchema, outcome: tags("success", "failed", "uncertain"), parentEffectEvidence: evidence }),
]);
export const ReceiptObservationSchema = object({ settledOwners: Type.Optional(Type.Array(RuntimeOwnerSchema)), kind: tags("reported", "runtime-confirmed", "unconfirmed"), toolCallId: IdSchema, verifiedProgramHash: Type.Optional(DigestSchema), evidence });
export const SchedulingSnapshotSchema = object({ ompCeiling: Type.Union([positive, Type.Null()]), activeOwners: Type.Array(RuntimeOwnerSchema), knownCompletedOwners: Type.Array(RuntimeOwnerSchema), unknownOwners: Type.Array(RuntimeOwnerSchema), observedAt: TimestampSchema });
export const RecoveryChoiceSchema = object({ kind: tags("adopt", "retry", "discard", "stop", "recreate-tool", "reproposal", "continue", "replan"), adoptions: Type.Optional(Type.Array(object({ work: WorkRefSchema, output: WorkerOutputSchema, effectEvidence: evidence }))), toolProposals: Type.Optional(Type.Array(CapturedToolProposalSchema)), toolResults: Type.Optional(Type.Array(object({ id: IdSchema, outcome: tags("success", "failed"), parentAfter: CodeIdentitySchema, evidence }))), affectedWork: Type.Array(WorkDependencySchema), reason: text });
export const ReconciliationSchema = object({ confirmed: Type.Array(RuntimeOwnerSchema), unresolved: Type.Array(RuntimeOwnerSchema), candidateResults: evidence, requiredChoices: Type.Array(RecoveryChoiceSchema) });
export const CodeObservationSchema = object({ identity: CodeIdentitySchema, paths: Type.Array(object({ path: RelativePathSchema, baselineDigest: Type.Optional(DigestSchema), currentDigest: Type.Optional(DigestSchema), kind: tags("tracked", "untracked", "deleted", "symlink"), staged: Type.Boolean() })), evidence, observedAt: TimestampSchema });
export const RecoveryEvidenceSchema = object({ writerExclusive: Type.Boolean(), runtime: ReconciliationSchema, git: CodeObservationSchema, evidence });
export const InputReceiptSchema = object({ id: IdSchema, digest: DigestSchema, sequence: positive });
export const ReceiptDigestSchema = object({ id: IdSchema, digest: DigestSchema, sequence: positive });
export const RetainedResultSchema = object({ work: WorkRefSchema, actionId: IdSchema, outputRef: EvidenceRefSchema, reason: tags("superseded", "recovery"), evidence });
export const RunRecordSchema = object({ usageSources: Type.Array(UsageSourceSchema), usageCoverage: Type.Array(UsageCoverageSchema), retainedResults: Type.Optional(Type.Array(RetainedResultSchema)), patches: Type.Array(WorkPatchSchema), planChange: Type.Optional(object({ classification: tags("ordinary", "material", "safety"), approvedScopeHash: Type.Optional(DigestSchema) })), clarificationCompleted: Type.Optional(Type.Boolean()), baselineCode: Type.Optional(CodeIdentitySchema), pools: Type.Array(PoolRecordSchema), toolInvocations: Type.Array(ToolInvocationRecordSchema), worktrees: Type.Array(WorktreeOwnershipSchema), gitOutcomes: Type.Array(GitOperationResultSchema), pushTarget: Type.Optional(PushTargetSchema), schemaVersion: SchemaVersion, runId: IdSchema, slug: RunSlugSchema, owner: RunOwnerSchema, repository: RepositoryRecordSchema, invocation: InvocationRecordSchema, policy: PolicyOverlaySchema, phase: PhaseSchema, lifecycle: LifecycleSchema, planRevision: SequenceSchema, eventSequence: SequenceSchema, lastEventHash: DigestSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema, seats: Type.Array(SeatBindingSchema), limits: LimitsSchema, usage: UsageRecordSchema, plan: Type.Optional(PlanRecordSchema), work: Type.Array(WorkItemSchema), actions: Type.Array(ActionRecordSchema), tools: Type.Array(ToolDefinitionRecordSchema), approvals: Type.Array(ApprovalRecordSchema), findings: Type.Array(FindingRecordSchema), reviewRounds: Type.Array(ReviewRoundRecordSchema), verification: Type.Array(VerificationRecordSchema), instructions: Type.Array(InstructionRecordSchema), evidence, kernelGeneration: SequenceSchema, recovery: Type.Optional(RecoveryRecordSchema), conclusion: Type.Optional(ConclusionRecordSchema), inputReceipts: Type.Array(InputReceiptSchema), receiptDigests: Type.Array(ReceiptDigestSchema), code: Type.Optional(CodeObservationSchema), runtime: Type.Optional(SchedulingSnapshotSchema) });
export const FactSchema = Type.Union([
  object({ kind: Type.Literal("output-retained"), result: RetainedResultSchema }),
  object({ kind: Type.Literal("patch-recorded"), patch: WorkPatchSchema }),
  object({ kind: Type.Literal("seat-bindings-recorded"), seats: Type.Array(SeatBindingSchema), evidence }),
  object({ kind: Type.Literal("pool-recorded"), pool: PoolRecordSchema }),
  object({ kind: Type.Literal("tool-invocation-recorded"), invocation: ToolInvocationRecordSchema }),
  object({ kind: Type.Literal("worktree-recorded"), worktree: WorktreeOwnershipSchema }),
  object({ kind: Type.Literal("limits-configured"), limits: LimitsSchema }),
  object({ kind: Type.Literal("clarification-completed"), evidence }),
  object({ kind: Type.Literal("instructions-applied"), ids: Type.Array(IdSchema) }),
  object({ kind: Type.Literal("push-target-recorded"), target: PushTargetSchema }),
  object({ kind: Type.Literal("storage-recovered"), preserved: evidence, reason: text }),
  object({ kind: Type.Literal("run-created"), start: StartRecordSchema }),
  object({ kind: Type.Literal("owner-claimed"), owner: RunOwnerSchema, previousEpoch: SequenceSchema, reconciliation: evidence }),
  object({ kind: Type.Literal("instruction-recorded"), instruction: InstructionRecordSchema }),
  object({ kind: Type.Literal("plan-recorded"), plan: PlanRecordSchema, classification: tags("ordinary", "material", "safety"), affectedWork: Type.Array(WorkDependencySchema) }),
  object({ kind: Type.Literal("approval-recorded"), approval: ApprovalRecordSchema }),
  object({ kind: Type.Literal("action-issued"), action: ActionRecordSchema }),
  object({ kind: Type.Literal("action-claimed"), actionId: IdSchema, claimToolCallId: IdSchema, at: TimestampSchema }),
  object({ kind: Type.Literal("action-settled"), actionId: IdSchema, result: ActionResultSchema }),
  object({ kind: Type.Literal("receipt-recorded"), receiptId: IdSchema, receiptDigest: DigestSchema, actionId: IdSchema, receiptKind: tags("created", "completed", "failed", "cancel-requested", "cancel-confirmed", "pool-closed", "tool-registered", "tool-called", "tool-returned", "workspace-called", "workspace-returned"), verification: ReceiptObservationSchema.properties.kind, evidence }),
  object({ kind: Type.Literal("work-recorded"), work: WorkItemSchema }),
  object({ kind: Type.Literal("tool-recorded"), definition: ToolDefinitionRecordSchema }),
  object({ kind: Type.Literal("kernel-observed"), generation: SequenceSchema, reason: text, evidence }),
  object({ kind: Type.Literal("review-round-recorded"), round: ReviewRoundRecordSchema }),
  object({ kind: Type.Literal("finding-recorded"), finding: FindingRecordSchema }),
  object({ kind: Type.Literal("verification-recorded"), verification: VerificationRecordSchema }),
  object({ kind: Type.Literal("verification-invalidated"), ids: Type.Array(IdSchema), reason: text, codeIdentity: CodeIdentitySchema, evidence: Type.Optional(evidence) }),
  object({ kind: Type.Literal("usage-sources-observed"), sources: Type.Array(UsageSourceSchema) }),
  object({ kind: Type.Literal("usage-coverage-observed"), coverage: Type.Array(UsageCoverageSchema) }),
  object({ kind: Type.Literal("usage-observed"), usage: UsageRecordSchema }),
  object({ kind: Type.Literal("runtime-observed"), snapshot: SchedulingSnapshotSchema }),
  object({ kind: Type.Literal("code-observed"), observation: CodeObservationSchema }),
  object({ kind: Type.Literal("lifecycle-changed"), from: LifecycleSchema, to: LifecycleSchema, phase: PhaseSchema, recovery: Type.Optional(RecoveryRecordSchema) }),
  object({ kind: Type.Literal("phase-changed"), from: PhaseSchema, to: PhaseSchema, reason: text, evidence }),
  object({ kind: Type.Literal("conclusion-recorded"), conclusion: ConclusionRecordSchema }),
  object({ kind: Type.Literal("boundary-violation-recorded"), inputId: IdSchema, reason: text, evidence }),
]);
export const RunEventSchema = object({ schemaVersion: SchemaVersion, runId: IdSchema, sequence: positive, previousHash: DigestSchema, hash: DigestSchema, ownerEpoch: SequenceSchema, inputId: IdSchema, inputDigest: DigestSchema, at: TimestampSchema, facts: Type.Array(FactSchema, { minItems: 1 }) });
export const StartInputSchema = object({ kind: Type.Literal("start"), start: StartRecordSchema });
export const EngineInputSchema = Type.Union([
  object({ kind: Type.Literal("repair-seat-bindings"), seats: Type.Array(SeatBindingSchema), approval: ApprovalRecordSchema, evidence }),
  object({ kind: Type.Literal("record-patch"), patch: WorkPatchSchema, observation: ReceiptObservationSchema }),
  object({ kind: Type.Literal("record-seat-bindings"), seats: Type.Array(SeatBindingSchema), evidence }),
  object({ kind: Type.Literal("advance") }),
  object({ kind: Type.Literal("resolve-input"), actionId: IdSchema, answer: text, evidence, limits: Type.Optional(LimitsSchema) }),
  object({ kind: Type.Literal("configure-limits"), limits: LimitsSchema, rationale: text }),
  object({ kind: Type.Literal("record-worktree"), worktree: WorktreeOwnershipSchema, observation: ReceiptObservationSchema }),
  object({ kind: Type.Literal("record-push-target"), actionId: IdSchema, target: PushTargetSchema }),
  object({ kind: Type.Literal("record-storage-recovery"), preserved: evidence, reason: text }),
  object({ kind: Type.Literal("resolve-judges"), round: positive, decisions: JudgeOutputSchema.properties.verdicts, approval: ApprovalRecordSchema }),
  object({ kind: Type.Literal("override-stall"), approval: ApprovalRecordSchema, newSeatIds: Type.Array(IdSchema) }),
  StartInputSchema,
  object({ kind: Type.Literal("record-instruction"), instruction: InstructionRecordSchema }),
  object({ kind: Type.Literal("record-plan"), plan: PlanRecordSchema, sourceWork: Type.Optional(WorkRefSchema) }),
  object({ kind: Type.Literal("record-trusted-approval"), approval: ApprovalRecordSchema }),
  object({ kind: Type.Literal("issue-action"), draft: ActionDraftSchema, programHash: Type.Optional(DigestSchema) }),
  object({ kind: Type.Literal("claim-action"), actionId: IdSchema, expectedStateRevision: SequenceSchema, toolCallId: IdSchema, inputHash: DigestSchema, programHash: Type.Optional(DigestSchema) }),
  object({ kind: Type.Literal("observe-receipt"), receipt: ReceiptSchema, observation: ReceiptObservationSchema }),
  object({ kind: Type.Literal("record-invalid-output"), work: WorkRefSchema, actionId: IdSchema, outputRef: EvidenceRefSchema, issues: Type.Array(ValidationIssueSchema), observation: ReceiptObservationSchema }),
  object({ kind: Type.Literal("record-runtime-snapshot"), snapshot: SchedulingSnapshotSchema }),
  object({ kind: Type.Literal("record-git-observation"), observation: CodeObservationSchema }),
  object({ kind: Type.Literal("record-verification"), verification: VerificationRecordSchema }),
  object({ kind: Type.Literal("invalidate-verification"), ids: Type.Array(IdSchema, { minItems: 1 }), reason: text, evidence }),
  object({ kind: Type.Literal("record-source-usage"), sources: Type.Array(UsageSourceSchema), coverage: Type.Optional(Type.Array(UsageCoverageSchema)) }),
  object({ kind: Type.Literal("request-pause"), recovery: RecoveryRecordSchema }),
  object({ kind: Type.Literal("request-cancel"), reason: text, evidence }),
  object({ kind: Type.Literal("resume"), sessionId: IdSchema, leaseId: IdSchema, reconciliation: ReconciliationSchema }),
  object({ kind: Type.Literal("resolve-recovery"), choice: RecoveryChoiceSchema, approval: ApprovalRecordSchema, evidence: RecoveryEvidenceSchema }),
  object({ kind: Type.Literal("record-kernel-generation"), generation: SequenceSchema, reason: text, evidence }),
  object({ kind: Type.Literal("record-tool"), definition: ToolDefinitionRecordSchema }),
  object({ kind: Type.Literal("record-work"), assignment: WorkAssignmentSchema }),
  object({ kind: Type.Literal("record-review-round"), round: ReviewRoundRecordSchema }),
  object({ kind: Type.Literal("record-finding"), finding: FindingRecordSchema }),
  object({ kind: Type.Literal("advance-phase"), phase: PhaseSchema, reason: text, evidence }),
  object({ kind: Type.Literal("settle-action"), actionId: IdSchema, result: ActionResultSchema }),
  object({ kind: Type.Literal("conclude"), conclusion: ConclusionRecordSchema }),
]);
export const DecisionContextSchema = object({ now: TimestampSchema, inputId: IdSchema, ownerSessionId: IdSchema, ownerEpoch: SequenceSchema });
export const DecisionSchema = Type.Union([object({ kind: Type.Literal("append"), facts: Type.Array(FactSchema, { minItems: 1 }) }), object({ kind: Type.Literal("duplicate"), eventSequence: SequenceSchema }), object({ kind: Type.Literal("reject"), code: IdSchema, message: text, evidence })]);
export const LoadedRunSchema = object({ state: RunRecordSchema, diagnostics: Type.Array(DiagnosticSchema), writable: Type.Boolean() });
export const TransitionResultSchema = Type.Union([object({ kind: Type.Literal("committed"), state: RunRecordSchema, event: RunEventSchema, diagnostics: Type.Array(DiagnosticSchema) }), object({ kind: Type.Literal("duplicate"), state: RunRecordSchema }), object({ kind: Type.Literal("rejected"), state: Type.Optional(RunRecordSchema), code: IdSchema, message: text, evidence })]);
export const WriterRequestSchema = object({ sessionId: IdSchema, expectedEpoch: Type.Optional(SequenceSchema), purpose: tags("start", "resume", "operate", "cleanup", "recover") });
export const TrustedConfirmationSchema = object({ approval: ApprovalRecordSchema, reviewedPlanHash: DigestSchema });

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (entry: unknown): string => {
    if (entry === null || typeof entry === "boolean" || typeof entry === "string") return JSON.stringify(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) return JSON.stringify(entry);
    if (typeof entry !== "object" || entry === null || seen.has(entry)) throw new Error("Expected finite acyclic JSON data");
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) throw new Error("Expected a plain JSON object");
    seen.add(entry);
    let encoded: string;
    if (Array.isArray(entry)) {
      if (Object.keys(entry).length !== entry.length) throw new Error("Sparse or extended arrays are not JSON data");
      encoded = `[${entry.map(encode).join(",")}]`;
    } else encoded = `{${Object.keys(entry).sort().map(key => `${JSON.stringify(key)}:${encode((entry as Record<string, unknown>)[key])}`).join(",")}}`;
    seen.delete(entry);
    return encoded;
  };
  return encode(value);
}
export function sha256Utf8(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function digestJson(value: unknown): string { return sha256Utf8(canonicalJson(value)); }
export function assertSchema<S extends TSchema>(schema: S, value: unknown, label = "value"): asserts value is Static<S> {
  canonicalJson(value);
  if (!Value.Check(schema, value)) {
    const issue = Value.Errors(schema, value).First();
    throw new Error(`Invalid ${label}${issue?.path ?? ""}: ${issue?.message ?? "schema mismatch"}`);
  }
  validateData(value);
}
function validateData(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) validateData(item); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "file" && "uri" in record && (typeof record.uri !== "string" || !Value.Check(RelativePathSchema, record.uri))) throw new Error("Evidence file URI must be run-relative without traversal");
  if (record.slug === "supership-upgrade") throw new Error("The supership-upgrade handoff slug is reserved");
  if ("parameters" in record) validateSchemaDocument(record.parameters);
  for (const item of Object.values(record)) validateData(item);
}
export function validateSchemaDocument(value: unknown): void {
  canonicalJson(value);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Tool parameters must be a JSON schema object");
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#/"))) throw new Error("External schema references are forbidden");
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe schema property");
      visit(child);
    }
  };
  visit(value);
}
const outputSchemas = { research: ResearchOutputSchema, plan: PlanOutputSchema, critique: CritiqueOutputSchema, build: BuildOutputSchema, review: ReviewOutputSchema, judge: JudgeOutputSchema, verification: VerificationOutputSchema };
export type Id = Static<typeof IdSchema>;
export type Digest = Static<typeof DigestSchema>;
export type RunSlug = Static<typeof RunSlugSchema>;
export type Phase = Static<typeof PhaseSchema>;
export type Lifecycle = Static<typeof LifecycleSchema>;
export type Mutation = Static<typeof MutationSchema>;
export type WorkKind = Static<typeof WorkKindSchema>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export type CodeIdentity = Static<typeof CodeIdentitySchema>;
export type WorkRef = Static<typeof WorkRefSchema>;
export type WorkDependency = Static<typeof WorkDependencySchema>;
export type ToolVersionRef = Static<typeof ToolVersionRefSchema>;
export type Diagnostic = Static<typeof DiagnosticSchema>;
export type ValidationIssue = Static<typeof ValidationIssueSchema>;
export type ValidationResult = Static<typeof ValidationResultSchema>;
export type RunOwner = Static<typeof RunOwnerSchema>;
export type RepositoryRecord = Static<typeof RepositoryRecordSchema>;
export type InvocationRecord = Static<typeof InvocationRecordSchema>;
export type SeatSourceRecord = Static<typeof SeatSourceRecordSchema>;
export type SeatBinding = Static<typeof SeatBindingSchema>;
export type SeatRequest = Static<typeof SeatRequestSchema>;
export type Limits = Static<typeof LimitsSchema>;
export type UsageRecord = Static<typeof UsageRecordSchema>;
export type IsolationDescriptor = Static<typeof IsolationDescriptorSchema>;
export type WorkToolGrant = Static<typeof WorkToolGrantSchema>;
export type OutputSchemaRef = Static<typeof OutputSchemaRefSchema>;
export type WorkAssignment = Static<typeof WorkAssignmentSchema>;
export type PlannedItem = Static<typeof PlannedItemSchema>;
export type WorkAttempt = Static<typeof WorkAttemptSchema>;
export type RuntimeOwner = Static<typeof RuntimeOwnerSchema>;
export type Scenario = Static<typeof ScenarioSchema>;
export type VerificationCheck = Static<typeof VerificationCheckSchema>;
export type PlanScope = Static<typeof PlanScopeSchema>;
export type RiskRecord = Static<typeof RiskRecordSchema>;
export type CommitGroup = Static<typeof CommitGroupSchema>;
export type EffectDeclaration = Static<typeof EffectDeclarationSchema>;
export type ToolProposal = Static<typeof ToolProposalSchema>;
export type CapturedToolProposal = Static<typeof CapturedToolProposalSchema>;
export type ToolGrant = Static<typeof ToolGrantSchema>;
export type ToolDefinitionRecord = Static<typeof ToolDefinitionRecordSchema>;
export type PlanRecord = Static<typeof PlanRecordSchema>;
export type PlanAmendment = Static<typeof PlanAmendmentSchema>;
export type ApprovalRecord = Static<typeof ApprovalRecordSchema>;
export type RecoveryRecord = Static<typeof RecoveryRecordSchema>;
export type InstructionRecord = Static<typeof InstructionRecordSchema>;
export type FindingVerdict = Static<typeof FindingVerdictSchema>;
export type FindingResolution = Static<typeof FindingResolutionSchema>;
export type FindingRecord = Static<typeof FindingRecordSchema>;
export type ReviewRoundRecord = Static<typeof ReviewRoundRecordSchema>;
export type VerificationRecord = Static<typeof VerificationRecordSchema>;
export type ConclusionRecord = Static<typeof ConclusionRecordSchema>;
export type PolicyGate = Static<typeof PolicyGateSchema>;
export type PathRoutingRule = Static<typeof PathRoutingRuleSchema>;
export type PolicyOverlay = Static<typeof PolicyOverlaySchema>;
export type PreflightEvidence = Static<typeof PreflightEvidenceSchema>;
export type StartRecord = Static<typeof StartRecordSchema>;
export type ResearchOutput = Static<typeof ResearchOutputSchema>;
export type PlanOutput = Static<typeof PlanOutputSchema>;
export type CritiqueOutput = Static<typeof CritiqueOutputSchema>;
export type BuildOutput = Static<typeof BuildOutputSchema>;
export type ReviewOutput = Static<typeof ReviewOutputSchema>;
export type JudgeOutput = Static<typeof JudgeOutputSchema>;
export type VerificationOutput = Static<typeof VerificationOutputSchema>;
export type WorkerOutput = Static<typeof WorkerOutputSchema>;
export type WorkItem = Static<typeof WorkItemSchema>;
export type ActionRecipient = Static<typeof ActionRecipientSchema>;
export type ActionInput = Static<typeof ActionInputSchema>;
export type ActionResult = Static<typeof ActionResultSchema>;
export type ActionDraft = Static<typeof ActionDraftSchema>;
export type ActionRecord = Static<typeof ActionRecordSchema>;
export type Receipt = Static<typeof ReceiptSchema>;
export type ReceiptObservation = Static<typeof ReceiptObservationSchema>;
export type SchedulingSnapshot = Static<typeof SchedulingSnapshotSchema>;
export type RecoveryChoice = Static<typeof RecoveryChoiceSchema>;
export type Reconciliation = Static<typeof ReconciliationSchema>;
export type CodeObservation = Static<typeof CodeObservationSchema>;
export type RecoveryEvidence = Static<typeof RecoveryEvidenceSchema>;
export type InputReceipt = Static<typeof InputReceiptSchema>;
export type ReceiptDigest = Static<typeof ReceiptDigestSchema>;
export type RunRecord = Static<typeof RunRecordSchema>;
export type Fact = Static<typeof FactSchema>;
export type RunEvent = Static<typeof RunEventSchema>;
export type StartInput = Static<typeof StartInputSchema>;
export type EngineInput = Static<typeof EngineInputSchema>;
export type DecisionContext = Static<typeof DecisionContextSchema>;
export type Decision = Static<typeof DecisionSchema>;
export type LoadedRun = Static<typeof LoadedRunSchema>;
export type TransitionResult = Static<typeof TransitionResultSchema>;
export type WriterRequest = Static<typeof WriterRequestSchema>;
export type TrustedConfirmation = Static<typeof TrustedConfirmationSchema>;
export const RawPlanRecordSchema = object({ ...PlanRecordSchema.properties, toolProposals: Type.Array(ToolProposalSchema) });
export const RawPlanAmendmentSchema = object({ ...PlanAmendmentSchema.properties, proposedPlan: RawPlanRecordSchema });
export const RawResearchOutputSchema = object({ ...ResearchOutputSchema.properties, proposedTools: Type.Optional(Type.Array(ToolProposalSchema)) });
export const RawPlanOutputSchema = object({ ...PlanOutputSchema.properties, proposedTools: Type.Optional(Type.Array(ToolProposalSchema)), plan: RawPlanRecordSchema });
export const RawCritiqueOutputSchema = object({ ...CritiqueOutputSchema.properties, proposedTools: Type.Optional(Type.Array(ToolProposalSchema)) });
export const RawBuildOutputSchema = object({ ...BuildOutputSchema.properties, proposedTools: Type.Array(ToolProposalSchema), proposedAmendment: Type.Optional(RawPlanAmendmentSchema) });
export const RawReviewOutputSchema = object({ ...ReviewOutputSchema.properties, proposedTools: Type.Optional(Type.Array(ToolProposalSchema)) });
export const RawJudgeOutputSchema = object({ ...JudgeOutputSchema.properties, proposedTools: Type.Optional(Type.Array(ToolProposalSchema)) });
export const RawVerificationOutputSchema = object({ ...VerificationOutputSchema.properties, proposedTools: Type.Optional(Type.Array(ToolProposalSchema)) });
export const RawWorkerOutputSchema = Type.Union([RawResearchOutputSchema, RawPlanOutputSchema, RawCritiqueOutputSchema, RawBuildOutputSchema, RawReviewOutputSchema, RawJudgeOutputSchema, RawVerificationOutputSchema]);
export type RawWorkerOutput = Static<typeof RawWorkerOutputSchema>;
export type RawPlanRecord = Static<typeof RawPlanRecordSchema>;
export type RawPlanAmendment = Static<typeof RawPlanAmendmentSchema>;
export type RawResearchOutput = Static<typeof RawResearchOutputSchema>;
export type RawPlanOutput = Static<typeof RawPlanOutputSchema>;
export type RawCritiqueOutput = Static<typeof RawCritiqueOutputSchema>;
export type RawBuildOutput = Static<typeof RawBuildOutputSchema>;
export type RawReviewOutput = Static<typeof RawReviewOutputSchema>;
export type RawJudgeOutput = Static<typeof RawJudgeOutputSchema>;
export type RawVerificationOutput = Static<typeof RawVerificationOutputSchema>;
const rawOutputSchemas = { research: RawResearchOutputSchema, plan: RawPlanOutputSchema, critique: RawCritiqueOutputSchema, build: RawBuildOutputSchema, review: RawReviewOutputSchema, judge: RawJudgeOutputSchema, verification: RawVerificationOutputSchema };
export function schemaByName(name: string, version: number): TSchema {
  if (version !== 1 || !Object.hasOwn(rawOutputSchemas, name)) throw new Error(`Unsupported output schema ${name}@${version}`);
  return rawOutputSchemas[name as keyof typeof rawOutputSchemas];
}
export function persistedSchemaByName(name: string, version: number): TSchema {
  if (version !== 1 || !Object.hasOwn(outputSchemas, name)) throw new Error(`Unsupported output schema ${name}@${version}`);
  return outputSchemas[name as keyof typeof outputSchemas];
}

export type WorkContext = Static<typeof WorkContextSchema>;
export type WorktreeOwnership = Static<typeof WorktreeOwnershipSchema>;
export type GitOperationResult = Static<typeof GitOperationResultSchema>;
export type PushTarget = Static<typeof PushTargetSchema>;
export type PoolRecord = Static<typeof PoolRecordSchema>;
export type ToolInvocationRecord = Static<typeof ToolInvocationRecordSchema>;
export type VerificationOperation = Static<typeof VerificationOperationSchema>;

export type WorkPatch = Static<typeof WorkPatchSchema>;
export function toolApprovalScope(proposal: CapturedToolProposal, grants: ToolGrant[]): string {
  const sorted = [...grants].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return digestJson({ sourceHash: proposal.sourceHash, schemaHash: proposal.schemaHash, initialization: proposal.initialization, effects: proposal.effects, intendedUsers: [...proposal.intendedUsers].sort(), grants: sorted });
}

export type VerificationRequirement = Static<typeof VerificationRequirementSchema>;

export type UsageSource = Static<typeof UsageSourceSchema>;
export type UsageCoverage = Static<typeof UsageCoverageSchema>;
