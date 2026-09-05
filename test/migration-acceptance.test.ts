import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSchema, RunRecordSchema } from "../src/contracts.ts";
import { validatePlan } from "../src/engine.ts";
import type { ManagedInstallation } from "./fixtures/acceptance/migration.ts";
import { runScenario, type Evidence } from "./fixtures/acceptance/runner.ts";
import { commands, planFor, type Scenario } from "./fixtures/acceptance/scenarios.ts";

const evidence: Array<{ kind: ManagedInstallation; root: string; lifecycle?: string; phase?: string; packageDigest: string; outcome: "observed" | "passed" | "failed"; error?: string }> = [];
afterAll(() => {
  const output = process.env.SUPERSHIP_ACCEPTANCE_EVIDENCE ?? ".planning/migration-acceptance-evidence.json";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({
    kind: "scripted-software-integration", modelJudgmentProven: false,
    runtime: "Installed OMP 18.1.10 loads the migrated package only through its public plugin registry; the scripted provider is the sole configured extension",
    realInstallationsChanged: false, layouts: evidence,
  }, null, 2));
});

function registration(result: Evidence) {
  const event = result.events.find(event => event.event === "registration");
  assert.ok(event, `The migrated package registered no commands: ${result.root}`);
  const details = event.commandDetails ?? [];
  for (const command of commands) {
    const owners = details.filter(detail => detail.name === command);
    assert.equal(owners.length, 1, `/${command} must have exactly one owner after migration: ${JSON.stringify(owners)}`);
    assert.equal(owners[0]!.source, "extension", `/${command} is still owned by a prompt file: ${JSON.stringify(owners[0])}`);
  }
  // OMP 18.1.10 enumerates TypeScript, bundled and skill commands here; Markdown under commands/ is inert, so removed legacy files are proven on disk by the fixture and ownership by this single extension entry.
  assert.ok(event.tools?.includes("supership_next"), "The registered engine must expose its parent controls");
  return event;
}

for (const kind of ["global", "siftly", "palmyra"] as const) test(`managed ${kind} migration registers the real package and every alias resolves to the new engine`, async () => {
  const scenario: Scenario = { id: `managed-${kind}`, command: "shipit", builds: [{ id: "initial", path: "result.txt", content: "repaired result\n", initialContent: "initial result\n" }], findings: [["repair"], []], fixChanges: true };
  const result = await runScenario(scenario, { managedInstallation: kind });
  const migration = JSON.parse(readFileSync(join(result.root, "migration-evidence.json"), "utf8"));
  evidence.push({ kind, root: result.root, lifecycle: result.state?.lifecycle, phase: result.state?.phase, packageDigest: migration.packageDigest, outcome: "observed" });
  try {
    assert.ok(!readFileSync(join(result.root, "offline.yml"), "utf8").includes("extension.ts"), "The host configuration must not name the product extension; only the migrated registry may supply it");
    registration(result);
    assert.ok(result.state, `No durable run: ${result.root}`);
    assertSchema(RunRecordSchema, result.state);
    assert.deepEqual(result.events.filter(event => event.event === "fixture-error"), [], `Scripted provider failed: ${result.root}`);
    const state = result.state;
    assert.equal(state.repository.root, result.cwd);
    for (const requirement of migration.policy.phaseGates) assert.ok(state.policy.phaseGates.some((gate: { id: string }) => gate.id === requirement.id), `Migrated mandatory gate ${requirement.id} did not reach the run policy`);
    if (kind === "palmyra") {
      // Palmyra's unconditional Biome/license requirement has no executable fixture check, so every scripted plan is invalid output and the run stops before any builder.
      assert.equal(state.lifecycle, "blocked", `Palmyra must refuse at its mandatory gate: ${result.root}`);
      assert.equal(state.recovery?.primaryReason, "output-attempts-exhausted");
      assert.ok(state.recovery?.affectedWork.some(ref => state.work.some(work => work.id === ref.id && work.outputSchema.name === "plan")), "The exhausted output must be the plan");
      const packet = result.events.find(event => event.event === "provider" && event.packet?.assignment.outputSchema.name === "plan" && event.packet.assignment.context?.kind === "planning")?.packet;
      assert.ok(packet, `No planning packet reached the scripted architect: ${result.root}`);
      const issues = validatePlan(planFor(scenario, packet, result.cwd, state.baselineCode!), state).map(issue => issue.message);
      assert.ok(issues.some(message => message.includes("palmyra-always")), `The refusal must name the unconditional requirement: ${issues.join("; ")}`);
      for (const scoped of ["palmyra-go", "palmyra-contracts", "palmyra-domains", "palmyra-sdk", "palmyra-admin-cli"]) assert.ok(!issues.some(message => message.includes(scoped)), `Scoped requirement ${scoped} must not apply to a plan outside its paths: ${issues.join("; ")}`);
      assert.equal(issues.filter(message => message.includes("Required repository verification")).length, 1, `Only the unconditional requirement may block: ${issues.join("; ")}`);
      assert.equal(state.work.some(work => work.kind === "build"), false, "No builder may start behind a refused plan");
      assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "commit"), false);
      for (const row of evidence) if (row.root === result.root) row.outcome = "passed";
      return;
    }
    assert.equal(state.lifecycle, "completed", `Migrated ${kind} workflow stopped at ${state.phase}: ${result.root}`);
    assert.ok(state.work.some(work => work.kind === "fix" && work.status === "succeeded"));
    assert.equal(readFileSync(join(result.cwd, "result.txt"), "utf8"), "repaired result\n");
    for (const check of state.plan!.verificationChecks.filter(check => check.required)) {
      const verification = state.verification.find(item => item.checkId === check.id && item.outcome === "passed");
      assert.ok(verification, `Required runtime verification ${check.id} absent: ${result.root}`);
      assert.equal(verification.verifier.kind, "runtime");
      assert.deepEqual(verification.codeIdentity, state.code!.identity);
    }
    if (kind === "siftly") assert.ok(state.verification.some(item => item.checkId === "siftly-checks" && item.outcome === "passed"), "The migrated Siftly repository check must run for real");
    assert.equal(state.gitOutcomes.some(outcome => outcome.operation === "commit" || outcome.operation === "push"), false, "A run without --commit/--push must not publish");
    for (const row of evidence) if (row.root === result.root) row.outcome = "passed";
  } catch (error) {
    for (const row of evidence) if (row.root === result.root) { row.outcome = "failed"; row.error = String(error); }
    throw error;
  }
}, 240000);
