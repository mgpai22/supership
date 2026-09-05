import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Apply checks run in a child with an isolated HOME and the same fail-closed network boundary as real OMP proofs.
test("managed migration preserves bytes, conflicts, discovery boundaries and recovery", () => {
    const home = mkdtempSync(join(tmpdir(), "supership-install-"));
    const launcher = join(home, "deny-network");
    const environment = { HOME: home, TMPDIR: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LC_ALL: "C" };
    try {
        const compile = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, join(import.meta.dir, "support/deny-network.c")], { env: environment, encoding: "utf8" });
        assert.equal(compile.status, 0, compile.stderr);
        const child = spawnSync(launcher, [process.execPath, "-e", `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyInstall, planInstall, planRollback, readInstallRecovery, rollbackInstall, migrationPolicy, knownInstallManifest } from ${JSON.stringify(join(import.meta.dir, "../src/install.ts"))};
const home = process.env.HOME;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = join(home, "source"), global = join(home, "global"), backups = join(home, "backups");
mkdirSync(join(root,"omp/agents"), { recursive: true }); mkdirSync(global);
const protectedBytes = Buffer.from([65, 10, 0, 255, 66]);
writeFileSync(join(root,"omp/agents/review-orchestrator.md"), protectedBytes, {mode:0o600});
writeFileSync(join(root,"omp/agents/kimi-reviewer.md"), "user kimi\\n"); chmodSync(join(root,"omp/agents/kimi-reviewer.md"),0o640); // launcher umask must not mask the fixture mode
writeFileSync(join(global,"APPEND_SYSTEM.md"), "MANAGED\\nKEEP SUFFIX\\n");
writeFileSync(join(global,"custom.json"), "UNRELATED_SECRET_MARKER");
const policyBytes=Buffer.from(JSON.stringify(migrationPolicy("global",global))+"\\n");
mkdirSync(join(root,".planning/old"),{recursive:true}); writeFileSync(join(root,".planning/old/plan.html"), "old dashboard");
const manifest = { schemaVersion:1, roots:[{id:"source",path:root,kind:"canonical"},{id:"global",path:global,kind:"global"}], backupRoot:backups, entries:[
 {root:"source",relativePath:"omp/agents/review-orchestrator.md",baselineDigests:[],protected:true,provenance:"protected modified source",effect:{kind:"remove"}},
 {root:"source",relativePath:"omp/agents/kimi-reviewer.md",baselineDigests:[],protected:true,provenance:"protected untracked source",effect:{kind:"remove"}},
 {root:"global",relativePath:"APPEND_SYSTEM.md",baselineDigests:[hash("MANAGED\\nKEEP SUFFIX\\n")],protected:false,provenance:"exact prefix",effect:{kind:"strip-prefix",prefix:Buffer.from("MANAGED\\n").toString("base64"),suffixDigest:hash("KEEP SUFFIX\\n")}},
 {root:"global",relativePath:"supership.json",baselineDigests:[],protected:false,provenance:"policy",effect:{kind:"write",content:policyBytes.toString("base64"),mode:0o600}},
]};
const plan = planInstall(manifest);
assert.equal(existsSync(backups),false); assert.equal(plan.operations[0].ownership,"protected");
assert.match(plan.operations[0].diff, /base64 bytes/); assert.match(plan.operations[1].diff,/user kimi/);
assert.ok(!JSON.stringify(plan).includes("UNRELATED_SECRET_MARKER"));
await assert.rejects(applyInstall(manifest,plan,{digest:"wrong",files:[]}),/Confirmation/);
await assert.rejects(applyInstall(manifest,plan,{digest:plan.digest,files:[plan.operations[0].confirmation]}),/Final per-file/);
assert.deepEqual(readFileSync(join(root,"omp/agents/review-orchestrator.md")),protectedBytes);
assert.equal(lstatSync(join(root,"omp/agents/review-orchestrator.md")).mode&0o777,0o600);
assert.equal(existsSync(backups),false);
const confirmations=plan.operations.flatMap(operation=>operation.confirmation?[operation.confirmation]:[]);
writeFileSync(join(root,"omp/agents/kimi-reviewer.md"), "new user edit");
await assert.rejects(applyInstall(manifest,plan,{digest:plan.digest,files:confirmations}),/changed since preview/);
assert.deepEqual(readFileSync(join(root,"omp/agents/review-orchestrator.md")),protectedBytes);
writeFileSync(join(root,"omp/agents/kimi-reviewer.md"), "user kimi\\n");
const obstacle=join(backups,plan.digest,"0.bytes"); mkdirSync(obstacle);
await assert.rejects(applyInstall(manifest,plan,{digest:plan.digest,files:confirmations}),/directory|EISDIR/);
assert.deepEqual(readFileSync(join(root,"omp/agents/review-orchestrator.md")),protectedBytes);
rmdirSync(obstacle);
const result=await applyInstall(manifest,plan,{digest:plan.digest,files:confirmations});
assert.equal(result.status,"applied"); assert.equal(existsSync(join(root,"omp/agents/kimi-reviewer.md")),false);
assert.equal(readFileSync(join(global,"APPEND_SYSTEM.md"),"utf8"),"KEEP SUFFIX\\n");
assert.equal(readFileSync(join(global,"custom.json"),"utf8"),"UNRELATED_SECRET_MARKER");
assert.equal(readFileSync(join(root,".planning/old/plan.html"),"utf8"),"old dashboard");
const journal=JSON.parse(readFileSync(result.journal,"utf8"));
const exactJournal=readFileSync(result.journal);
const rollback = planRollback(result.journal);
assert.notEqual(rollback.digest,plan.digest); assert.deepEqual(rollback.blockers,[]);
assert.deepEqual(rollback.operations.map(operation=>operation.path),[...journal.backups].reverse().map(backup=>backup.path));
assert.deepEqual(rollback.operations.map(operation=>operation.restore),[...journal.backups].reverse().map(backup=>backup.before));
assert.equal(rollback.operations[0].action,"remove"); assert.equal(rollback.operations[3].action,"write");
assert.match(rollback.operations[3].diff,/base64 bytes/); assert.equal(rollback.operations[3].restore.mode,0o600);
assert.deepEqual(readFileSync(result.journal),exactJournal);
await assert.rejects(rollbackInstall(result.journal,plan.digest),/preview checksum/);
const tampered=structuredClone(journal); tampered.backups[0].path=join(global,"custom.json"); writeFileSync(result.journal,JSON.stringify(tampered));
assert.throws(()=>planRollback(result.journal),/does not match reviewed paths/);
await assert.rejects(rollbackInstall(result.journal,rollback.digest),/does not match reviewed paths/);
assert.equal(readFileSync(join(global,"custom.json"),"utf8"),"UNRELATED_SECRET_MARKER"); writeFileSync(result.journal,exactJournal);
const exactBackup=readFileSync(journal.backups[0].backup); writeFileSync(journal.backups[0].backup,"corrupt backup");
assert.ok(planRollback(result.journal).blockers.some(message=>message.includes("Rollback bytes changed")));
await assert.rejects(rollbackInstall(result.journal,rollback.digest),/Rollback bytes changed/); writeFileSync(journal.backups[0].backup,exactBackup);
assert.deepEqual(readFileSync(journal.backups[0].backup),protectedBytes);
assert.equal(journal.backups[0].before.mode,0o600);
const savedBackup=journal.backups[0].backup+".saved"; renameSync(journal.backups[0].backup,savedBackup);
assert.ok(planRollback(result.journal).blockers.some(message=>message.includes("Rollback bytes changed")));
symlinkSync(savedBackup,journal.backups[0].backup);
await assert.rejects(rollbackInstall(result.journal,planRollback(result.journal).digest),/Rollback bytes changed/);
unlinkSync(journal.backups[0].backup); renameSync(savedBackup,journal.backups[0].backup);
assert.equal(planInstall(manifest).operations.every(operation=>operation.action==="preserve"),true);
assert.equal((await applyInstall(manifest,plan,{digest:plan.digest,files:confirmations})).status,"applied");
writeFileSync(join(global,"supership.json"),"external change");
const blocked=planRollback(result.journal); assert.notEqual(blocked.digest,rollback.digest);
assert.ok(blocked.blockers.some(message=>message.includes("Unreviewed edit")));
await assert.rejects(rollbackInstall(result.journal,blocked.digest),/Unreviewed edit/);
assert.equal(existsSync(join(root,"omp/agents/kimi-reviewer.md")),false);
writeFileSync(join(global,"supership.json"),policyBytes);
chmodSync(join(global,"supership.json"),0o640);
const modeChange=planRollback(result.journal); assert.ok(modeChange.blockers.some(message=>message.includes("Unreviewed edit")));
await assert.rejects(rollbackInstall(result.journal,modeChange.digest),/Unreviewed edit/);
chmodSync(join(global,"supership.json"),0o600);
const duringLock=rollbackInstall(result.journal,planRollback(result.journal).digest);
chmodSync(journal.backups[0].backup,0o640);
await assert.rejects(duringLock,/preview checksum/);
assert.equal(existsSync(join(root,"omp/agents/kimi-reviewer.md")),false);
chmodSync(journal.backups[0].backup,0o600);
const journalDuringLock=rollbackInstall(result.journal,planRollback(result.journal).digest);
writeFileSync(result.journal,JSON.stringify({...journal,error:"later journal update"}));
await assert.rejects(journalDuringLock,/preview checksum/);
assert.equal(existsSync(join(root,"omp/agents/kimi-reviewer.md")),false);
writeFileSync(result.journal,exactJournal);
const beforePartial=planRollback(result.journal);
// A prior interrupted rollback can leave an original snapshot already restored.
writeFileSync(join(root,"omp/agents/kimi-reviewer.md"),"user kimi\\n"); chmodSync(join(root,"omp/agents/kimi-reviewer.md"),0o640);
const partial=planRollback(result.journal);
assert.notEqual(partial.digest,beforePartial.digest);
assert.equal(partial.operations.find(operation=>operation.path.endsWith("kimi-reviewer.md")).action,"preserve");
await assert.rejects(rollbackInstall(result.journal,beforePartial.digest),/preview checksum/);
assert.equal((await rollbackInstall(result.journal,partial.digest)).status,"rolled-back");
const complete=planRollback(result.journal); assert.ok(complete.operations.every(operation=>operation.action==="preserve"));
await assert.rejects(rollbackInstall(result.journal,partial.digest),/preview checksum/);
assert.equal((await rollbackInstall(result.journal,complete.digest)).status,"unchanged");
writeFileSync(join(root,"omp/agents/kimi-reviewer.md"),"edit after rollback");
await assert.rejects(rollbackInstall(result.journal,planRollback(result.journal).digest),/Unreviewed edit/);
writeFileSync(join(root,"omp/agents/kimi-reviewer.md"),"user kimi\\n");
assert.deepEqual(readFileSync(join(root,"omp/agents/review-orchestrator.md")),protectedBytes);
assert.equal(lstatSync(join(root,"omp/agents/kimi-reviewer.md")).mode&0o777,0o640);
assert.equal(readFileSync(join(global,"APPEND_SYSTEM.md"),"utf8"),"MANAGED\\nKEEP SUFFIX\\n");
assert.equal(existsSync(join(global,"supership.json")),false);
const recovery=readInstallRecovery(result.journal); assert.deepEqual(recovery,{manifest,plan});
const reapplied=await applyInstall(recovery.manifest,recovery.plan,{digest:plan.digest,files:confirmations});
assert.equal(reapplied.status,"applied");
assert.deepEqual(readFileSync(journal.backups[0].backup),protectedBytes);
await rollbackInstall(result.journal,planRollback(result.journal).digest);
assert.deepEqual(readFileSync(join(root,"omp/agents/review-orchestrator.md")),protectedBytes);

for (const bad of [{...manifest,schemaVersion:2},{...manifest,unexpected:true},{...manifest,backupRoot:join(global,"agents/backups")},{...manifest,entries:[{...manifest.entries[0],relativePath:"../escape"}]},{...manifest,entries:[{...manifest.entries[0],protected:false}]}]) assert.throws(()=>planInstall(bad));
symlinkSync(join(home,"missing"),join(global,"danger"));
const linked={...manifest,entries:[{root:"global",relativePath:"danger",baselineDigests:[],protected:false,provenance:"explicit link replacement",effect:{kind:"remove"}}]};
const linkPlan=planInstall(linked); assert.equal(linkPlan.operations[0].before.kind,"symlink");
await assert.rejects(applyInstall(linked,linkPlan,{digest:linkPlan.digest,files:[]}),/per-file/);
const held=Bun.spawn(["flock","--exclusive","--nonblock","--no-fork",join(backups,"migration.lock"),"/bin/sh","-c","printf held; exec cat >/dev/null"],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
const lockReader=held.stdout.getReader(); assert.equal(new TextDecoder().decode((await lockReader.read()).value),"held"); lockReader.releaseLock();
await assert.rejects(applyInstall(linked,linkPlan,{digest:linkPlan.digest,files:[linkPlan.operations[0].confirmation]}),/Another migration holds/);
const lockInode=lstatSync(join(backups,"migration.lock")).ino; held.kill("SIGKILL"); await held.exited;

const linkResult=await applyInstall(linked,linkPlan,{digest:linkPlan.digest,files:[linkPlan.operations[0].confirmation]});
assert.equal(lstatSync(join(backups,"migration.lock")).ino,lockInode);
const linkRollback=planRollback(linkResult.journal); assert.equal(linkRollback.operations[0].action,"symlink"); assert.equal(linkRollback.operations[0].restore.linkTarget,join(home,"missing"));
await rollbackInstall(linkResult.journal,linkRollback.digest); assert.equal(readlinkSync(join(global,"danger")),join(home,"missing"));
assert.ok(planInstall({...linked,entries:[{...linked.entries[0],relativePath:"danger/escape"}]}).blockers.some(message=>message.includes(join(global,"danger/escape"))&&message.includes("Unsafe parent")));
assert.throws(()=>planInstall({...linked,entries:[{...linked.entries[0],relativePath:"."}]}));
writeFileSync(join(global,"APPEND_SYSTEM.md"),"CHANGED MANAGED\\nKEEP SUFFIX\\n");
assert.equal(planInstall(manifest).blockers.length,1);
writeFileSync(join(global,"APPEND_SYSTEM.md"),"MANAGED\\nMANAGED\\nKEEP SUFFIX\\n");
assert.equal(planInstall(manifest).blockers.length,1);

// An interrupted native registration leaves exact backups and supports a safe retry/rollback.
const packageRoot=join(home,"package"),pluginRoot=join(home,"wrong-plugin-root"); mkdirSync(packageRoot);
writeFileSync(join(packageRoot,"package.json"),JSON.stringify({name:"fixture-supership",version:"1.0.0",omp:{extensions:["./extension.ts"]}}));
writeFileSync(join(packageRoot,"extension.ts"),"export default function(){}\\n");
const failing={...manifest,entries:[{root:"global",relativePath:"partial",baselineDigests:[],protected:false,provenance:"fixture",effect:{kind:"write",content:Buffer.from("applied").toString("base64"),mode:0o600}}],registration:{canonicalRoot:packageRoot,pluginRoot,packageName:"fixture-supership",version:"1.0.0",packageDigest:hash(readFileSync(join(packageRoot,"package.json")))}};
const failurePlan=planInstall(failing);
await assert.rejects(applyInstall(failing,failurePlan,{digest:failurePlan.digest,files:[]}),/differs from reviewed target/);
const failureJournal=join(backups,failurePlan.digest,"rollback.json");
assert.equal(JSON.parse(readFileSync(failureJournal,"utf8")).status,"failed");
assert.equal(readFileSync(join(global,"partial"),"utf8"),"applied");
await rollbackInstall(failureJournal,planRollback(failureJournal).digest); assert.equal(existsSync(join(global,"partial")),false);

// A real filesystem write failure after the first inverse effect requires a fresh preview.
const largePath=join(global,"large"), smallPath=join(global,"small");
const largeBytes=Buffer.alloc(256*1024,65); writeFileSync(largePath,largeBytes); chmodSync(largePath,0o640);
const interruptManifest={...manifest,entries:[
 {root:"global",relativePath:"large",baselineDigests:[hash(largeBytes)],protected:false,provenance:"file size limit fixture",effect:{kind:"write",content:Buffer.from("replacement").toString("base64"),mode:0o600}},
 {root:"global",relativePath:"small",baselineDigests:[],protected:false,provenance:"first inverse effect",effect:{kind:"write",content:Buffer.from("remove first").toString("base64"),mode:0o600}},
]};
const interruptPlan=planInstall(interruptManifest);
const interrupted=await applyInstall(interruptManifest,interruptPlan,{digest:interruptPlan.digest,files:[]});
const inverse=planRollback(interrupted.journal);
const limited=Bun.spawnSync(["/bin/sh","-c",'ulimit -f 64; exec "$@"',"rollback-limit",process.execPath,"-e",
 'import {rollbackInstall} from '+JSON.stringify(${JSON.stringify(join(import.meta.dir, "../src/install.ts"))})+'; await rollbackInstall('+JSON.stringify(interrupted.journal)+','+JSON.stringify(inverse.digest)+');'
],{stdout:"pipe",stderr:"pipe"});
assert.notEqual(limited.exitCode,0);
assert.equal(existsSync(smallPath),false);
assert.equal(readFileSync(largePath,"utf8"),"replacement");
assert.equal(JSON.parse(readFileSync(interrupted.journal,"utf8")).status,"applied");
const remaining=planRollback(interrupted.journal); assert.deepEqual(remaining.blockers,[]);
assert.equal(remaining.operations[0].action,"preserve");
await assert.rejects(rollbackInstall(interrupted.journal,inverse.digest),/preview checksum/);
await rollbackInstall(interrupted.journal,remaining.digest);
assert.deepEqual(readFileSync(largePath),largeBytes); assert.equal(lstatSync(largePath).mode&0o777,0o640);

const siftly=join(home,"siftly/.omp"),palmyra=join(home,"palmyra/.omp");
for (const directory of [siftly,palmyra]) mkdirSync(join(directory,"commands"),{recursive:true});
mkdirSync(join(siftly,"agents"));
writeFileSync(join(siftly,"agents/task.md"),"custom task safety\\n",{mode:0o600});
writeFileSync(join(siftly,"agents/project-only.md"),"project only");
for(const path of ["check","regen","add-migration","e2e-local"]) writeFileSync(join(palmyra,"commands",path+".md"),"preserved policy "+path);
const policy=migrationPolicy("palmyra",palmyra);
assert.deepEqual(policy.requiredLenses,["layering","generated-purity","conventions"]);
assert.ok(policy.pathRouting.some(route=>route.seatId==="contracts-codegen"));
assert.ok(policy.pathRouting.some(route=>route.seatId==="commodity-frontend"));
assert.ok(policy.phaseGates.some(gate=>gate.requirement.kind==="consultation"&&gate.requirement.seatId==="go-domain-reviewer"));
assert.ok(policy.phaseGates.some(gate=>gate.requirement.kind==="dependency"));
assert.ok(JSON.stringify(policy).includes("-count=1 -short -timeout 300s"));
assert.ok(JSON.stringify(policy).includes("NEXT.sql"));
const customRequirement={id:"local-check",description:"Required repository-local check",scopePaths:["local/**"],instructions:"Use the local package verification commands.",source:[]};
writeFileSync(join(palmyra,"supership.json"),JSON.stringify({...policy,requiredVerification:[...policy.requiredVerification,customRequirement]}));
const knownOptions={canonicalRoot:packageRoot,agentRoot:join(home,"fresh-global"),pluginRoot:join(home,".omp/plugins"),backupRoot:join(home,"known-backups"),repositories:[{profile:"siftly",root:siftly},{profile:"palmyra",root:palmyra}],includeProtected:true};
const known=knownInstallManifest(knownOptions);
const mergedPolicy=JSON.parse(Buffer.from(known.entries.find(entry=>entry.root==="palmyra"&&entry.relativePath==="supership.json").effect.content,"base64").toString("utf8"));
assert.deepEqual(mergedPolicy.requiredVerification.find(requirement=>requirement.id==="local-check"),customRequirement);
const weakened=structuredClone(mergedPolicy); weakened.requiredVerification.find(requirement=>requirement.id==="palmyra-go").instructions="Skip Go tests";
writeFileSync(join(palmyra,"supership.json"),JSON.stringify(weakened));
chmodSync(join(palmyra,"supership.json"),0o640);
const policyUpgrade=knownInstallManifest({...knownOptions,repositories:[{profile:"palmyra",root:palmyra}]});
const policyEntry=policyUpgrade.entries.find(entry=>entry.root==="palmyra"&&entry.relativePath==="supership.json");
const upgradeManifest={...policyUpgrade,entries:[policyEntry],registration:undefined}; delete upgradeManifest.registration;
const upgradePlan=planInstall(upgradeManifest), upgradeOperation=upgradePlan.operations[0];
assert.deepEqual(upgradePlan.blockers,[]); assert.equal(upgradeOperation.ownership,"modified-conflict");
assert.match(upgradeOperation.diff,/Skip Go tests/); assert.match(upgradeOperation.diff,/-count=1 -short -timeout 300s/);
const proposedPolicy=JSON.parse(Buffer.from(policyEntry.effect.content,"base64").toString("utf8"));
assert.deepEqual(proposedPolicy.requiredVerification.find(requirement=>requirement.id==="palmyra-go"),policy.requiredVerification.find(requirement=>requirement.id==="palmyra-go"));
assert.deepEqual(proposedPolicy.requiredVerification.find(requirement=>requirement.id==="local-check"),customRequirement);
await assert.rejects(applyInstall(upgradeManifest,upgradePlan,{digest:upgradePlan.digest,files:[]}),/per-file/);
assert.equal(readFileSync(join(palmyra,"supership.json"),"utf8"),JSON.stringify(weakened));
assert.equal(lstatSync(join(palmyra,"supership.json")).mode&0o777,0o640);
const upgraded=await applyInstall(upgradeManifest,upgradePlan,{digest:upgradePlan.digest,files:[upgradeOperation.confirmation]});
assert.deepEqual(JSON.parse(readFileSync(join(palmyra,"supership.json"),"utf8")),proposedPolicy);
assert.equal(lstatSync(join(palmyra,"supership.json")).mode&0o777,0o640);
await rollbackInstall(upgraded.journal,planRollback(upgraded.journal).digest);
assert.equal(readFileSync(join(palmyra,"supership.json"),"utf8"),JSON.stringify(weakened));
writeFileSync(join(palmyra,"supership.json"),JSON.stringify(mergedPolicy));
assert.ok(planInstall(known).blockers.some(message=>message.includes("Required policy reference")));
assert.equal(known.entries.find(entry=>entry.root==="siftly"&&entry.relativePath==="agents/task.md").effect.kind,"preserve");
assert.ok(!known.entries.some(entry=>entry.relativePath==="agents/project-only.md"));
assert.equal(known.entries.find(entry=>entry.root==="palmyra"&&entry.relativePath==="commands/check.md").effect.kind,"preserve");
assert.equal(known.entries.filter(entry=>entry.protected).length,2);
assert.equal(readFileSync(join(siftly,"agents/task.md"),"utf8"),"custom task safety\\n");
// A colon in either root or path cannot approve a second target with the same bytes.
const left=join(home,"left"),right=join(home,"right"); mkdirSync(left); mkdirSync(right);
writeFileSync(join(left,"x:y"),"same"); writeFileSync(join(right,"y"),"same");
const collision={schemaVersion:1,roots:[{id:"r",path:left,kind:"repository"},{id:"r:x",path:right,kind:"repository"}],backupRoot:backups,entries:[
 {root:"r",relativePath:"x:y",baselineDigests:[],protected:false,provenance:"custom fixture root",effect:{kind:"remove"}},
 {root:"r:x",relativePath:"y",baselineDigests:[],protected:false,provenance:"custom fixture root",effect:{kind:"remove"}},
]};
const collisionPlan=planInstall(collision), tokens=collisionPlan.operations.map(operation=>operation.confirmation);
assert.notEqual(tokens[0],tokens[1]);
await assert.rejects(applyInstall(collision,collisionPlan,{digest:collisionPlan.digest,files:[tokens[0]]}),/per-file/);
await assert.rejects(applyInstall(collision,collisionPlan,{digest:collisionPlan.digest,files:["r:x:y:"+hash("same")]}),/per-file/);
assert.equal(readFileSync(join(left,"x:y"),"utf8"),"same"); assert.equal(readFileSync(join(right,"y"),"utf8"),"same");
const collisionApplied=await applyInstall(collision,collisionPlan,{digest:collisionPlan.digest,files:tokens});
await rollbackInstall(collisionApplied.journal,planRollback(collisionApplied.journal).digest);

// Unsafe inventory produces all available paths without inspecting malformed manifest targets.
const occupied=join(global,"occupied"),pipe=join(global,"pipe");mkdirSync(occupied);
assert.equal(Bun.spawnSync(["mkfifo",pipe]).exitCode,0);
const unsafeEntries=["occupied","danger/escape","pipe","custom.json"].map(relativePath=>({...linked.entries[0],relativePath}));
const unsafe={...manifest,entries:unsafeEntries}; const inventory=planInstall(unsafe);
for(const path of [occupied,join(global,"danger/escape"),pipe]) assert.ok(inventory.blockers.some(message=>message.includes(path)));
assert.equal(inventory.operations.find(operation=>operation.path===join(global,"custom.json")).before.digest,hash("UNRELATED_SECRET_MARKER"));
await assert.rejects(applyInstall(unsafe,inventory,{digest:inventory.digest,files:[]}),/Migration blocked/);
assert.throws(()=>planInstall({...unsafe,schemaVersion:2}),/schema|Schema/);
const registryRoot=join(home,"inventory-registry");mkdirSync(join(registryRoot,"node_modules/fixture-supership"),{recursive:true});
const registryFile=join(registryRoot,"omp-plugins.lock.json");
for(const content of ["{invalid",JSON.stringify({plugins:{}}),JSON.stringify({plugins:{},settings:{},keep:"unrelated"})]) {
 writeFileSync(registryFile,content);
 const partialInventory=planInstall({...unsafe,registration:{...failing.registration,pluginRoot:registryRoot}});
 assert.ok(partialInventory.blockers.some(message=>message.includes(registryFile)));
 assert.ok(partialInventory.blockers.some(message=>message.includes(join(registryRoot,"node_modules/fixture-supership"))));
 assert.ok(partialInventory.operations.some(operation=>operation.path===join(global,"custom.json")));
 assert.equal(readFileSync(registryFile,"utf8"),content);
}
mkdirSync(join(knownOptions.agentRoot,"commands/supership.md"),{recursive:true});
const knownBlocked=planInstall(knownInstallManifest(knownOptions));
assert.ok(knownBlocked.blockers.some(message=>message.includes(join(knownOptions.agentRoot,"commands/supership.md"))));
assert.ok(knownBlocked.operations.some(operation=>operation.path===join(palmyra,"commands/check.md")));
console.log("managed safety and rollback scenarios passed");
`], { env: environment, cwd: home, encoding: "utf8", timeout: 120000 });
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /managed safety and rollback scenarios passed/);
    } finally { rmSync(home, { recursive: true, force: true }); }
}, 120000);
