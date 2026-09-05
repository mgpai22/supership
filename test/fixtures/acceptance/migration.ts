import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { assertSchema, type PolicyOverlay } from "../../../src/contracts.ts";
import { InstallPlanSchema, knownInstallManifest, migrationPolicy, type InstallPlan } from "../../../src/install.ts";
import { commands } from "./scenarios.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type ManagedInstallation = "global" | "siftly" | "palmyra";
export function prepareManagedInstallation(options: {
  kind: ManagedInstallation;
  root: string;
  repositoryRoot: string;
  packageRoot: string;
  agentDir: string;
  run: (argv: string[]) => string;
  launcher: string;
}): void {
  const { kind, root, repositoryRoot, packageRoot, agentDir, run, launcher } = options;
  const projectDir = join(repositoryRoot, ".omp"), pluginRoot = join(dirname(agentDir), "plugins"), backupRoot = join(root, "migration-backups");
  for (const path of [repositoryRoot, agentDir, pluginRoot, backupRoot]) assert.ok(relative(root, path) && !relative(root, path).startsWith(".."), "Managed migration may only target its temporary fixture");
  assert.notEqual(realpathSync(packageRoot), realpathSync(repositoryRoot), "The registered package must be separate from the fixture repository");
  const retained: Record<string, string> = {};
  const seed = (path: string, content: string, preserve = true) => {
    assert.ok(!existsSync(path), "Fixture seeding must not overwrite an existing file: " + path);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    if (preserve) retained[path] = hash(content);
  };
  const persona = (name: string) => `---\nname: ${name}\ndescription: Preserved fixture repository specialist\n---\nFollow the explicit assignment and preserved repository policy.\n`;
  for (const installRoot of new Set([agentDir, projectDir])) {
    seed(join(installRoot, "agents", "user-note.md"), persona("user-note"));
    seed(join(installRoot, "commands", "user-check.md"), "Preserved unrelated user command.\n");
    seed(join(installRoot, "APPEND_SYSTEM.md"), "Preserve user data and explicit approval requirements.\n");
    seed(join(installRoot, "RULES.md"), "Do not change credentials or publish fixture data.\n");
  }
  retained[join(agentDir, "config.yml")] = hash(readFileSync(join(agentDir, "config.yml")));
  seed(join(projectDir, "config.yml"), "# Unrelated repository settings survive migration.\nmodelRoles:\n  fixture-user: openai-codex/acceptance-worker\n");
  if (kind === "siftly") for (const name of ["planner", "task", "deep-reviewer", "review-orchestrator", "deep-debugger", "david-research"]) seed(join(projectDir, "agents", name + ".md"), persona(name));
  if (kind === "palmyra") for (const name of ["check", "regen", "add-migration", "e2e-local"]) seed(join(projectDir, "commands", name + ".md"), `Preserved Palmyra ${name} fixture guidance. Keep all migrationPolicy requirements. Never execute destructive examples automatically.\n`);

  const priorRegistry = { plugins: { "unrelated-disabled": { version: "9.0.0", enabled: false, enabledFeatures: [] } }, settings: { "unrelated-disabled": { userChoice: "preserve" } } };
  const registryPath = join(pluginRoot, "omp-plugins.lock.json");
  seed(registryPath, JSON.stringify(priorRegistry, null, 2), false);
  const shadowRoots = kind === "global" ? [agentDir] : [agentDir, projectDir];
  const legacy: Record<string, string> = {};
  for (const installRoot of shadowRoots) for (const name of commands) {
    const path = join(installRoot, "commands", name + ".md");
    const content = `---\ndescription: OLD_OWNER_${kind}_${name}\n---\nOLD_OWNER_${kind}_${name}: retired Supership command.\n${name === "supership" || name === "superreview" ? "User-modified read-and-extend wrapper: preserve its reviewed rollback bytes.\n" : ""}`;
    seed(path, content, false); legacy[path] = content;
  }

  const policyPath = join(projectDir, "supership.json"), originalPolicy: PolicyOverlay = JSON.parse(readFileSync(policyPath, "utf8"));
  const policy = migrationPolicy(kind, kind === "global" ? agentDir : projectDir);
  const fixturePolicy = structuredClone(originalPolicy);
  for (const seat of policy.seats) if (!fixturePolicy.seats.some(existing => existing.seatId === seat.seatId)) fixturePolicy.seats.push({ seatId: seat.seatId, agentName: "task", model: "openai-codex/acceptance-worker" });
  for (const seatId of policy.requiredLenses) if (!fixturePolicy.seats.some(existing => existing.seatId === seatId)) fixturePolicy.seats.push({ seatId, agentName: "reviewer", model: "openai-codex/acceptance-worker" });
  if (kind === "siftly") {
    const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
    assert.ok(existsSync(tsc), "The real package TypeScript dependency is required");
    seed(join(repositoryRoot, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { typecheck: `bun ${JSON.stringify(tsc)} --ignoreConfig --strict --noEmit --skipLibCheck --types bun --typeRoots ${JSON.stringify(join(packageRoot, "node_modules", "@types"))} fixture.ts`, test: "bun test fixture.test.ts" } }, null, 2) + "\n");
    seed(join(repositoryRoot, "fixture.ts"), "export const baseline: string = \"user baseline\\n\";\n");
    seed(join(repositoryRoot, "fixture.test.ts"), "import { test, expect } from \"bun:test\";\nimport { baseline } from \"./fixture.ts\";\ntest(\"repository baseline is preserved\", async () => { expect(await Bun.file(\"baseline.txt\").text()).toBe(baseline); });\n");
    const requirement = policy.requiredVerification!.find(check => check.id === "siftly-checks")!;
    fixturePolicy.verificationChecks.push({ id: requirement.id, description: requirement.description, scopePaths: requirement.scopePaths, required: true, source: [], scenario: { kind: "command", cwd: repositoryRoot, command: ["/bin/sh", "-ec", "bun run typecheck && bun run test"] } });
  }
  // The scripted model supplies run-local seats and executable repository checks, never approval or workflow state.
  writeFileSync(policyPath, JSON.stringify(fixturePolicy));
  const manifest = knownInstallManifest({ canonicalRoot: packageRoot, agentRoot: agentDir, pluginRoot, backupRoot, repositories: kind === "global" ? [] : [{ profile: kind, root: projectDir }], includeProtected: false });
  // These reviewed sentinels are fixture data, not invented production ownership digests.
  for (const [path, content] of Object.entries(legacy)) {
    const entry = manifest.entries.find(entry => join(manifest.roots.find(root => root.id === entry.root)!.path, entry.relativePath) === path);
    assert.ok(entry, "The known inventory must name every legacy alias");
    entry.effect = { kind: "remove" };
    entry.baselineDigests = [hash(content.replace("User-modified read-and-extend wrapper: preserve its reviewed rollback bytes.\n", ""))];
    entry.provenance = "Explicitly reviewed temporary legacy alias; exact original bytes retained in migration evidence";
    const blocker = `Uninventoried workflow requires an explicit reviewed policy mapping: ${path}`;
    assert.ok(manifest.blockers?.includes(blocker));
    manifest.blockers = manifest.blockers!.filter(message => message !== blocker);
  }
  assert.deepEqual(manifest.blockers, []);
  const manifestPath = join(root, "migration-manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const cliCommands: Array<{ argv: string[]; stdout: string }> = [];
  const cli = (args: string[]): InstallPlan => {
    const argv = [launcher, process.execPath, join(packageRoot, "src", "cli.ts"), ...args];
    const stdout = run(argv); cliCommands.push({ argv, stdout });
    // The CLI prints the reviewed plan first; apply appends its result document after the plan.
    const value: unknown = JSON.parse(stdout.slice(0, stdout.indexOf("\n}\n") + 2)); assertSchema(InstallPlanSchema, value); return value;
  };
  const bytes = (path: string): Record<string, string> => {
    if (!existsSync(path)) return {};
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { [path]: `link:${readlinkSync(path)}` };
    if (info.isDirectory()) return Object.assign({}, ...readdirSync(path).sort().map(name => bytes(join(path, name))));
    return { [path]: `${info.mode & 0o777}:${hash(readFileSync(path))}` };
  };
  const installation = () => Object.assign({}, ...[agentDir, projectDir, pluginRoot, backupRoot].map(bytes));
  const before = installation(), preview = cli(["migrate", "--manifest", manifestPath, "--dry-run"]);
  assert.deepEqual(preview.blockers, []); assert.deepEqual(installation(), before, "Dry-run changed installation bytes");
  for (const [path, content] of Object.entries(legacy)) {
    const operation = preview.operations.find(operation => operation.path === path)!;
    assert.equal(operation.action, "remove");
    if (content.includes("User-modified")) { assert.ok(operation.confirmation); assert.ok(operation.diff.includes("-User-modified read-and-extend wrapper")); }
  }
  const confirmations = preview.operations.flatMap(operation => operation.confirmation ? ["--confirm-file", operation.confirmation] : []);
  cli(["migrate", "--manifest", manifestPath, "--apply", "--confirm", preview.digest, ...confirmations, "--dry-run"]);
  assert.deepEqual(installation(), before, "Apply with dry-run changed installation bytes");
  cli(["migrate", "--manifest", manifestPath, "--apply", "--confirm", preview.digest, ...confirmations]);
  for (const path of Object.keys(legacy)) assert.equal(existsSync(path), false, "An old active command owner survived: " + path);
  for (const [path, digest] of Object.entries(retained)) assert.equal(hash(readFileSync(path)), digest, "Migration changed unrelated fixture bytes: " + path);
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.deepEqual(registry.settings, priorRegistry.settings); assert.deepEqual(registry.plugins["unrelated-disabled"], priorRegistry.plugins["unrelated-disabled"]);
  assert.equal(realpathSync(join(pluginRoot, "node_modules", manifest.registration!.packageName)), realpathSync(packageRoot));
  const journalPath = join(backupRoot, preview.digest, "rollback.json"), journal = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.equal(journal.status, "applied");
  for (const [path, content] of Object.entries(legacy)) {
    const backup = journal.backups.find((entry: { path: string }) => entry.path === path)?.backup;
    assert.ok(backup?.startsWith(backupRoot + "/")); assert.equal(readFileSync(backup, "utf8"), content);
  }
  const after = installation(), repeat = cli(["migrate", "--manifest", manifestPath, "--dry-run"]);
  assert.ok(repeat.operations.every(operation => operation.action === "preserve"), "Repeated migration is not idempotent");
  cli(["migrate", "--manifest", manifestPath, "--apply", "--confirm", repeat.digest]);
  assert.deepEqual(installation(), after, "Repeated migration changed bytes or backup history");
  const installedPolicy: PolicyOverlay = JSON.parse(readFileSync(kind === "global" ? join(agentDir, "supership.json") : policyPath, "utf8"));
  for (const field of ["phaseGates", "pathRouting", "requiredVerification", "instructionRefs"] as const) for (const requirement of policy[field] ?? []) assert.deepEqual(installedPolicy[field]?.find(item => item.id === requirement.id), requirement, "Migration dropped a mandatory policy rule");
  for (const seat of originalPolicy.seats) assert.deepEqual(JSON.parse(readFileSync(policyPath, "utf8")).seats.find((item: { seatId: string }) => item.seatId === seat.seatId), seat, "Migration changed run-local scripted routing");
  writeFileSync(join(root, "migration-evidence.json"), JSON.stringify({ kind, root, repositoryRoot, packageRoot: realpathSync(packageRoot), packageDigest: manifest.registration!.packageDigest, agentDir, pluginRoot, journalPath, retained, legacyDigests: Object.fromEntries(Object.entries(legacy).map(([path, content]) => [path, hash(content)])), preview, repeated: repeat, policy, cliCommands }, null, 2));
}
