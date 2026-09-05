import type { DecisionContext, EngineInput, EvidenceRef, PlanRecord, RunEvent, RunRecord, StartInput, WorkAssignment } from "../src/contracts.ts";
import { applyEvent, decide, makeEvent } from "../src/engine.ts";
export const hash = "1".repeat(64);
export const evidence: EvidenceRef = { id: "proof", kind: "artifact", uri: "artifact://fixture/proof", digest: hash, mediaType: "text/plain", summary: "Observed fixture evidence", availability: "available" };
export function startInput(root = "/repository", slug = "fixture", leaseId = "lease"): StartInput {
  const repository = { root, gitDir: `${root}/.git`, commonDir: `${root}/.git`, initialHead: "HEAD", baselineRef: evidence, baselineDigest: hash };
  const seats = ["scout", "architect", "critic", "judge", "judge-secondary", "correctness", "simplicity", "builder", "sonic"].map(seatId => ({ seatId, baseAgent: seatId, alias: "fixture-" + seatId, resolvedModel: "fixture/model", fallbackSeatIds: [], source: { agentName: seatId, kind: "bundled" as const, path: "agents/" + seatId + ".md", contentHash: hash, bodyHash: hash, metadataHash: hash }, bindingGeneration: 0 }));
  return { kind: "start", start: { schemaVersion: 1, runId: `run-${slug}`, slug, owner: { sessionId: "session", epoch: 0, leaseId }, repository, invocation: { command: "shipit", mode: "autonomous", topology: "normal", intent: "Fixture task", commitRequested: false, pushRequested: false }, seats, limits: {}, policy: { schemaVersion: 1, seats: [], namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], phaseGates: [], pathRouting: [], instructionRefs: [] }, preflight: { schemaVersion: 1, observedVersion: "18.1.10", checks: [{ name: "capabilities", passed: true, expected: "supported", observed: "supported", evidence: [evidence] }], repository, planMode: false, ownerAvailable: true, ignoreVerified: true, seats } } };
}
export function assignment(id = "research"): WorkAssignment {
  return { id, revision: 1, kind: "research", dependencies: [], seatId: "scout", expectedPaths: ["src"], expectedOutputs: ["cited answers"], verificationCheckIds: [], mutation: "read-only", isolation: { kind: "active-checkout" }, toolGrants: [], outputSchema: { name: "research", version: 1 }, instructions: "Inspect the assigned source paths", evidence: [evidence] };
}
export function plan(items: WorkAssignment[] = []): PlanRecord {
  return { schemaVersion: 1, revision: 1, title: "Fixture plan", objective: "Prove behavior", scope: { included: ["fixture"], excluded: [], paths: ["src"], effects: [], publicContracts: [], dependencies: [] }, evidence: [evidence], items, risks: [], requiredLenses: ["correctness", "simplicity"], verificationChecks: [], commitGroups: [], toolProposals: [], ...(items.length ? {} : { noChangeReason: "Observed code already meets the request" }) };
}
export function harness(initial = startInput()) {
  let state: RunRecord | undefined;
  const events: RunEvent[] = [];
  const context = (inputId = `input-${events.length + 1}`): DecisionContext => ({ now: 1000 + events.length, inputId, ownerSessionId: state?.owner.sessionId ?? "session", ownerEpoch: state?.owner.epoch ?? 0 });
  const accept = (input: EngineInput, ctx = context()) => {
    const decision = decide(state, input, ctx);
    if (decision.kind !== "append") throw new Error(`Expected accepted transition: ${JSON.stringify(decision)}`);
    const event = makeEvent(state, input, ctx, decision.facts);
    state = applyEvent(state, event); events.push(event);
    return state;
  };
  accept(initial);
  return { get state() { return state!; }, events, context, accept };
}
