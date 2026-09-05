import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { migrationPolicy } from "../src/install.ts";
import type { InstallManifest, InstallPlan, RollbackPlan } from "../src/install.ts";
import { shareNativeCache } from "./support/native-cache.ts";

const aliases = ["supership", "shipit", "ultraship", "ultrashipit", "superreview"];

test("Crust parsing and confirmed migration use actual native OMP discovery offline", () => {
    const home = mkdtempSync(join(tmpdir(), "supership-cli-"));
    shareNativeCache(home);
    const launcher = join(home, "deny-network");
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const omp = Bun.which("omp");
    assert.ok(omp, "installed OMP is required for the managed CLI proof");
    const environment = { HOME: home, TMPDIR: home, PATH: `${dirname(omp)}:${dirname(process.execPath)}:/usr/bin:/bin`, LC_ALL: "C", NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1", OMP_DISABLE_AUTO_UPDATE: "1" };
    const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
    const execute = (argv: string[], mask?: "0002" | "0077") => spawnSync(launcher, [...(mask ? ["/bin/sh", "-c", `umask ${mask}; exec "$@"`, "umask-fixture"] : []), process.execPath, cli, ...argv], { env: environment, cwd: home, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const succeeds = (argv: string[], mask?: "0002" | "0077") => {
        const result = execute(argv, mask); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    try {
        const compile = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, join(import.meta.dir, "support/deny-network.c")], { env: environment, encoding: "utf8" });
        assert.equal(compile.status, 0, compile.stderr);
        assert.match(succeeds([]), /supership/);
        assert.match(succeeds(["--version"]), /^supership v/);
        for (const command of ["install", "doctor", "migrate", "export", "cleanup"]) assert.match(succeeds([command, "--help"]), new RegExp(command));
        for (const argv of [["--unknown"], ["unknown"], ["install", "--unknown"], ["install", "--dry-run=true"], ["doctor", "extra"], ["doctor", "--", "extra"], ["export"], ["cleanup"], ["install", "--manifest"]]) {
            const result = execute(argv); assert.equal(result.status, 1, `${argv.join(" ")}: ${result.stdout}\n${result.stderr}`); assert.match(result.stderr, /Error:/);
        }
        const packageRoot = join(home, "canonical"), global = join(home, ".omp/agent"), pluginRoot = join(home, ".omp/plugins"), backupRoot = join(home, "rollback");
        const siftly = join(home, "siftly/.omp"), palmyra = join(home, "palmyra/.omp");
        for (const path of [packageRoot, pluginRoot, join(global, "commands"), join(siftly, "commands"), join(palmyra, "commands"), join(packageRoot, "omp/agents")]) mkdirSync(path, { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-supership", version: "1.0.0", type: "module", omp: { extensions: ["./extension.ts"] } }));
        writeFileSync(join(packageRoot, "extension.ts"), `import { readFileSync } from "node:fs"; export default function(api) { for (const root of ${JSON.stringify([global, siftly, palmyra])}) { const policy=JSON.parse(readFileSync(root+"/supership.json","utf8")); if (policy.schemaVersion!==1) throw new Error("Missing migration policy"); } for (const name of ${JSON.stringify(aliases)}) api.registerCommand(name, { description: "canonical ownership fixture", handler: async () => { throw new Error("Discovery fixture does not run workflows"); } }); }`);
        const registryPath = join(pluginRoot, "omp-plugins.lock.json");
        const priorRegistry = JSON.stringify({ plugins: { other: { version: "9.0.0", enabled: false, enabledFeatures: [] } }, settings: { other: { marker: "UNRELATED_SECRET_MARKER" } } }, null, 2);
        writeFileSync(registryPath, priorRegistry);
        writeFileSync(join(packageRoot, "omp/agents/review-orchestrator.md"), "protected source review\n", { mode: 0o600 });
        writeFileSync(join(packageRoot, "omp/agents/kimi-reviewer.md"), "protected source kimi\n"); chmodSync(join(packageRoot, "omp/agents/kimi-reviewer.md"), 0o640); // launcher umask must not mask the fixture mode
        writeFileSync(join(global, "config.yml"), "untouched: USER_SETTINGS_SECRET\n");
        writeFileSync(join(siftly, "commands/check.md"), "unrelated Siftly check\n");
        writeFileSync(join(palmyra, "commands/check.md"), "unrelated Palmyra check\n");
        const manifest: InstallManifest = { schemaVersion: 1, roots: [{ id: "canonical", path: packageRoot, kind: "canonical" }, { id: "global", path: global, kind: "global" }, { id: "siftly", path: siftly, kind: "repository" }, { id: "palmyra", path: palmyra, kind: "repository" }], backupRoot, entries: [], registration: { canonicalRoot: packageRoot, pluginRoot, packageName: "fixture-supership", version: "1.0.0", packageDigest: hash(readFileSync(join(packageRoot, "package.json"))) } };
        for (const [id, path] of [["global", global], ["siftly", siftly], ["palmyra", palmyra]]) {
            for (const alias of aliases) {
                const content = `${id} legacy ${alias}\n`; writeFileSync(join(path!, "commands", `${alias}.md`), content);
                manifest.entries.push({ root: id!, relativePath: `commands/${alias}.md`, baselineDigests: [hash(content)], protected: false, provenance: "Synthetic inventory fixture", effect: { kind: "remove" } });
            }
        }
        for (const name of ["review-orchestrator", "kimi-reviewer"]) manifest.entries.push({ root: "canonical", relativePath: `omp/agents/${name}.md`, baselineDigests: [], protected: true, provenance: "Protected source fixture", effect: { kind: "remove" } });
        for (const name of ["planner", "task", "deep-reviewer", "review-orchestrator", "deep-debugger", "david-research"]) {
            mkdirSync(join(siftly, "agents"), { recursive: true }); writeFileSync(join(siftly, "agents", name + ".md"), "preserved Siftly specialist policy " + name);
        }
        writeFileSync(join(siftly, "APPEND_SYSTEM.md"), "preserved Siftly data safety"); writeFileSync(join(siftly, "RULES.md"), "preserved Siftly rules");
        for (const name of ["regen", "add-migration", "e2e-local"]) writeFileSync(join(palmyra, "commands", name + ".md"), "preserved Palmyra " + name);
        for (const [profile, root] of [["global", global], ["siftly", siftly], ["palmyra", palmyra]] as const) {
            const policy = migrationPolicy(profile, root);
            manifest.entries.push({ root: profile, relativePath: "supership.json", baselineDigests: [], protected: false, provenance: "Converted inventory policy", effect: { kind: "write", mode: 0o600, content: Buffer.from(JSON.stringify(policy)).toString("base64") } });
            for (const reference of policy.instructionRefs) manifest.entries.push({ root: profile, relativePath: reference.uri, baselineDigests: [reference.digest!], protected: false, provenance: "Required preserved policy source", effect: { kind: "preserve" } });
        }
        const manifestPath = join(home, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
        const sdkPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/index.ts");
        const probe = (after: boolean) => {
            const script = `import assert from "node:assert/strict";
import { discoverSlashCommands, discoverAndLoadExtensions } from ${JSON.stringify(sdkPath)};
const aliases=${JSON.stringify(aliases)};
for (const [label,cwd] of ${JSON.stringify([["global", home], ["siftly", dirname(siftly)], ["palmyra", dirname(palmyra)]])}) {
 const commands=await discoverSlashCommands({cwd});
 for(const name of aliases) { const found=commands.filter(command=>command.name===name); if (${after}) assert.equal(found.length,0,label+":"+name); else {assert.equal(found.length,1,label+":"+name);assert.match(found[0].content,new RegExp(label+" legacy"));} }
 const result=await discoverAndLoadExtensions([],cwd,undefined,[],{includeAmbientHooks:false}); assert.deepEqual(result.errors,[]);
 for(const name of aliases) assert.equal(result.extensions.filter(extension=>extension.commands.has(name)).length,${after ? 1 : 0},label+":"+name);
}
console.log("discovery passed");`;
            const result = spawnSync(launcher, [process.execPath, "-e", script], { env: environment, cwd: home, encoding: "utf8", timeout: 120000 });
            assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /discovery passed/);
        };
        probe(false);
        const preview = JSON.parse(succeeds(["migrate", "--manifest", manifestPath])) as InstallPlan;
        assert.ok(!JSON.stringify(preview).includes("UNRELATED_SECRET_MARKER"));
        assert.ok(!JSON.stringify(preview).includes("USER_SETTINGS_SECRET"));
        assert.equal(readFileSync(registryPath, "utf8"), priorRegistry);
        assert.equal(existsSync(join(pluginRoot, "node_modules/fixture-supership")), false);
        assert.equal(existsSync(backupRoot), false);
        const denied = execute(["migrate", "--manifest", manifestPath, "--apply", "--confirm", preview.digest]);
        assert.equal(denied.status, 1); assert.match(denied.stderr, /Final per-file confirmation required/);
        assert.equal(existsSync(backupRoot), false);
        const files = preview.operations.flatMap(operation => operation.confirmation ? ["--confirm-file", operation.confirmation] : []);
        const applyArgs = ["migrate", "--manifest", manifestPath, "--apply", "--confirm", preview.digest, ...files];
        succeeds([...applyArgs, "--dry-run"]);
        assert.equal(existsSync(backupRoot), false);
        const failBin = join(home, "failing-omp"), realPath = environment.PATH;
        mkdirSync(failBin); writeFileSync(join(failBin, "omp"), "#!/bin/sh\nexit 23\n", { mode: 0o700 });
        environment.PATH = failBin + ":" + realPath;
        const failed = execute(applyArgs);
        environment.PATH = realPath;
        assert.equal(failed.status, 1); assert.match(failed.stderr, /OMP plugin link failed/);
        const failureJournal = join(backupRoot, preview.digest, "rollback.json");
        assert.equal(JSON.parse(readFileSync(failureJournal, "utf8")).status, "failed");
        assert.equal(readFileSync(registryPath, "utf8"), priorRegistry);
        assert.equal(existsSync(join(global, "commands/supership.md")), false);
        assert.equal(JSON.parse(succeeds(["migrate", "--recover", failureJournal])).digest, preview.digest);
        assert.equal(execute(["migrate", "--recover", failureJournal, "--apply", "--confirm", "wrong"]).status, 1);
        const applied = execute(["migrate", "--recover", failureJournal, "--apply", "--confirm", preview.digest, ...files]);
        assert.equal(applied.status, 0, applied.stderr); assert.match(applied.stderr, /CAUTION:/);
        assert.equal(readlinkSync(join(pluginRoot, "node_modules/fixture-supership")), packageRoot);
        const afterRegistry = JSON.parse(readFileSync(registryPath, "utf8"));
        assert.deepEqual(afterRegistry.settings, JSON.parse(priorRegistry).settings);
        assert.deepEqual(afterRegistry.plugins.other, JSON.parse(priorRegistry).plugins.other);
        assert.deepEqual(afterRegistry.plugins["fixture-supership"], { version: "1.0.0", enabledFeatures: null, enabled: true });
        assert.equal(readFileSync(join(siftly, "commands/check.md"), "utf8"), "unrelated Siftly check\n");
        assert.equal(readFileSync(join(global, "config.yml"), "utf8"), "untouched: USER_SETTINGS_SECRET\n");
        probe(true);
        const repeat = JSON.parse(succeeds(["install", "--manifest", manifestPath])) as InstallPlan;
        assert.ok(repeat.operations.every(operation => operation.action === "preserve"));
        const beforeRepeat = readFileSync(registryPath);
        succeeds(["install", "--manifest", manifestPath, "--apply", "--confirm", repeat.digest]);
        assert.deepEqual(readFileSync(registryPath), beforeRepeat);
        const journal = join(backupRoot, preview.digest, "rollback.json");
        const rollback = JSON.parse(succeeds(["migrate", "--rollback", journal])) as RollbackPlan;
        assert.notEqual(rollback.digest, preview.digest);
        assert.deepEqual(rollback.blockers, []);
        assert.equal(rollback.operations[0]!.path, registryPath);
        assert.equal(rollback.operations[0]!.current!.digest, hash(beforeRepeat));
        assert.equal(rollback.operations[0]!.restore.digest, hash(priorRegistry));
        assert.ok(!JSON.stringify(rollback).includes("UNRELATED_SECRET_MARKER"));
        assert.ok(!JSON.stringify(rollback).includes("USER_SETTINGS_SECRET"));
        const journalBytes = readFileSync(journal);
        assert.deepEqual(JSON.parse(succeeds(["migrate", "--rollback", journal, "--dry-run"])), rollback);
        assert.deepEqual(JSON.parse(succeeds(["migrate", "--rollback", journal, "--confirm", rollback.digest])), rollback);
        assert.deepEqual(JSON.parse(succeeds(["migrate", "--rollback", journal, "--apply", "--dry-run"])), rollback);
        succeeds(["migrate", "--rollback", journal, "--apply", "--confirm", rollback.digest, "--dry-run"]);
        assert.equal(execute(["migrate", "--rollback", journal, "--apply"]).status, 1);
        assert.equal(execute(["migrate", "--rollback", journal, "--apply", "--confirm", preview.digest]).status, 1);
        for (const extra of [["--manifest", manifestPath], ["--recover", journal], ["--plan", journal], ["--agent-root", global], ["--confirm-file", "ignored"]]) assert.equal(execute(["migrate", "--rollback", journal, ...extra]).status, 1);
        assert.equal(execute(["install", "--rollback", journal]).status, 1);
        assert.deepEqual(readFileSync(journal), journalBytes);
        assert.deepEqual(readFileSync(registryPath), beforeRepeat);
        const editedRegistry = { ...afterRegistry, settings: { ...afterRegistry.settings, later: { keep: true } } };
        writeFileSync(registryPath, JSON.stringify(editedRegistry));
        const blockedRollback = execute(["migrate", "--rollback", journal, "--dry-run"]);
        assert.equal(blockedRollback.status, 1);
        const blockedPlan = JSON.parse(blockedRollback.stdout) as RollbackPlan;
        assert.ok(blockedPlan.blockers.some(message => message.includes("Unreviewed edit")));
        assert.equal(execute(["migrate", "--rollback", journal, "--apply", "--confirm", blockedPlan.digest]).status, 1);
        assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), editedRegistry);
        assert.equal(existsSync(join(global, "commands/supership.md")), false);
        writeFileSync(registryPath, beforeRepeat);
        succeeds(["migrate", "--rollback", journal, "--apply", "--confirm", rollback.digest]);
        assert.equal(readFileSync(registryPath, "utf8"), priorRegistry);
        assert.equal(lstatSync(join(packageRoot, "omp/agents/review-orchestrator.md")).mode & 0o777, 0o600);
        assert.equal(lstatSync(join(packageRoot, "omp/agents/kimi-reviewer.md")).mode & 0o777, 0o640);
        probe(false);
        const completeRollback = JSON.parse(succeeds(["migrate", "--rollback", journal])) as RollbackPlan;
        assert.ok(completeRollback.operations.every(operation => operation.action === "preserve"));
        succeeds(["migrate", "--rollback", journal, "--apply", "--confirm", completeRollback.digest]);
        const savedRegistry = registryPath + ".fixture-backup"; renameSync(registryPath, savedRegistry);
        const freshManifestPath = join(home, "fresh-manifest.json"); writeFileSync(freshManifestPath, JSON.stringify({ ...manifest, entries: [] }));
        for (const mask of ["0002", "0077"] as const) {
            const fresh = JSON.parse(succeeds(["install", "--manifest", freshManifestPath], mask)) as InstallPlan;
            succeeds(["install", "--manifest", freshManifestPath, "--apply", "--confirm", fresh.digest], mask);
            assert.equal(lstatSync(registryPath).mode & 0o777, mask === "0002" ? 0o664 : 0o600);
            const freshJournal = join(backupRoot, fresh.digest, "rollback.json");
            const inverse = JSON.parse(succeeds(["migrate", "--rollback", freshJournal], mask)) as RollbackPlan;
            assert.deepEqual(inverse.blockers, []);
            succeeds(["migrate", "--rollback", freshJournal, "--apply", "--confirm", inverse.digest], mask);
            assert.equal(existsSync(registryPath), false);
            assert.equal(existsSync(join(pluginRoot, "node_modules/fixture-supership")), false);
        }
        renameSync(savedRegistry, registryPath);
        // Real OMP succeeds, then a wrapper changes two targets before post-effect verification.
        const postPath = join(global, "post-effect.bin"), postBefore = Buffer.from([65, 0, 255, 10]);
        writeFileSync(postPath, postBefore); chmodSync(postPath, 0o640);
        const postManifest: InstallManifest = { ...manifest, entries: [{ root: "global", relativePath: "post-effect.bin", baselineDigests: [hash(postBefore)], protected: false, provenance: "Post-effect failure fixture", effect: { kind: "write", content: Buffer.from("replacement").toString("base64"), mode: 0o600 } }] };
        const postManifestPath = join(home, "post-effect-manifest.json"); writeFileSync(postManifestPath, JSON.stringify(postManifest));
        const postForward = JSON.parse(succeeds(["install", "--manifest", postManifestPath])) as InstallPlan;
        writeFileSync(join(failBin, "omp"), `#!/bin/sh
${JSON.stringify(omp)} "$@" || exit "$?"
printf '\\n' >> "$HOME/.omp/plugins/omp-plugins.lock.json"
printf '\\377' >> ${JSON.stringify(postPath)}
chmod 604 ${JSON.stringify(postPath)}
`, { mode: 0o700 });
        environment.PATH = failBin + ":" + realPath;
        const postFailed = execute(["install", "--manifest", postManifestPath, "--apply", "--confirm", postForward.digest]);
        environment.PATH = realPath;
        assert.equal(postFailed.status, 1); assert.match(postFailed.stderr, /OMP plugin link produced unexpected bytes/);
        const postJournal = join(backupRoot, postForward.digest, "rollback.json"), postJournalBytes = readFileSync(postJournal);
        const postRecorded = JSON.parse(postJournalBytes.toString("utf8")); assert.equal(postRecorded.status, "failed");
        assert.equal(readlinkSync(join(pluginRoot, "node_modules/fixture-supership")), packageRoot);
        const postCurrent = readFileSync(postPath), postRegistry = readFileSync(registryPath);
        assert.notDeepEqual(postCurrent, postBefore);
        assert.equal(lstatSync(postPath).mode & 0o777, 0o604);
        const postPreview = execute(["migrate", "--rollback", postJournal]); assert.equal(postPreview.status, 1);
        const postRollback = JSON.parse(postPreview.stdout) as RollbackPlan;
        const changed = postRollback.operations.filter(operation => operation.confirmation);
        assert.deepEqual(changed.map(operation => operation.path).sort(), [postPath, registryPath].sort());
        const postOperation = changed.find(operation => operation.path === postPath)!;
        assert.ok(postOperation.diff.includes(postBefore.toString("base64")) && postOperation.diff.includes(postCurrent.toString("base64")));
        assert.equal(postOperation.restore.mode, 0o640); assert.equal(postOperation.current!.mode, 0o604);
        const registryOperation = changed.find(operation => operation.path === registryPath)!;
        assert.ok(registryOperation.diff.includes("UNRELATED_SECRET_MARKER"));
        assert.equal(registryOperation.backupSnapshot!.digest, hash(priorRegistry));
        assert.deepEqual(JSON.parse(postRegistry.toString("utf8")).plugins.other, JSON.parse(priorRegistry).plugins.other);
        const postTokens = changed.flatMap(operation => ["--confirm-file", operation.confirmation!]);
        const postApply = ["migrate", "--rollback", postJournal, "--apply", "--confirm", postRollback.digest];
        for (const argv of [postApply, [...postApply, "--confirm-file", changed[0]!.confirmation!], ["migrate", "--rollback", postJournal, "--apply", "--confirm", postForward.digest, ...postTokens]]) assert.equal(execute(argv).status, 1);
        assert.deepEqual(readFileSync(postPath), postCurrent); assert.deepEqual(readFileSync(postJournal), postJournalBytes);
        const originalBackup = readFileSync(postOperation.backup!); writeFileSync(postOperation.backup!, "corrupt");
        const corruptPreview = execute(["migrate", "--rollback", postJournal]); assert.equal(corruptPreview.status, 1);
        const corruptPlan = JSON.parse(corruptPreview.stdout) as RollbackPlan;
        assert.ok(corruptPlan.blockers.some(message => message.includes("Rollback bytes changed")));
        assert.equal(execute([...postApply, ...postTokens]).status, 1);
        writeFileSync(postOperation.backup!, originalBackup);
        writeFileSync(registryPath, Buffer.concat([postRegistry, Buffer.from("\n")]));
        assert.equal(execute([...postApply, ...postTokens]).status, 1);
        assert.deepEqual(readFileSync(postPath), postCurrent);
        writeFileSync(registryPath, postRegistry);
        assert.equal(execute([...postApply, ...postTokens, "--dry-run"]).status, 1);
        assert.deepEqual(readFileSync(postPath), postCurrent);
        succeeds([...postApply, ...postTokens]);
        assert.deepEqual(readFileSync(postPath), postBefore); assert.equal(lstatSync(postPath).mode & 0o777, 0o640);
        assert.equal(readFileSync(registryPath, "utf8"), priorRegistry);
        assert.equal(existsSync(join(pluginRoot, "node_modules/fixture-supership")), false);
        assert.equal(JSON.parse(readFileSync(postJournal, "utf8")).status, "rolled-back");
        const postComplete = JSON.parse(succeeds(["migrate", "--rollback", postJournal])) as RollbackPlan;
        assert.ok(postComplete.operations.every(operation => operation.action === "preserve"));
        const legacy = join(home, ".planning/legacy"); mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, "plan.html"), "legacy remains readable");
        for (const command of ["export", "cleanup"]) {
            const result = execute([command, "--run", legacy]); assert.equal(result.status, 1); assert.match(result.stderr, /legacy|Legacy|state\.json/);
        }
        assert.equal(readFileSync(join(legacy, "plan.html"), "utf8"), "legacy remains readable");
        const runRoot = join(home, "runs"), runPath = join(runRoot, ".planning/cli-run");
        const storeSetup = spawnSync(launcher, [process.execPath, "-e", `
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { openWriter, createRun, transact, closeWriter } from ${JSON.stringify(resolve(import.meta.dir, "../src/store.ts"))};
import { startInput } from ${JSON.stringify(resolve(import.meta.dir, "core-fixtures.ts"))};
const root=${JSON.stringify(runRoot)}, path=${JSON.stringify(runPath)};
mkdirSync(root); const git=Bun.spawn(["git","init","--quiet",root]); assert.equal(await git.exited,0);
writeFileSync(root+"/.gitignore",".planning/\\n");
const writer=await openWriter(path,{sessionId:"session",purpose:"start"});
try {
 const input=startInput(root,"cli-run",writer.leaseId);
 const result=await createRun(writer,input,input.start.preflight); assert.equal(result.kind,"committed");
 const cancelled=await transact(writer,{kind:"request-cancel",reason:"fixture done",evidence:[]},{now:Date.now(),inputId:"cancel",ownerSessionId:"session",ownerEpoch:0}); assert.equal(cancelled.kind,"committed");
} finally { await closeWriter(writer); }
`], { env: environment, cwd: home, encoding: "utf8", timeout: 120000 });
        assert.equal(storeSetup.status, 0, storeSetup.stderr);
        const exported = succeeds(["export", "--run", runPath]);
        assert.match(exported, /run-cli-run/); assert.match(exported, /cancelled/);
        const cleanup = JSON.parse(succeeds(["cleanup", "--run", runPath]));
        assert.equal(execute(["cleanup", "--run", runPath, "--apply"]).status, 1);
        writeFileSync(join(runPath, "later-evidence"), "later unreviewed evidence");
        assert.equal(execute(["cleanup", "--run", runPath, "--apply", "--confirm", cleanup.digest]).status, 1);
        assert.ok(existsSync(join(runPath, "later-evidence")));
        const refreshed = JSON.parse(succeeds(["cleanup", "--run", runPath]));
        succeeds(["cleanup", "--run", runPath, "--apply", "--confirm", refreshed.digest, "--dry-run"]);
        assert.ok(existsSync(runPath));
        succeeds(["cleanup", "--run", runPath, "--apply", "--confirm", refreshed.digest]);
        assert.equal(existsSync(runPath), false);
        const doctor = execute(["doctor", "--cwd", packageRoot]);
        assert.ok(doctor.status === 0 || doctor.status === 1, doctor.stderr);
        const report = JSON.parse(doctor.stdout);
        assert.equal(report.expectedRange, ">=18.1.10 <18.2.0");
        assert.equal(report.checks.find((check: { name: string }) => check.name === "version")?.available, true, JSON.stringify(report));
        assert.ok(report.checks.length > 0);
        assert.equal(doctor.status, report.supported ? 0 : 1);
        writeFileSync(join(failBin, "omp"), "#!/bin/sh\nprintf 'omp v19.0.0\\n'\n", { mode: 0o700 });
        environment.PATH = failBin + ":" + realPath;
        const unsupported = execute(["doctor", "--cwd", packageRoot]);
        environment.PATH = realPath;
        assert.equal(unsupported.status, 1, unsupported.stderr);
        assert.equal(JSON.parse(unsupported.stdout).supported, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
}, 400000);
