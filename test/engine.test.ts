import { describe, expect, test } from "bun:test";
import { assertSchema, canonicalJson, digestJson, WorkerOutputSchema, schemaByName, type ActionRecord, type EngineInput, type Receipt, type RuntimeOwner } from "../src/contracts.ts";
import { applyEvent, decide, makeEvent, selectNextAction, validatePlan } from "../src/engine.ts";
import { assignment, evidence, harness, hash, plan } from "./core-fixtures.ts";

function runWork(count = 1) {
  const h = harness();
  h.accept({ kind: "record-runtime-snapshot", snapshot: { ompCeiling: 3, activeOwners: [], knownCompletedOwners: [], unknownOwners: [], observedAt: h.state.updatedAt } });
  for (let index = 0; index < count; index++) h.accept({ kind: "record-work", assignment: assignment(`work-${index}`) });
  const draft = selectNextAction(h.state, h.state.runtime!)!;
  h.accept({ kind: "issue-action", draft, programHash: hash });
  const action = h.state.actions.at(-1)!;
  const claim: EngineInput = { kind: "claim-action", actionId: action.id, expectedStateRevision: action.expectedStateRevision, toolCallId: "call", inputHash: action.inputHash, programHash: hash };
  h.accept(claim);
  return { h, action, claim };
}
function owner(action: ActionRecord, index = 0): RuntimeOwner {
  const recipient = action.recipients[index];
  return { kind: "task", id: `runtime-${index}`, actionId: action.id, workId: recipient.workId, workRevision: recipient.workRevision, attemptId: recipient.attemptId, sessionId: "session", ownerEpoch: 0, status: "observed-running" };
}
function receipt(action: ActionRecord, runtime: RuntimeOwner, completed = false): Receipt {
  const base = { schemaVersion: 1 as const, receiptId: `${completed ? "done" : "created"}-${runtime.id}`, runId: action.runId, ownerEpoch: action.ownerEpoch, actionId: action.id, inputHash: action.inputHash, planRevision: action.planRevision, evidence: [evidence], work: { id: runtime.workId, revision: runtime.workRevision, attemptId: runtime.attemptId } };
  return completed ? { ...base, kind: "completed", owner: { ...runtime, status: "observed-terminal" }, output: { schemaVersion: 1, kind: "research", workId: runtime.workId, workRevision: runtime.workRevision, attemptId: runtime.attemptId, answers: [{ question: "Does it work?", answer: "Observed source and runtime", citations: [evidence] }], gaps: [], proposedPaths: [] } } : { ...base, kind: "created", owner: runtime };
}
const observe = (receipt: Receipt): EngineInput => ({ kind: "observe-receipt", receipt, observation: { kind: "runtime-confirmed", toolCallId: "call", verifiedProgramHash: hash, evidence: [evidence] } });

describe("closed contracts", () => {
  test("rejects unknown versions, extra properties, prose and unsafe JSON before effects", () => {
    const h = harness();
    const before = canonicalJson(h.state);
    const invalid = { kind: "record-work", assignment: { ...assignment(), outputSchema: { name: "research", version: 99 } } } as unknown as EngineInput;
    expect(decide(h.state, invalid, h.context()).kind).toBe("reject");
    expect(decide(h.state, { kind: "request-cancel", reason: "stop", evidence: [], patch: {} } as unknown as EngineInput, h.context()).kind).toBe("reject");
    expect(() => assertSchema(WorkerOutputSchema, "a prose answer")).toThrow();
    expect(() => schemaByName("research", 99)).toThrow();
    expect(() => schemaByName("toString", 1)).toThrow();
    expect(() => canonicalJson({ value: undefined })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
    expect(canonicalJson(h.state)).toBe(before);
  });
  test("rejects unknown nested tool schema references and traversal evidence", () => {
    const h = harness();
    expect(decide(h.state, { kind: "record-instruction", instruction: { id: "bad", receivedAt: 1001, textRef: { ...evidence, kind: "file", uri: "../../secret" }, summary: "bad", affectedWork: [], classification: "ordinary", status: "recorded", evidence: [] } }, h.context()).kind).toBe("reject");
    const badPlan = plan();
    badPlan.toolProposals.push({ schemaVersion: 1, name: "tool", purpose: "test", description: "test", sourceRef: evidence, sourceHash: hash, schemaHash: hash, parameters: { $ref: "https://example.invalid/schema" }, initialization: [], effects: { kind: "read-only", paths: [], description: "none" }, intendedUsers: [], recreation: "recreatable" });
    expect(decide(h.state, { kind: "record-plan", plan: badPlan }, h.context()).kind).toBe("reject");
  });
});

describe("events and action identity", () => {
  test("replays every accepted transition without aliasing caller inputs or events", () => {
    const { h, action } = runWork();
    h.accept(observe(receipt(action, owner(action))));
    h.accept(observe(receipt(action, owner(action), true)));
    let replayed;
    for (const event of h.events) replayed = applyEvent(replayed, event);
    expect(canonicalJson(replayed)).toBe(canonicalJson(h.state));
    const eventBefore = canonicalJson(h.events[0]);
    const initial = applyEvent(undefined, h.events[0]);
    initial.repository.root = "/changed";
    expect(canonicalJson(h.events[0])).toBe(eventBefore);
    expect(h.state.work[0].status).toBe("succeeded");
  });
  test("deduplicates the same input and rejects an ID reused with different content", () => {
    const h = harness();
    const input: EngineInput = { kind: "record-work", assignment: assignment() };
    const ctx = h.context("stable-input");
    h.accept(input, ctx);
    expect(decide(h.state, input, ctx)).toEqual({ kind: "duplicate", eventSequence: h.state.eventSequence });
    expect(decide(h.state, { ...input, assignment: assignment("different") }, ctx)).toMatchObject({ kind: "reject", code: "input-id-conflict" });
  });
  test("an issued action needs the exact revision and may be consumed only once", () => {
    const { h, claim } = runWork();
    expect(decide(h.state, claim, h.context())).toMatchObject({ kind: "reject", code: "action-not-claimable" });
    const second = harness(); second.accept({ kind: "record-work", assignment: assignment() });
    second.accept({ kind: "issue-action", draft: selectNextAction(second.state, { ompCeiling: 1, activeOwners: [], knownCompletedOwners: [], unknownOwners: [], observedAt: 1000 })! });
    const action = second.state.actions[0];
    second.accept({ kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 1, costAmount: null, model: "fixture/model", observedAt: 0 }] });
    expect(decide(second.state, { kind: "claim-action", actionId: action.id, expectedStateRevision: action.expectedStateRevision, toolCallId: "stale", inputHash: action.inputHash }, second.context())).toMatchObject({ kind: "reject", code: "stale-action" });
  });
  test("claimed receipts survive unrelated events, duplicate receipts cannot repeat a result", () => {
    const { h, action } = runWork();
    const created = observe(receipt(action, owner(action)));
    h.accept(created);
    h.accept({ kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 2, costAmount: null, model: "fixture/model", observedAt: 0 }] });
    expect(decide(h.state, created, h.context()).kind).toBe("duplicate");
    const completed = observe(receipt(action, owner(action), true));
    h.accept(completed);
    expect(decide(h.state, completed, h.context()).kind).toBe("duplicate");
    const changed = structuredClone(completed);
    if (changed.kind === "observe-receipt") changed.receipt.evidence = [];
    expect(decide(h.state, changed, h.context())).toMatchObject({ kind: "reject", code: "receipt-id-conflict" });
  });
  test("steering supersedes affected work while an unrelated recipient still completes", () => {
    const { h, action } = runWork(2);
    h.accept(observe(receipt(action, owner(action, 0)))); h.accept(observe(receipt(action, owner(action, 1))));
    h.accept({ kind: "record-instruction", instruction: { id: "steer", receivedAt: h.state.updatedAt, textRef: evidence, summary: "Change first assignment", affectedWork: [{ id: "work-0", revision: 1 }], classification: "material", status: "recorded", evidence: [] } });
    h.accept(observe(receipt(action, owner(action, 0), true)));
    expect(h.state.work[0].runtimeOwners[0].status).toBe("observed-terminal");
    expect(h.state.retainedResults?.[0].reason).toBe("superseded");
    h.accept(observe(receipt(action, owner(action, 1), true)));
    expect(h.state.work.map(work => work.status)).toEqual(["superseded", "succeeded"]);
    expect(h.state.work[0].result).toBeUndefined();
  });
  test("a transferred epoch rejects late output and preserves an uncertain spawn for recovery", () => {
    const { h, action } = runWork();
    h.accept({ kind: "resume", sessionId: "next-session", leaseId: "next-lease", reconciliation: { confirmed: [], unresolved: [], candidateResults: [], requiredChoices: [] } }, { ...h.context(), ownerSessionId: "next-session" });
    expect(h.state.owner.epoch).toBe(1);
    expect(h.state.lifecycle).toBe("blocked");
    expect(h.state.work[0].status).toBe("awaiting-recovery");
    expect(decide(h.state, observe(receipt(action, owner(action), true)), { ...h.context(), ownerSessionId: "session", ownerEpoch: 0 })).toMatchObject({ kind: "reject", code: "stale-owner" });
  });
  test("malformed mutation output blocks the attempt without scheduling a repeat mutation", () => {
    const { h, action: researchAction } = runWork();
    h.accept(observe(receipt(researchAction, owner(researchAction))));
    h.accept(observe(receipt(researchAction, owner(researchAction), true)));
    const builder = { ...assignment("builder"), kind: "build" as const, mutation: "repository" as const, outputSchema: { name: "build" as const, version: 1 as const } };
    const approvedPlan = plan([builder]);
    h.accept({ kind: "advance-phase", phase: "research", reason: "Preflight proof exists", evidence: [] });
    h.accept({ kind: "advance-phase", phase: "plan", reason: "Research completed", evidence: [] });
    h.accept({ kind: "record-plan", plan: approvedPlan });
    h.accept({ kind: "advance-phase", phase: "approval", reason: "Plan validated", evidence: [] });
    h.accept({ kind: "record-trusted-approval", approval: { id: "plan-approved", kind: "initial-plan", decision: "approve", authority: "autonomous-policy", scopeHash: digestJson(approvedPlan), planRevision: 1, toolVersions: [], ownerEpoch: 0, createdAt: h.state.updatedAt, rationale: "Autonomous fixture policy", evidence: [] } });
    h.accept({ kind: "advance-phase", phase: "build", reason: "Plan approved", evidence: [] });
    const code = { head: "HEAD", indexTree: "tree", worktreeDigest: hash, scopeDigest: hash, parentEffectDigest: hash };
    h.accept({ kind: "record-git-observation", observation: { identity: code, paths: [], evidence: [evidence], observedAt: h.state.updatedAt } });
    h.accept({ kind: "issue-action", draft: selectNextAction(h.state, h.state.runtime!)!, programHash: hash });
    const branch = h.state.actions.at(-1)!;
    h.accept({ kind: "claim-action", actionId: branch.id, expectedStateRevision: branch.expectedStateRevision, toolCallId: "branch-call", inputHash: branch.inputHash, programHash: hash });
    h.accept({ kind: "settle-action", actionId: branch.id, result: { kind: "success", evidence: [evidence], output: { kind: "git", operation: "create_branch", before: code, after: code, branch: "supership/fixture", commits: [], ownershipEvidence: [evidence] } } });
    h.accept({ kind: "record-work", assignment: builder });
    h.accept({ kind: "issue-action", draft: selectNextAction(h.state, h.state.runtime!)!, programHash: hash });
    const action = h.state.actions.at(-1)!;
    h.accept({ kind: "claim-action", actionId: action.id, expectedStateRevision: action.expectedStateRevision, toolCallId: "builder-call", inputHash: action.inputHash, programHash: hash });
    const work = h.state.work.find(work => work.id === "builder")!;
    h.accept({ kind: "record-invalid-output", work: { id: work.id, revision: work.revision, attemptId: work.attempt.id }, actionId: action.id, outputRef: evidence, issues: [{ code: "schema", path: "", message: "Malformed output", evidence: [] }], observation: { kind: "runtime-confirmed", toolCallId: "builder-call", verifiedProgramHash: hash, evidence: [] } });
    expect(h.state.work.find(work => work.id === "builder")!.attempt.number).toBe(1);
    expect(h.state.lifecycle).toBe("blocked");
    expect(selectNextAction(h.state, h.state.runtime!)?.input.kind).toBe("collect_input");
    expect(h.state.work.filter(work => work.kind === "build")).toHaveLength(1);
  });
  test("replay refuses impossible success and corrupt envelopes even with a recomputed hash", () => {
    const h = harness(); h.accept({ kind: "record-work", assignment: assignment() });
    const input: EngineInput = { kind: "request-cancel", reason: "stop", evidence: [] };
    const forged = makeEvent(h.state, input, h.context(), [{ kind: "work-recorded", work: { ...h.state.work[0], status: "succeeded" } }]);
    expect(() => applyEvent(h.state, forged)).toThrow("Invalid work status transition");
    const wrongRun = { ...forged, runId: "other" };
    const { hash: ignoredHash, ...wrongEnvelope } = wrongRun; wrongRun.hash = digestJson(wrongEnvelope);
    expect(() => applyEvent(h.state, wrongRun)).toThrow("Event run/owner/time mismatch");
  });
});

describe("safe transition gates", () => {
  test("cancellation stays unresolved after an acknowledgment and terminal runs reject new work", () => {
    const { h, action } = runWork();
    h.accept(observe(receipt(action, owner(action))));
    h.accept({ kind: "request-cancel", reason: "stop", evidence: [] });
    expect(h.state.lifecycle).toBe("cancelling");
    const draft = selectNextAction(h.state, h.state.runtime!)!;
    h.accept({ kind: "issue-action", draft, programHash: hash });
    const cancel = h.state.actions.at(-1)!;
    h.accept({ kind: "claim-action", actionId: cancel.id, expectedStateRevision: cancel.expectedStateRevision, toolCallId: "cancel", inputHash: cancel.inputHash, programHash: hash });
    const ack: Receipt = { schemaVersion: 1, receiptId: "cancel-confirmed", runId: cancel.runId, ownerEpoch: 0, actionId: cancel.id, inputHash: cancel.inputHash, planRevision: cancel.planRevision, evidence: [], kind: "cancel-confirmed", owners: [owner(action)], settlementEvidence: [] };
    expect(decide(h.state, observe(ack), h.context())).toMatchObject({ kind: "reject", code: "unconfirmed-cancellation" });
    ack.owners[0].status = "observed-terminal"; ack.settlementEvidence = [evidence]; h.accept(observe(ack));
    expect(h.state.lifecycle).toBe("cancelled");
    expect(decide(h.state, { kind: "record-work", assignment: assignment("new") }, h.context())).toMatchObject({ kind: "reject", code: "terminal-run" });
  });
  test("a terminal runtime snapshot before cancellation issue still settles unfinished logical work", () => {
    const { h, action } = runWork(2);
    h.accept(observe(receipt(action, owner(action, 0))));
    h.accept(observe(receipt(action, owner(action, 1))));
    h.accept(observe(receipt(action, owner(action, 1), true)));
    h.accept({ kind: "request-cancel", reason: "stop", evidence: [] });
    const stopped = { ...owner(action), status: "observed-terminal" as const };
    h.accept({ kind: "record-runtime-snapshot", snapshot: { ...h.state.runtime!, knownCompletedOwners: [stopped], observedAt: h.state.updatedAt } });
    expect(h.state.work.map(work => work.status)).toEqual(["running", "succeeded"]);
    const draft = selectNextAction(h.state, h.state.runtime!)!;
    expect(draft.input).toMatchObject({ kind: "cancel_runtime", owners: [stopped] });
    h.accept({ kind: "issue-action", draft, programHash: hash });
    const cancel = h.state.actions.at(-1)!;
    h.accept({ kind: "claim-action", actionId: cancel.id, expectedStateRevision: cancel.expectedStateRevision, toolCallId: "cancel", inputHash: cancel.inputHash, programHash: hash });
    const confirmed: Receipt = { schemaVersion: 1, receiptId: "cancel-terminal", runId: cancel.runId, ownerEpoch: 0, actionId: cancel.id, inputHash: cancel.inputHash, planRevision: cancel.planRevision, evidence: [], kind: "cancel-confirmed", owners: [], settlementEvidence: [evidence] };
    expect(decide(h.state, observe(confirmed), h.context())).toMatchObject({ kind: "reject", code: "unresolved-cancellation" });
    confirmed.owners = [stopped];
    h.accept(observe(confirmed));
    expect(h.state.lifecycle).toBe("cancelled");
    expect(h.state.work.map(work => work.status)).toEqual(["cancelled", "succeeded"]);
  });
  test("cancellation with no confirmed spawn owner still requires manual reconciliation", () => {
    const { h } = runWork();
    h.accept({ kind: "request-cancel", reason: "stop", evidence: [] });
    expect(selectNextAction(h.state, h.state.runtime!)?.input).toMatchObject({ kind: "collect_input", request: { id: "cancel-reconciliation" } });
    expect(h.state.lifecycle).toBe("cancelling");
    expect(h.state.work[0].status).toBe("running");
  });
  test("unknown owners and dependencies prevent new work; cyclic plans fail validation", () => {
    const { h, action } = runWork();
    h.accept({ kind: "record-work", assignment: { ...assignment("dependent"), dependencies: [{ id: "work-0", revision: 1 }] } });
    expect(selectNextAction(h.state, { ...h.state.runtime!, unknownOwners: [owner(action)] })?.input.kind).toBe("wait");
    expect(selectNextAction(h.state, h.state.runtime!)).toBeUndefined();
    const cyclic = plan([{ ...assignment("a"), dependencies: [{ id: "b", revision: 1 }] }, { ...assignment("b"), dependencies: [{ id: "a", revision: 1 }] }]);
    expect(validatePlan(cyclic, h.state).some(issue => issue.message.includes("cycle"))).toBe(true);
  });
  test("repository verification applies to intersecting scopes without weakening unconditional checks", () => {
    const state = harness().state;
    state.policy.requiredVerification = [
      { id: "always", description: "Repository check", scopePaths: [], instructions: "Run the repository check", source: [evidence] },
      { id: "api", description: "API check", scopePaths: ["apps/api/**"], instructions: "Run API checks", source: [evidence] },
    ];
    const proposed = plan();
    proposed.scope.paths = ["docs"];
    proposed.verificationChecks = [{ id: "always", description: "Repository check", scopePaths: [], scenario: { kind: "command", command: ["bun", "test"], cwd: "/repository" }, required: true, source: [evidence] }];
    const always = proposed.verificationChecks[0];
    expect(validatePlan(proposed, state)).toEqual([]);
    proposed.verificationChecks = [];
    expect(validatePlan(proposed, state).map(issue => issue.message)).toEqual([expect.stringContaining("always")]);
    proposed.verificationChecks = [always];
    for (const path of ["apps/api/router.ts", "apps", "apps/**"]) {
      proposed.scope.paths = [path];
      expect(validatePlan(proposed, state).map(issue => issue.message)).toEqual([expect.stringContaining("api")]);
    }
    proposed.verificationChecks.push({ ...always, id: "api", scopePaths: ["docs"] });
    expect(validatePlan(proposed, state).map(issue => issue.message)).toEqual([expect.stringContaining("api")]);
    proposed.verificationChecks[1].scopePaths = ["apps/api/**"];
    expect(validatePlan(proposed, state)).toEqual([]);
    proposed.verificationChecks[1].required = false;
    expect(validatePlan(proposed, state).map(issue => issue.message)).toEqual([expect.stringContaining("api")]);
  });
  test("caps pause without claiming success, and no completion can bypass review and verification", () => {
    const h = harness();
    const forged = structuredClone(h.state); forged.limits.tokens = 2;
    const input: EngineInput = { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 3, costAmount: null, model: "fixture/model", observedAt: 0 }] };
    const decision = decide(forged, input, h.context());
    expect(decision.kind === "append" && decision.facts.some(fact => fact.kind === "lifecycle-changed" && fact.to === "paused")).toBe(true);
    expect(decide(h.state, { kind: "conclude", conclusion: { kind: "no-change", summary: "done", evidence: [evidence], lessons: [], unresolvedDeferredFindingIds: [], completedAt: 1010 } }, h.context())).toMatchObject({ kind: "reject", code: "incomplete-run" });
  });
});

describe("usage coverage and priced lower bounds", () => {
  const source = (id: string, tokens: number, costAmount: number | null, complete = true) => ({ id, complete, tokens, costAmount, model: "fixture/model", observedAt: 0 });
  const coverage = (action: ActionRecord, status: "unknown" | "partial" | "complete", observedAt = 0, id = "cov-" + action.id) => ({ id, actionId: action.id, work: action.recipients.map(recipient => ({ id: recipient.workId, revision: recipient.workRevision, attemptId: recipient.attemptId })), status, reason: status, observedAt });
  test("repeated observations merge by id without double counting and the latest observation wins", () => {
    const { h, action } = runWork();
    const input: EngineInput = { kind: "record-source-usage", sources: [source("msg-1", 5, 0.5)], coverage: [coverage(action, "partial", 1)] };
    h.accept(input); h.accept(structuredClone(input));
    expect(h.state.usage.tokens).toBe(5); expect(h.state.usage.cost).toMatchObject({ amount: null, pricedSubtotal: 0.5 }); expect(h.state.usageCoverage).toHaveLength(1);
    h.accept({ kind: "record-source-usage", sources: [], coverage: [coverage(action, "unknown", 0)] });
    expect(h.state.usageCoverage[0].status).toBe("partial");
    h.accept({ kind: "record-source-usage", sources: [], coverage: [coverage(action, "complete", 2)] });
    expect(h.state.usageCoverage[0].status).toBe("complete"); expect(h.state.usage.cost.amount).toBe(0.5);
    let replayed; for (const event of h.events) replayed = applyEvent(replayed, event);
    expect(canonicalJson(replayed)).toBe(canonicalJson(h.state));
  });
  test("a coverage gap keeps known sources as a lower bound and unknown pricing stays uncertain under complete coverage", () => {
    const { h, action } = runWork();
    h.accept({ kind: "record-source-usage", sources: [source("msg-1", 5, 0.5)], coverage: [coverage(action, "complete")] });
    expect(h.state.usage.cost.amount).toBe(0.5);
    h.accept({ kind: "record-source-usage", sources: [], coverage: [{ ...coverage(action, "unknown", 1, "cov-missing-file"), reason: "observer file missing" }] });
    expect(h.state.usage).toMatchObject({ tokens: 5, cost: { amount: null, pricedSubtotal: 0.5 } });
    h.accept({ kind: "record-source-usage", sources: [source("msg-2", 3, null)], coverage: [{ ...coverage(action, "complete", 2, "cov-missing-file"), reason: "file recovered" }] });
    expect(h.state.usageCoverage.every(record => record.status === "complete")).toBe(true);
    expect(h.state.usage).toMatchObject({ tokens: 8, cost: { amount: null, pricedSubtotal: 0.5, unpricedModels: ["fixture/model"] } });
    h.accept({ kind: "record-source-usage", sources: [source("msg-3", 1, 1, false)] });
    expect(h.state.usage.cost.amount).toBeNull();
  });
  test("coverage must name authorized work, and a late superseded attempt counts without reviving its result", () => {
    const { h, action } = runWork();
    const forged = { ...coverage(action, "complete"), work: [{ id: "work-0", revision: 1, attemptId: "work-0:r1:9" }] };
    expect(decide(h.state, { kind: "record-source-usage", sources: [], coverage: [forged] }, h.context())).toMatchObject({ kind: "reject", code: "invalid-usage-source" });
    expect(decide(h.state, { kind: "record-source-usage", sources: [], coverage: [{ ...coverage(action, "complete"), actionId: "missing" }] }, h.context())).toMatchObject({ kind: "reject", code: "invalid-usage-source" });
    h.accept({ kind: "record-source-usage", sources: [], coverage: [coverage(action, "partial")] });
    expect(decide(h.state, { kind: "record-source-usage", sources: [], coverage: [{ ...coverage(action, "partial", 5), actionId: "other" }] }, h.context())).toMatchObject({ kind: "reject", code: "invalid-usage-source" });
    h.accept({ kind: "record-plan", plan: plan([assignment("work-0")]) });
    h.accept({ kind: "record-plan", plan: { ...plan(), revision: 2 } });
    expect(h.state.work[0].status).toBe("superseded"); expect(h.state.actions.find(candidate => candidate.id === action.id)?.status).toBe("superseded");
    const before = canonicalJson({ work: h.state.work, actions: h.state.actions });
    h.accept({ kind: "record-source-usage", sources: [source("late-msg", 7, 0.25)], coverage: [coverage(action, "partial", 3)] });
    expect(h.state.usage).toMatchObject({ tokens: 7, cost: { amount: null, pricedSubtotal: 0.25 } });
    expect(canonicalJson({ work: h.state.work, actions: h.state.actions })).toBe(before);
  });
  test("a known priced subtotal pauses on the USD cap while the total stays unknown; a fully unknown cost keeps overshoot null", () => {
    const h = harness();
    h.accept({ kind: "configure-limits", limits: { cost: { amount: 1, currency: "USD" } }, rationale: "fixture cap" });
    h.accept({ kind: "record-source-usage", sources: [source("unpriced", 4, null)] });
    expect(h.state.usage.overshoot.cost).toBeNull(); expect(h.state.lifecycle).toBe("active");
    h.accept({ kind: "record-source-usage", sources: [source("priced", 2, 1.5)] });
    expect(h.state.usage).toMatchObject({ cost: { amount: null, pricedSubtotal: 1.5 }, overshoot: { cost: 0.5 } });
    expect(h.state.lifecycle).toBe("paused"); expect(h.state.recovery?.triggers).toEqual(["cost-cap"]);
  });
  test("absurd child rows saturate the aggregate instead of freezing every later usage record", () => {
    const h = harness();
    h.accept({ kind: "record-source-usage", sources: [source("huge-1", Number.MAX_SAFE_INTEGER, 1e308)] });
    h.accept({ kind: "record-source-usage", sources: [source("huge-2", 1, 1e308), source("small", 1, 0.01)] });
    expect(h.state.usage.tokens).toBe(Number.MAX_SAFE_INTEGER); expect(h.state.usage.cost.pricedSubtotal).toBe(Number.MAX_VALUE); expect(h.state.usage.cost.amount).toBe(Number.MAX_VALUE);
    expect(h.state.usageSources.map(item => item.costAmount)).toEqual([1e308, 1e308, 0.01]);
    let replayed; for (const event of h.events) replayed = applyEvent(replayed, event);
    expect(canonicalJson(replayed)).toBe(canonicalJson(h.state));
  });
});

test("native tool source requires capture before an accepted completion can persist it", () => {
  const { h, action } = runWork(); h.accept(observe(receipt(action, owner(action))));
  const completed = receipt(action, owner(action), true);
  if (completed.kind !== "completed") throw new Error("Expected completion fixture");
  const raw = { ...completed.output, proposedTools: [{ schemaVersion: 1, name: "check", purpose: "Check data", description: "A run scoped check", source: "async () => 1", parameters: { type: "object", properties: {}, additionalProperties: false }, initialization: [], effects: { kind: "read-only", paths: [], description: "No effects" }, intendedUsers: ["scout"], recreation: "recreatable" }] };
  assertSchema(schemaByName("research", 1), raw);
  expect(() => assertSchema(WorkerOutputSchema, raw)).toThrow();
  const unsafe = observe({ ...completed, output: raw } as unknown as Receipt);
  expect(decide(h.state, unsafe, h.context())).toMatchObject({ kind: "reject", code: "invalid-schema" });
  expect(h.state.work[0].status).toBe("running");
});


test("judge resolution retains coincident stall and caps until each has an explicit disposition", () => {
  const h = harness(), code = { head: "HEAD", indexTree: "tree", worktreeDigest: hash, scopeDigest: hash, parentEffectDigest: hash };
  h.state.phase = "review"; h.state.lifecycle = "paused"; h.state.plan = plan(); h.state.planRevision = 1; h.state.limits.reviewRounds = 2;
  h.state.code = { identity: code, paths: [], observedAt: 1000, evidence: [evidence] };
  h.state.findings = [{ schemaVersion: 1, id: "finding", fingerprint: hash, lens: "correctness", location: { path: "src/a.ts" }, condition: "Called twice", claim: "Repeats the effect", impact: "Duplicates a mutation", severity: "high", evidence: [evidence], fixTarget: { path: "src/a.ts", description: "Persist operation identity" }, verdicts: [{ judgeId: "judge", round: 2, verdict: "accepted", reason: "Observed", evidence: [evidence] }] }];
  h.state.reviewRounds = [{ round: 2, startedAt: 1000, completedAt: 1000, codeIdentity: code, lenses: ["correctness", "simplicity"], reviewerOwners: [], judgeOwners: [], priorEvidencePacket: evidence, unresolvedFingerprints: [hash], relevantCodeDigest: hash, verdictEvidence: [evidence] }];
  h.state.recovery = { scope: "run", intent: "resume", primaryReason: "no-progress", triggers: ["judge-disagreement", "no-progress", "review-round-cap"], affectedWork: [], unresolvedOwners: [], resumePhase: "review", requiredChoices: ["resolve-judges", "stop"], evidence: [evidence] };
  const decisions = [{ findingId: "finding", verdict: "accepted" as const, reason: "Reproduced", evidence: [evidence] }];
  h.accept({ kind: "resolve-judges", round: 2, decisions, approval: { id: "resolve", kind: "judge-disagreement", decision: "approve", authority: "omp-tui", scopeHash: digestJson({ round: 2, decisions }), planRevision: 1, toolVersions: [], ownerEpoch: 0, createdAt: 1000, rationale: "Reproduced", evidence: [evidence] } });
  expect(h.state.lifecycle).toBe("paused");
  expect(h.state.recovery?.triggers).toEqual(["no-progress", "review-round-cap"]);
  h.accept({ kind: "override-stall", newSeatIds: ["architect", "critic"], approval: { id: "override", kind: "stall-override", decision: "approve", authority: "omp-tui", scopeHash: digestJson({ round: 2, newSeatIds: ["architect", "critic"] }), planRevision: 1, toolVersions: [], ownerEpoch: 0, createdAt: 1000, rationale: "Different review seats", evidence: [evidence] } });
  expect(h.state.lifecycle).toBe("paused");
  expect(h.state.recovery?.triggers).toEqual(["review-round-cap"]);
});
