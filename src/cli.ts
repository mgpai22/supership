#!/usr/bin/env bun
import { Crust } from "@crustjs/core";
import { helpPlugin, renderHelp, versionPlugin } from "@crustjs/plugins";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json";
import { applyInstall, defaultInstallPaths, knownInstallManifest, planInstall, planRollback, readInstallRecovery, rollbackInstall } from "./install.ts";
import type { InstallManifest, InstallPlan } from "./install.ts";
import { doctor } from "./omp.ts";
import { exportRun, planCleanup, cleanupRun } from "./store.ts";

const noPositionals = [{ name: "unexpected", type: "string", variadic: true, description: "No positional arguments are accepted" }] as const;
function rejectExtra(args: { unexpected: string[] }, rawArgs: string[]) {
    if (args.unexpected.length || rawArgs.length) throw new Error(`Unexpected arguments: ${[...args.unexpected, ...rawArgs].join(" ")}`);
}
const installFlags = {
    manifest: { type: "path", description: "Trusted manifest: may name arbitrary roots and claim file ownership; review all paths and diffs" },
    plan: { type: "path", description: "Previously reviewed JSON plan, for partial-failure recovery" },
    "canonical-root": { type: "path", description: "Canonical Supership package checkout" },
    "agent-root": { type: "path", description: "Global OMP agent directory" },
    "plugin-root": { type: "path", description: "OMP native global plugin registry directory" },
    "backup-root": { type: "path", description: "Exact-byte rollback storage outside all discovery roots" },
    siftly: { type: "path", description: "Siftly .omp directory to convert to data policy" },
    palmyra: { type: "path", description: "Palmyra .omp directory to convert to data policy" },
    "include-protected": { type: "boolean", description: "Propose removal of the two protected source personas; each still needs final confirmation" },
    "dry-run": { type: "boolean", description: "Preview only; never calls native plugin link" },
    apply: { type: "boolean", description: "Apply the exact checksum-confirmed plan" },
    confirm: { type: "string", description: "SHA-256 of the full reviewed plan" },
    "confirm-file": { type: "string", multiple: true, description: "Exact per-file token printed by the current plan; repeat for each approved target (also rollback)" },
} as const;
function managedCommand(name: "install" | "migrate") {
    return new Crust(name).meta({ description: name === "install" ? "Preview or confirm the canonical local installation" : "Preview, confirm, recover, or roll back managed migration" })
        .args(noPositionals)
        .flags({ ...installFlags, rollback: { type: "path", description: "Rollback journal outside discovery (migrate only)" }, recover: { type: "path", description: "Resume the original manifest and plan from a failure journal (migrate only)" } })
        .run(async ({ args, flags, rawArgs }) => {
            rejectExtra(args, rawArgs);
            if (flags.rollback) {
                if (name !== "migrate") throw new Error("Rollback belongs to migrate");
                if ([flags.manifest, flags.plan, flags.recover, flags["canonical-root"], flags["agent-root"], flags["plugin-root"], flags["backup-root"], flags.siftly, flags.palmyra, flags["include-protected"]].some(Boolean)) throw new Error("Use migrate --rollback without manifest, plan, recover, or root-selection flags");
                const plan = planRollback(flags.rollback);
                console.log(JSON.stringify(plan, null, 2));
                if (flags["confirm-file"]?.some(token => !plan.operations.some(operation => operation.confirmation === token))) throw new Error("Per-file confirmation does not match the current rollback preview; preview again");
                if (!flags.apply || flags["dry-run"]) {
                    if (plan.blockers.length) process.exitCode = 1;
                    return;
                }
                if (!flags.confirm) throw new Error("Rollback apply requires --confirm with the reviewed rollback preview checksum; no changes made");
                console.error("CAUTION: rollback restores reviewed files and registration. Each changed target needs its exact per-file token; edits after preview still refuse.");
                console.log(JSON.stringify(await rollbackInstall(flags.rollback, flags.confirm, flags["confirm-file"] ?? []), null, 2));
                return;
            }
            if (flags.manifest && [flags["canonical-root"], flags["agent-root"], flags["plugin-root"], flags["backup-root"], flags.siftly, flags.palmyra, flags["include-protected"]].some(Boolean)) throw new Error("Use either --manifest or root-selection flags");
            if (flags.recover && (name !== "migrate" || [flags.manifest, flags.plan, flags["canonical-root"], flags["agent-root"], flags["plugin-root"], flags["backup-root"], flags.siftly, flags.palmyra, flags["include-protected"]].some(Boolean))) throw new Error("Use migrate --recover without manifest, plan, or root-selection flags");
            const recovery = flags.recover ? readInstallRecovery(flags.recover) : undefined;
            const defaults = defaultInstallPaths();
            const siftly = flags.siftly ?? defaults.siftly, palmyra = flags.palmyra ?? defaults.palmyra;
            const manifest = recovery?.manifest ?? (flags.manifest ? JSON.parse(readFileSync(flags.manifest, "utf8")) as InstallManifest : knownInstallManifest({
                canonicalRoot: flags["canonical-root"] ?? defaults.canonicalRoot,
                agentRoot: flags["agent-root"] ?? defaults.agentRoot,
                pluginRoot: flags["plugin-root"] ?? defaults.pluginRoot,
                backupRoot: flags["backup-root"] ?? defaults.backupRoot,
                repositories: [
                    ...(siftly ? [{ profile: "siftly" as const, root: siftly }] : []),
                    ...(palmyra ? [{ profile: "palmyra" as const, root: palmyra }] : []),
                ], includeProtected: flags["include-protected"] === true,
            }));
            const plan = recovery?.plan ?? (flags.plan ? JSON.parse(readFileSync(flags.plan, "utf8")) as InstallPlan : planInstall(manifest));
            console.log(JSON.stringify(plan, null, 2));
            if (!flags.apply || flags["dry-run"]) {
                if (plan.blockers.length) process.exitCode = 1;
                return;
            }
            if (!flags.confirm) throw new Error("Apply requires --confirm with the reviewed plan checksum; no changes made");
            console.error("CAUTION: apply changes the listed managed paths and may register the global package. Exact backups precede each change.");
            console.log(JSON.stringify(await applyInstall(manifest, plan, { digest: flags.confirm, files: flags["confirm-file"] ?? [] }), null, 2));
        });
}
export function createCli() {
    return new Crust("supership").meta({ description: "Manage the Supership OMP extension and its local run artifacts" })
        .use(versionPlugin(pkg.version)).use(helpPlugin())
        .args(noPositionals)
        .run(({ args, rawArgs, command }) => { rejectExtra(args, rawArgs); console.log(renderHelp(command)); })
        .command(managedCommand("install"))
        .command(managedCommand("migrate"))
        .command("doctor", command => command.meta({ description: "Check supported OMP version and public capabilities without model calls" }).args(noPositionals)
            .flags({ cwd: { type: "path", description: "Repository to diagnose", default: process.cwd() } })
            .run(async ({ args, flags, rawArgs }) => {
                rejectExtra(args, rawArgs);
                const report = await doctor({ cwd: flags.cwd });
                console.log(JSON.stringify(report, null, 2));
                if (!report.supported) process.exitCode = 1;
            }))
        .command("export", command => command.meta({ description: "Write a sanitized run summary to stdout; does not publish or overwrite files" }).args(noPositionals)
            .flags({ run: { type: "path", required: true, description: "New-format .planning/<slug> run directory" } })
            .run(async ({ args, flags, rawArgs }) => {
                rejectExtra(args, rawArgs);
                process.stdout.write(await exportRun(flags.run));
            }))
        .command("cleanup", command => command.meta({ description: "Preview or confirm removal of exact run artifacts through the shared store" }).args(noPositionals)
            .flags({ run: { type: "path", required: true, description: "New-format .planning/<slug> run directory" }, "dry-run": { type: "boolean" }, apply: { type: "boolean" }, confirm: { type: "string", description: "Reviewed cleanup plan checksum" } })
            .run(async ({ args, flags, rawArgs }) => {
                rejectExtra(args, rawArgs);
                const plan = await planCleanup(resolve(flags.run));
                console.log(JSON.stringify(plan, null, 2));
                if (!flags.apply || flags["dry-run"]) return;
                if (flags.confirm !== plan.digest) throw new Error("Cleanup requires --confirm with the exact reviewed plan checksum; no changes made");
                console.error("CAUTION: cleanup deletes the listed run artifacts and worktrees. It refuses unreviewed edits.");
                const result = await cleanupRun(plan, {
                    reviewedPlanHash: plan.digest,
                    approval: { id: randomUUID(), kind: "cleanup", authority: "cli-terminal", decision: "approve", scopeHash: plan.digest, ownerEpoch: plan.ownerEpoch, planRevision: 0, toolVersions: [], createdAt: Date.now(), rationale: "User supplied the exact CLI cleanup preview checksum", evidence: [] },
                });
                console.log(JSON.stringify(result, null, 2));
            }));
}
if (import.meta.main) await createCli().execute();
