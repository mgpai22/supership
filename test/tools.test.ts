import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProposal, inspectProposal, readCapturedSource, validateGrant } from "../src/tools.ts";
import { toolApprovalScope, type ToolDefinitionRecord, type ToolProposal, type WorkItem } from "../src/contracts.ts";

const proposal: ToolProposal = {
  schemaVersion: 1, name: "calculate", description: "Calculate a requested value", purpose: "Reuse a deterministic calculation",
  source: "({value}) => value * 3 + 2", parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
  initialization: [], effects: { kind: "read-only", paths: [], description: "Calculate only" }, intendedUsers: ["builder"], recreation: "recreatable",
};

test("dynamic source capture rejects obvious escape APIs and embedded credentials without evaluating source", async () => {
  for (const source of ["async () => fetch('remote')", "() => Bun.file('local')", "() => process.env", "() => require('fs')", "() => tool(()=>1,{name:'nested'})", "() => agent('new worker')", "() => Function('return 1')()", "() => { const api_key = 'fixture-credential-placeholder'; return 1; }"]) {
    const report = inspectProposal({ ...proposal, source });
    assert.equal(report.allowed, false, source);
    assert.ok(report.violations.length);
  }
  assert.equal(inspectProposal({ ...proposal, source: "async ({path}) => await tool.read({path})" }).allowed, true);
  assert.equal(inspectProposal(proposal, ["calculate"]).allowed, false);
  assert.throws(() => inspectProposal({ ...proposal, parameters: { $ref: "https://invalid/schema" } }), /External schema/);
  const runPath = await mkdtemp(join(tmpdir(), "supership-tools-"));
  const captured = await captureProposal(proposal, { runPath, existingNames: [] });
  assert.equal(await readCapturedSource(runPath, captured), proposal.source);
  await writeFile(join(runPath, captured.sourceRef.uri), "() => 99");
  await assert.rejects(readCapturedSource(runPath, captured), /changed/);
});

test("source, schema, initialization, effects and recipient changes invalidate approval; kernel loss and stale work revoke grants", async () => {
  const runPath = await mkdtemp(join(tmpdir(), "supership-tools-"));
  const captured = await captureProposal(proposal, { runPath, existingNames: [] });
  const grants = [{ workId: "build", workRevision: 1, seatId: "builder" }];
  const scope = toolApprovalScope(captured, grants);
  assert.notEqual(toolApprovalScope({ ...captured, schemaHash: "a".repeat(64) }, grants), scope);
  assert.notEqual(toolApprovalScope({ ...captured, sourceHash: "a".repeat(64) }, grants), scope);
  assert.notEqual(toolApprovalScope(captured, [...grants, { workId: "other", workRevision: 1, seatId: "builder" }]), scope);
  assert.notEqual(toolApprovalScope({ ...captured, effects: { ...captured.effects, kind: "unknown" } }, grants), scope);
  const definition: ToolDefinitionRecord = { ...captured, version: 1, grants, approvalId: "approved", approvalScopeHash: scope, parent: { cwd: runPath, sessionId: "parent", ownerEpoch: 1 }, kernelGeneration: 2, registration: "registered", runtimeName: "run_calculate", evidence: [] };
  const work: WorkItem = { schemaVersion: 1, id: "build", revision: 1, kind: "build", dependencies: [], seatId: "builder", expectedPaths: [], expectedOutputs: [], verificationCheckIds: [], mutation: "parent-access", isolation: { kind: "active-checkout" }, toolGrants: [{ name: "calculate", version: 1, approvalId: "approved" }], outputSchema: { name: "build", version: 1 }, instructions: "Calculate", evidence: [], attempt: { id: "attempt", number: 1, validationStage: "initial", seatId: "builder" }, status: "pending", runtimeOwners: [] };
  assert.equal(validateGrant(definition, work, 2).valid, true);
  assert.equal(validateGrant(definition, work, 3).valid, false);
  assert.equal(validateGrant(definition, { ...work, revision: 2 }, 2).valid, false);
  assert.equal(validateGrant({ ...definition, grants: [...grants, { workId: "other", workRevision: 1, seatId: "builder" }] }, work, 2).valid, false);
  assert.equal(validateGrant({ ...definition, registration: "unavailable" }, work, 2).valid, false);
});
