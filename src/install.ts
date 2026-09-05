import * as Type from "@sinclair/typebox/type";
import type { Static, TProperties } from "@sinclair/typebox";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync, fchmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { assertSchema, digestJson, DigestSchema, RelativePathSchema, PolicyOverlaySchema, EvidenceRefSchema } from "./contracts.ts";
type PolicyOverlay = Static<typeof PolicyOverlaySchema>;
type EvidenceRef = Static<typeof EvidenceRefSchema>;

const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const nullableDigest = Type.Union([DigestSchema, Type.Null()]);
const bytes = Type.String({ pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" });
const effect = Type.Union([
    object({ kind: Type.Literal("remove") }),
    object({ kind: Type.Literal("preserve") }),
    object({ kind: Type.Literal("write"), content: bytes, mode: Type.Integer({ minimum: 0, maximum: 511 }) }),
    object({ kind: Type.Literal("strip-prefix"), prefix: bytes, suffixDigest: DigestSchema }),
]);
export const InstallManifestSchema = object({
    schemaVersion: Type.Literal(1),
    roots: Type.Array(object({ id: text, path: text, kind: Type.Union([Type.Literal("canonical"), Type.Literal("global"), Type.Literal("repository")]) }), { minItems: 1 }),
    backupRoot: text,
    blockers: Type.Optional(Type.Array(text)),
    entries: Type.Array(object({ root: text, relativePath: RelativePathSchema, baselineDigests: Type.Array(DigestSchema), protected: Type.Boolean(), provenance: text, effect })),
    registration: Type.Optional(object({ canonicalRoot: text, pluginRoot: text, packageName: Type.String({ pattern: "^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$" }), version: text, packageDigest: DigestSchema })),
});
export type InstallManifest = Static<typeof InstallManifestSchema>;
const SnapshotSchema = object({ kind: Type.Union([Type.Literal("absent"), Type.Literal("file"), Type.Literal("symlink")]), digest: nullableDigest, mode: Type.Integer(), linkTarget: Type.Union([Type.String(), Type.Null()]) });
type Snapshot = Static<typeof SnapshotSchema>;
const OperationSchema = object({
    path: text, root: text, relativePath: RelativePathSchema, before: SnapshotSchema, after: SnapshotSchema,
    ownership: Type.Union([Type.Literal("managed"), Type.Literal("modified-conflict"), Type.Literal("protected"), Type.Literal("unrelated")]),
    action: Type.Union([Type.Literal("write"), Type.Literal("remove"), Type.Literal("preserve"), Type.Literal("native-link"), Type.Literal("native-registry")]),
    provenance: text, diff: Type.String(), confirmation: Type.Union([text, Type.Null()]),
});
export const InstallPlanSchema = object({ schemaVersion: Type.Literal(1), manifestDigest: DigestSchema, digest: DigestSchema, operations: Type.Array(OperationSchema), blockers: Type.Array(text), backupRoot: text });
export type InstallPlan = Static<typeof InstallPlanSchema>;
type Operation = InstallPlan["operations"][number];
const JournalSchema = object({ schemaVersion: Type.Literal(1), plan: InstallPlanSchema, manifest: InstallManifestSchema, status: Type.Union([Type.Literal("prepared"), Type.Literal("applying"), Type.Literal("applied"), Type.Literal("failed"), Type.Literal("rolled-back")]), backups: Type.Array(object({ path: text, backup: Type.Union([text, Type.Null()]), before: SnapshotSchema, after: SnapshotSchema })), error: Type.Union([Type.String(), Type.Null()]) });
type Journal = Static<typeof JournalSchema>;
export const RollbackPlanSchema = object({
    schemaVersion: Type.Literal(1), journalPath: text, journalSnapshot: SnapshotSchema,
    installPlanDigest: DigestSchema, journalStatus: JournalSchema.properties.status, backupRoot: text, digest: DigestSchema,
    operations: Type.Array(object({
        path: text, current: Type.Union([SnapshotSchema, Type.Null()]), restore: SnapshotSchema,
        backup: Type.Union([text, Type.Null()]), backupSnapshot: Type.Union([SnapshotSchema, Type.Null()]),
        action: Type.Union([Type.Literal("write"), Type.Literal("remove"), Type.Literal("symlink"), Type.Literal("preserve")]), diff: Type.String(), confirmation: Type.Union([text, Type.Null()]),
    })), blockers: Type.Array(text),
});
export type RollbackPlan = Static<typeof RollbackPlanSchema>;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const absent: Snapshot = { kind: "absent", digest: null, mode: 0, linkTarget: null };
const equal = (a: Snapshot, b: Snapshot) => digestJson(a) === digestJson(b);
const fileConfirmation = (scope: "install" | "rollback", root: string, relativePath: string, path: string, before: Snapshot, after: Snapshot) => `file:${digestJson([scope, root, relativePath, path, before, after])}`;
const rollbackConflict = (path: string) => `Unreviewed edit blocks rollback: ${path}`;
const inside = (root: string, path: string) => { const suffix = relative(root, path); return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix); };

function validateAbsolutePath(path: string): void {
    if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f]/.test(path)) throw new Error(`Unsafe absolute path: ${path}`);
}
// lstat every component: neither a dangling link nor a symlinked ancestor is a managed directory.
function guard(path: string, leaf = false): void {
    validateAbsolutePath(path);
    const end = leaf ? path : dirname(path);
    const components = end.split("/").filter(Boolean);
    let current = "/";
    for (const component of components) {
        current = join(current, component);
        try {
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory: ${current}`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
}
function fileBytes(path: string): Buffer {
    guard(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!fstatSync(fd).isFile()) throw new Error("Expected a regular file: " + path); return readFileSync(fd); } finally { closeSync(fd); }
}
function snapshot(path: string): Snapshot {
    guard(path);
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            const linkTarget = readlinkSync(path);
            return { kind: "symlink", digest: sha256(linkTarget), mode: stat.mode & 0o777, linkTarget };
        }
        if (!stat.isFile()) throw new Error(`Managed path is not a regular file or link: ${path}`);
        return { kind: "file", digest: sha256(fileBytes(path)), mode: stat.mode & 0o777, linkTarget: null };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...absent }; throw error; }
}
function durableWrite(path: string, content: Uint8Array, mode = 0o600): void {
    guard(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    guard(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { writeFileSync(fd, content); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
}
function snapshotBytes(value: Uint8Array, mode: number): Snapshot { return { kind: "file", digest: sha256(value), mode, linkTarget: null }; }
function fullDiff(path: string, before: Buffer, after: Buffer): string {
    const render = (value: Buffer) => {
        const decoded = value.toString("utf8");
        return Buffer.from(decoded).equals(value) ? decoded : `[base64 bytes]\n${value.toString("base64")}\n`;
    };
    // Whole-file hunks intentionally include every byte, including a missing final newline.
    const lines = (value: Buffer, prefix: string) => render(value).split("\n").map(line => `${prefix}${line}`).join("\n");
    return `--- ${path}\n+++ ${path}\n${lines(before, "-")}\n${lines(after, "+")}\n`;
}
function validateManifest(input: unknown): asserts input is InstallManifest {
    assertSchema(InstallManifestSchema, input);
    const manifest = input as InstallManifest;
    const roots = new Set<string>();
    const paths = new Set<string>();
    validateAbsolutePath(manifest.backupRoot);
    if (/(?:^|\/)(?:commands|agents|prompts|extensions|skills)(?:\/|$)/.test(manifest.backupRoot)) throw new Error("Backups must be outside active discovery directories");
    for (const root of manifest.roots) {
        validateAbsolutePath(root.path);
        if (roots.has(root.id)) throw new Error(`Duplicate root: ${root.id}`);
        roots.add(root.id);
        if (inside(root.path, manifest.backupRoot) || inside(manifest.backupRoot, root.path)) throw new Error(`Backup directory overlaps installation root: ${root.path}`);
    }
    const canonicalRoots = [resolve(import.meta.dir, ".."), ...manifest.roots.filter(root => root.kind === "canonical").map(root => root.path)];
    if (manifest.registration) canonicalRoots.push(manifest.registration.canonicalRoot);
    const protectedPaths = new Set(canonicalRoots.flatMap(root => [join(root, "omp/agents/review-orchestrator.md"), join(root, "omp/agents/kimi-reviewer.md")]));
    for (const entry of manifest.entries) {
        const root = manifest.roots.find(root => root.id === entry.root);
        if (!root) throw new Error(`Unknown manifest root: ${entry.root}`);
        const path = join(root.path, entry.relativePath);
        if (resolve(path) !== `${root.path}/${entry.relativePath}` || !inside(root.path, path) || paths.has(path)) throw new Error(`Unsafe or duplicate managed path: ${path}`);
        paths.add(path);
        if (protectedPaths.has(path) && !entry.protected) throw new Error(`Protected source requires individual confirmation: ${path}`);
        if (entry.effect.kind === "strip-prefix" && !entry.effect.prefix) throw new Error(`Empty managed prefix: ${path}`);
    }
    if (manifest.registration) {
        const registration = manifest.registration;
        validateAbsolutePath(registration.canonicalRoot); validateAbsolutePath(registration.pluginRoot);
        if (inside(registration.pluginRoot, manifest.backupRoot) || inside(manifest.backupRoot, registration.pluginRoot)) throw new Error("Backup directory overlaps plugin registry");
        if (paths.has(join(registration.pluginRoot, "omp-plugins.lock.json")) || paths.has(join(registration.pluginRoot, "node_modules", registration.packageName))) throw new Error("Registration paths must have one owner");
    }
}
function desired(entry: InstallManifest["entries"][number], path: string, before: Snapshot): Buffer | null {
    if (entry.effect.kind === "write") return Buffer.from(entry.effect.content, "base64");
    if (entry.effect.kind === "strip-prefix") {
        if (before.kind === "absent") return null;
        if (before.kind !== "file") throw new Error(`Managed prompt is not a regular file: ${path}`);
        const old = fileBytes(path), prefix = Buffer.from(entry.effect.prefix, "base64");
        if (sha256(old) === entry.effect.suffixDigest) return old;
        if (!old.subarray(0, prefix.length).equals(prefix) || sha256(old.subarray(prefix.length)) !== entry.effect.suffixDigest) throw new Error(`Unrecognized managed prompt prefix or suffix: ${path}`);
        return old.subarray(prefix.length);
    }
    return null;
}
function registryChange(manifest: InstallManifest): { before: Record<string, unknown>; after: Record<string, unknown>; bytes: Buffer } {
    const registration = manifest.registration!;
    const path = join(registration.pluginRoot, "omp-plugins.lock.json");
    const state = snapshot(path);
    if (state.kind === "symlink") throw new Error(`Plugin registry must not be a symlink: ${path}`);
    const before = state.kind === "absent" ? { plugins: {}, settings: {} } : JSON.parse(fileBytes(path).toString("utf8"));
    if (!before || typeof before !== "object" || Array.isArray(before) || !before.plugins || typeof before.plugins !== "object" || Array.isArray(before.plugins) || !before.settings || typeof before.settings !== "object" || Array.isArray(before.settings)) throw new Error(`Invalid plugin registry: ${path}`);
    // Native link normalizes unknown root properties. Refuse instead of allowing it to drop them.
    if (Object.keys(before).some(key => !["plugins", "settings"].includes(key))) throw new Error(`Unsupported plugin registry fields: ${path}`);
    const after = { plugins: { ...before.plugins, [registration.packageName]: { version: registration.version, enabledFeatures: null, enabled: true } }, settings: before.settings };
    return { before, after, bytes: Buffer.from(JSON.stringify(after, null, 2)) };
}
export function planInstall(input: unknown): InstallPlan {
    validateManifest(input);
    const manifest = input, operations: Operation[] = [], blockers: string[] = [...(input.blockers ?? [])];
    for (const path of new Set([manifest.backupRoot, ...manifest.roots.map(root => root.path), ...(manifest.registration ? [manifest.registration.canonicalRoot, manifest.registration.pluginRoot] : [])])) {
        try { guard(path, true); } catch (error) { blockers.push(`Inventory blocked at ${path}: ${(error as Error).message}`); }
    }
    for (const entry of manifest.entries) {
        const root = manifest.roots.find(root => root.id === entry.root)!;
        const path = join(root.path, entry.relativePath);
        let before: Snapshot;
        try { before = snapshot(path); } catch (error) { blockers.push(`Inventory blocked at ${path}: ${(error as Error).message}`); continue; }
        let after = before, action: Operation["action"] = "preserve", diff = "";
        try {
            if (entry.effect.kind !== "preserve") {
                const content = desired(entry, path, before);
                if (entry.relativePath === "supership.json" && content) {
                    const policy: unknown = JSON.parse(content.toString("utf8")); assertSchema(PolicyOverlaySchema, policy);
                    const overlay = policy as PolicyOverlay;
                    for (const reference of [...overlay.instructionRefs, ...overlay.verificationChecks.flatMap(check => check.source), ...(overlay.requiredVerification ?? []).flatMap(check => check.source)]) {
                        if (reference.kind !== "file") continue;
                        const source = join(root.path, reference.uri), current = snapshot(source);
                        if (reference.availability !== "available" || !reference.digest || current.kind !== "file" || current.digest !== reference.digest) blockers.push("Required policy reference is missing or changed: " + source);
                    }
                }
                after = content === null ? { ...absent } : snapshotBytes(content, entry.effect.kind === "write" ? entry.effect.mode : before.mode);
                if (!equal(before, after)) {
                    action = content === null ? "remove" : "write";
                    const old = before.kind === "file" ? fileBytes(path) : Buffer.from(before.linkTarget ?? "");
                    diff = fullDiff(path, old, content ?? Buffer.alloc(0));
                }
            }
        } catch (error) { blockers.push(`Inventory blocked at ${path}: ${(error as Error).message}`); }
        const ownership = entry.protected ? "protected" : entry.effect.kind === "preserve" ? "unrelated" : before.kind === "absent" || entry.baselineDigests.includes(before.digest!) ? "managed" : "modified-conflict";
        const confirmation = action !== "preserve" && (ownership === "protected" || ownership === "modified-conflict") ? fileConfirmation("install", entry.root, entry.relativePath, path, before, after) : null;
        operations.push({ path, root: entry.root, relativePath: entry.relativePath, before, after, ownership, action, provenance: entry.provenance, diff, confirmation });
    }
    if (manifest.registration) {
        const registration = manifest.registration;
        const packagePath = join(registration.canonicalRoot, "package.json");
        try {
            if (snapshot(packagePath).digest !== registration.packageDigest) blockers.push(`Canonical package changed: ${packagePath}`);
            else {
                const pkg = JSON.parse(fileBytes(packagePath).toString("utf8"));
                if (pkg.name !== registration.packageName || pkg.version !== registration.version || !pkg.omp) blockers.push(`Canonical package lacks the reviewed name, version or OMP manifest: ${packagePath}`);
            }
        } catch (error) { blockers.push(`Inventory blocked at ${packagePath}: ${(error as Error).message}`); }
        const linkPath = join(registration.pluginRoot, "node_modules", registration.packageName);
        const linkAfter: Snapshot = { kind: "symlink", mode: 0o777, digest: sha256(registration.canonicalRoot), linkTarget: registration.canonicalRoot };
        let linked = false;
        try {
            const before = snapshot(linkPath);
            if (before.kind === "file") blockers.push(`Regular file occupies plugin registration: ${linkPath}`);
            linked = equal(before, linkAfter);
            const relativePath = relative(registration.pluginRoot, linkPath), conflict = before.kind !== "absent" && !linked;
            operations.push({ path: linkPath, root: "plugin-registry", relativePath, before, after: linkAfter, action: linked ? "preserve" : "native-link", ownership: conflict ? "modified-conflict" : "managed", provenance: "OMP public plugin link", diff: linked ? "" : fullDiff(linkPath, Buffer.from(before.linkTarget ?? ""), Buffer.from(registration.canonicalRoot)), confirmation: conflict ? fileConfirmation("install", "plugin-registry", relativePath, linkPath, before, linkAfter) : null });
        } catch (error) { blockers.push(`Inventory blocked at ${linkPath}: ${(error as Error).message}`); }
        const registryPath = join(registration.pluginRoot, "omp-plugins.lock.json");
        try {
            const before = snapshot(registryPath), change = registryChange(manifest);
            const selected = (value: Record<string, unknown>) => JSON.stringify((value.plugins as Record<string, unknown>)[registration.packageName] ?? null, null, 2);
            const unchanged = linked && selected(change.before) === selected(change.after);
            const after = unchanged ? before : snapshotBytes(change.bytes, before.kind === "absent" ? 0o666 & ~process.umask() : before.mode);
            const conflict = selected(change.before) !== "null" && selected(change.before) !== selected(change.after);
            operations.push({ path: registryPath, root: "plugin-registry", relativePath: "omp-plugins.lock.json", before, after, action: unchanged ? "preserve" : "native-registry", ownership: conflict ? "modified-conflict" : "managed", provenance: "OMP public plugin link; unrelated registry records remain unchanged", diff: unchanged ? "" : fullDiff(`${registryPath}#plugins/${registration.packageName}`, Buffer.from(selected(change.before)), Buffer.from(selected(change.after))), confirmation: conflict ? fileConfirmation("install", "plugin-registry", "omp-plugins.lock.json", registryPath, before, after) : null });
        } catch (error) { blockers.push(`Inventory blocked at ${registryPath}: ${(error as Error).message}`); }
    }
    const result = { schemaVersion: 1 as const, manifestDigest: digestJson(manifest), operations, blockers, backupRoot: manifest.backupRoot };
    const plan = { ...result, digest: digestJson(result) };
    assertSchema(InstallPlanSchema, plan);
    return plan;
}
function saveJournal(path: string, journal: Journal) { assertSchema(JournalSchema, journal); durableWrite(path, Buffer.from(JSON.stringify(journal, null, 2))); }
function verifyPlan(plan: InstallPlan, manifest: InstallManifest): void {
    assertSchema(InstallPlanSchema, plan); validateManifest(manifest);
    const { digest, ...rest } = plan;
    if (digestJson(rest) !== digest || plan.manifestDigest !== digestJson(manifest)) throw new Error("Plan checksum mismatch; preview again");
    const seen = new Set<string>();
    if (plan.blockers.length) throw new Error(`Migration blocked: ${plan.blockers.join("; ")}`);
    if (plan.operations.length !== manifest.entries.length + (manifest.registration ? 2 : 0)) throw new Error("Plan omitted managed paths");
    for (const operation of plan.operations) {
        if (seen.has(operation.path)) throw new Error("Duplicate plan path: " + operation.path);
        seen.add(operation.path);
        if (operation.confirmation && operation.confirmation !== fileConfirmation("install", operation.root, operation.relativePath, operation.path, operation.before, operation.after)) throw new Error("Invalid per-file confirmation identity");
        const entry = manifest.entries.find(entry => entry.root === operation.root && entry.relativePath === operation.relativePath);
        if (entry) {
            const root = manifest.roots.find(root => root.id === entry.root)!;
            if (operation.path !== join(root.path, entry.relativePath)) throw new Error("Plan path escapes its manifest root");
            const required = operation.action !== "preserve" && (entry.protected || (operation.before.kind !== "absent" && !entry.baselineDigests.includes(operation.before.digest!)));
            if (required && operation.confirmation !== fileConfirmation("install", entry.root, entry.relativePath, operation.path, operation.before, operation.after)) throw new Error("Plan omits mandatory per-file confirmation");
            if (operation.action === "preserve") { if (!equal(operation.before, operation.after)) throw new Error("Invalid preserved plan path"); continue; }
            if (entry.effect.kind === "preserve" || operation.action.startsWith("native-")) throw new Error("Plan changes a preserved manifest path");
            const expected = entry.effect.kind === "write" ? snapshotBytes(Buffer.from(entry.effect.content, "base64"), entry.effect.mode) : entry.effect.kind === "remove" ? absent : { ...operation.before, digest: entry.effect.suffixDigest };
            if (!equal(operation.after, expected)) throw new Error("Plan replacement differs from manifest: " + operation.path);
        } else {
            const registration = manifest.registration;
            if (!registration || operation.root !== "plugin-registry" || operation.path !== join(registration.pluginRoot, operation.relativePath) || !["omp-plugins.lock.json", "node_modules/" + registration.packageName].includes(operation.relativePath)) throw new Error("Plan contains an unmanaged path");
        }
    }
}
function verifyJournalPaths(journal: Journal, path: string): void {
    verifyPlan(journal.plan, journal.manifest);
    if (path !== join(journal.manifest.backupRoot, journal.plan.digest, "rollback.json")) throw new Error("Rollback journal has an unexpected location");
    const changes = journal.plan.operations.filter(operation => operation.action !== "preserve");
    if (changes.length !== journal.backups.length) throw new Error("Rollback journal is incomplete");
    for (const [index, operation] of changes.entries()) {
        const backup = journal.backups[index]!;
        const expected = operation.before.kind === "file" ? join(dirname(path), index + ".bytes") : null;
        if (backup.path !== operation.path || backup.backup !== expected || !equal(backup.before, operation.before) || !equal(backup.after, operation.after)) throw new Error("Rollback journal does not match reviewed paths");
    }
}
function verifyJournal(journal: Journal, path: string): void {
    verifyJournalPaths(journal, path);
    for (const backup of journal.backups) if (backup.backup && sha256(fileBytes(backup.backup)) !== backup.before.digest) throw new Error("Rollback bytes changed: " + backup.backup);
}
async function acquireMigrationLock(root: string) {
    const path = join(root, "migration.lock");
    guard(path);
    const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
    // Same persistent-inode flock protocol as the run store; a dead parent closes stdin and releases it.
    const helper = Bun.spawn(["flock", "--exclusive", "--nonblock", "--no-fork", path, "/bin/sh", "-c", "printf 'locked\n'; exec cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = helper.stdout.getReader(), ready = await reader.read();
    reader.releaseLock();
    if (ready.done || new TextDecoder().decode(ready.value) !== "locked\n") {
        helper.stdin.end(); await helper.exited;
        throw new Error("Another migration holds the lock: " + path);
    }
    return helper;
}
export async function applyInstall(manifest: InstallManifest, plan: InstallPlan, confirmation: { digest: string; files: string[] }): Promise<{ status: "applied" | "unchanged"; journal: string | null }> {
    verifyPlan(plan, manifest);
    if (confirmation.digest !== plan.digest) throw new Error("Confirmation does not match the reviewed plan checksum");
    for (const operation of plan.operations) if (operation.confirmation && !confirmation.files.includes(operation.confirmation)) throw new Error(`Final per-file confirmation required: ${operation.confirmation}`);
    if (plan.operations.every(operation => operation.action === "preserve")) return { status: "unchanged", journal: null };
    const directory = join(manifest.backupRoot, plan.digest), journalPath = join(directory, "rollback.json");
    guard(directory, true); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireMigrationLock(manifest.backupRoot);
    let journal: Journal;
    try {
        if (existsSync(journalPath)) {
            const loaded: unknown = JSON.parse(fileBytes(journalPath).toString("utf8")); assertSchema(JournalSchema, loaded); journal = loaded as Journal;
            if (journal.plan.digest !== plan.digest || digestJson(journal.manifest) !== digestJson(manifest)) throw new Error("Rollback journal does not match plan");
            verifyJournal(journal, journalPath);
            if (journal.status === "rolled-back") journal.status = "prepared";
        } else {
            if (planInstall(manifest).digest !== plan.digest) throw new Error("Installation changed since preview; review a fresh plan");
            journal = { schemaVersion: 1, manifest, plan, status: "prepared", backups: [], error: null };
            for (const operation of plan.operations.filter(operation => operation.action !== "preserve")) {
                if (!equal(snapshot(operation.path), operation.before)) throw new Error(`Installation changed since preview: ${operation.path}`);
                const backup = operation.before.kind === "file" ? join(directory, `${journal.backups.length}.bytes`) : null;
                if (backup) {
                    const original = fileBytes(operation.path);
                    if (sha256(original) !== operation.before.digest) throw new Error("File changed during backup: " + operation.path);
                    durableWrite(backup, original);
                }
                journal.backups.push({ path: operation.path, backup, before: operation.before, after: operation.after });
            }
            saveJournal(journalPath, journal);
        }
        // Complete preflight before the first effect, also on partial-failure recovery.
        for (const operation of plan.operations) {
            const current = snapshot(operation.path);
            if (!equal(current, operation.before) && !equal(current, operation.after)) throw new Error(`Unreviewed edit blocks migration: ${operation.path}`);
        }
        journal.status = "applying"; saveJournal(journalPath, journal);
        try {
            for (const operation of plan.operations) {
                if (operation.action === "preserve" || operation.action.startsWith("native-")) continue;
                const current = snapshot(operation.path);
                if (equal(current, operation.after)) continue;
                if (!equal(current, operation.before)) throw new Error(`Unreviewed edit blocks migration: ${operation.path}`);
                const entry = manifest.entries.find(entry => entry.root === operation.root && entry.relativePath === operation.relativePath)!;
                const content = desired(entry, operation.path, current);
                guard(operation.path);
                if (content === null) unlinkSync(operation.path);
                else durableWrite(operation.path, content, operation.after.mode);
                if (!equal(snapshot(operation.path), operation.after)) throw new Error(`Migration write mismatch: ${operation.path}`);
            }
            const registration = manifest.registration;
            if (registration && plan.operations.some(operation => operation.action.startsWith("native-") && !equal(snapshot(operation.path), operation.after))) {
                for (const operation of plan.operations.filter(operation => operation.action.startsWith("native-"))) {
                    const current = snapshot(operation.path);
                    if (!equal(current, operation.before) && !equal(current, operation.after)) throw new Error(`Plugin registration changed: ${operation.path}`);
                }
                if (resolve(getPluginsDir()) !== registration.pluginRoot) throw new Error(`OMP plugin directory differs from reviewed target: ${getPluginsDir()}`);
                if (snapshot(join(registration.canonicalRoot, "package.json")).digest !== registration.packageDigest) throw new Error("Canonical package changed before registration");
                const child = Bun.spawn(["omp", "plugin", "link", registration.canonicalRoot, "--json"], { cwd: registration.canonicalRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
                const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
                if (exit !== 0) throw new Error(`OMP plugin link failed (${exit}); rollback journal: ${journalPath}. ${stderr.slice(0, 1000)}`);
                for (const operation of plan.operations.filter(operation => operation.action.startsWith("native-"))) if (!equal(snapshot(operation.path), operation.after)) throw new Error(`OMP plugin link produced unexpected bytes: ${operation.path}`);
            }
            journal.status = "applied"; journal.error = null; saveJournal(journalPath, journal);
            return { status: "applied", journal: journalPath };
        } catch (error) {
            journal.status = "failed"; journal.error = (error as Error).message; saveJournal(journalPath, journal);
            throw new Error(`${journal.error}\nExact rollback evidence: ${journalPath}`);
        }
    } finally { lock.stdin.end(); await lock.exited; }
}
export function readInstallRecovery(journalPath: string): { manifest: InstallManifest; plan: InstallPlan } {
    const loaded: unknown = JSON.parse(fileBytes(journalPath).toString("utf8")); assertSchema(JournalSchema, loaded);
    const journal = loaded as Journal;
    verifyJournal(journal, journalPath);
    return { manifest: journal.manifest, plan: journal.plan };
}
function readRollback(journalPath: string): { journal: Journal; plan: RollbackPlan } {
    const journalSnapshot = snapshot(journalPath);
    const loaded: unknown = JSON.parse(fileBytes(journalPath).toString("utf8")); assertSchema(JournalSchema, loaded);
    const journal = loaded as Journal;
    verifyJournalPaths(journal, journalPath);
    const operations: RollbackPlan["operations"] = [], blockers: string[] = [];
    for (const backup of [...journal.backups].reverse()) {
        let current: Snapshot | null = null, backupSnapshot: Snapshot | null = null, diff = "", confirmation: string | null = null;
        let restoreBytes: Buffer | null = null;
        try {
            if (backup.backup) {
                backupSnapshot = snapshot(backup.backup);
                if (backupSnapshot.kind !== "file" || backupSnapshot.digest !== backup.before.digest) throw new Error("Rollback bytes changed: " + backup.backup);
                restoreBytes = fileBytes(backup.backup);
                if (sha256(restoreBytes) !== backup.before.digest) throw new Error("Rollback bytes changed: " + backup.backup);
            } else restoreBytes = Buffer.from(backup.before.linkTarget ?? "");
        } catch (error) { restoreBytes = null; blockers.push((error as Error).message); }
        try {
            current = snapshot(backup.path);
            if (!equal(current, backup.before) && (journal.status === "rolled-back" || !equal(current, backup.after))) {
                blockers.push(rollbackConflict(backup.path));
                const operation = journal.plan.operations.find(operation => operation.path === backup.path)!;
                if (restoreBytes !== null) confirmation = fileConfirmation("rollback", operation.root, operation.relativePath, backup.path, current, backup.before);
            }
            if (restoreBytes && !equal(current, backup.before)) {
                const currentBytes = current.kind === "file" ? fileBytes(backup.path) : Buffer.from(current.linkTarget ?? "");
                if (current.kind === "file" && sha256(currentBytes) !== current.digest) throw new Error("Installation changed during rollback preview: " + backup.path);
                const registration = journal.manifest.registration;
                if (!confirmation && registration && backup.path === join(registration.pluginRoot, "omp-plugins.lock.json")) {
                    const selected = (content: Buffer) => content.length ? JSON.stringify(JSON.parse(content.toString("utf8")).plugins[registration.packageName] ?? null, null, 2) : "null";
                    diff = fullDiff(`${backup.path}#plugins/${registration.packageName}`, Buffer.from(selected(currentBytes)), Buffer.from(selected(restoreBytes)));
                } else diff = fullDiff(backup.path, currentBytes, restoreBytes);
            }
        } catch (error) { blockers.push((error as Error).message); }
        const action = current && equal(current, backup.before) ? "preserve" : backup.before.kind === "absent" ? "remove" : backup.before.kind === "file" ? "write" : "symlink";
        operations.push({ path: backup.path, current, restore: backup.before, backup: backup.backup, backupSnapshot, action, diff, confirmation });
    }
    if (!equal(snapshot(journalPath), journalSnapshot)) throw new Error("Journal changed during rollback preview");
    const result = { schemaVersion: 1 as const, journalPath, journalSnapshot, installPlanDigest: journal.plan.digest, journalStatus: journal.status, backupRoot: journal.manifest.backupRoot, operations, blockers };
    const plan = { ...result, digest: digestJson(result) };
    assertSchema(RollbackPlanSchema, plan);
    return { journal, plan };
}
export function planRollback(journalPath: string): RollbackPlan { return readRollback(journalPath).plan; }
export async function rollbackInstall(journalPath: string, confirmedDigest: string, files: string[] = []): Promise<{ status: "rolled-back" | "unchanged" }> {
    const check = (plan: RollbackPlan) => {
        const blockers = plan.blockers.filter(message => !plan.operations.some(operation => operation.confirmation && files.includes(operation.confirmation) && message === rollbackConflict(operation.path)));
        if (blockers.length) throw new Error(`Rollback blocked: ${blockers.join("; ")}`);
        if (confirmedDigest !== plan.digest) throw new Error("Rollback confirmation does not match the current preview checksum; preview again");
        if (files.some(token => !plan.operations.some(operation => operation.confirmation === token))) throw new Error("Per-file confirmation does not match the current rollback preview; preview again");
    };
    const preview = planRollback(journalPath); check(preview);
    const lock = await acquireMigrationLock(preview.backupRoot);
    try {
        const { journal, plan } = readRollback(journalPath); check(plan);
        if (journal.status === "rolled-back" && plan.operations.every(operation => operation.action === "preserve")) return { status: "unchanged" };
        for (const operation of plan.operations) {
            const current = snapshot(operation.path);
            if (!equal(current, operation.current!)) throw new Error(`Unreviewed edit blocks rollback: ${operation.path}`);
            if (operation.action === "preserve") continue;
            guard(operation.path);
            if (operation.restore.kind === "file") {
                const original = fileBytes(operation.backup!);
                if (sha256(original) !== operation.restore.digest) throw new Error("Rollback bytes changed: " + operation.backup);
                durableWrite(operation.path, original, operation.restore.mode);
            } else if (operation.restore.kind === "symlink") {
                const temporary = `${operation.path}.${randomUUID()}.tmp`;
                symlinkSync(operation.restore.linkTarget!, temporary);
                try { renameSync(temporary, operation.path); } catch (error) { unlinkSync(temporary); throw error; }
            } else if (current.kind !== "absent") unlinkSync(operation.path);
            if (!equal(snapshot(operation.path), operation.restore)) throw new Error("Rollback write mismatch: " + operation.path);
        }
        journal.status = "rolled-back"; journal.error = null; saveJournal(journalPath, journal);
        return { status: "rolled-back" };
    } finally { lock.stdin.end(); await lock.exited; }
}

export const LEGACY_PAYLOAD: Record<string, string> = {
    "commands/supership.md": "1c9332dd7f415ceaf5bead52b66326dfe447d9130367ea4756b7b937cb13b9d6",
    "commands/shipit.md": "387086e898683c43803b2c3e331d89fc44cc4ab30e6ff0c45feee922908d5381",
    "commands/ultraship.md": "36ec7f681b351e2b685c2abb65cb53c9a7f5014cd5327f94f24a1f7a4b70f3a9",
    "commands/ultrashipit.md": "3cc51707b814a37401ff14bdc34ce52515ff18a3f015083ff1fdfc0a7bb61312",
    "commands/superreview.md": "a6af5c5dcc0d32f00a9c43e19f0f05ccb8647c1e73a0ce15a8b723707ff32fc5",
    "agents/david-research.md": "81ef4d35fd3265c7b0ce7d98407a6a20c1356a530c3d5ffa955f1cda7764ee8a",
    "agents/deep-debugger.md": "3f2853f15e902f11acb0204a1d85ee21f81fe7aca375526f42b93fedaed12e56",
    "agents/deep-reviewer.md": "f48b2c0040318b5e2895e2184e890c28f4f5d380b46bef096ace7daf4b11f429",
    "agents/designer.md": "fbff744a5a01303bbd70c389dde3c24d3330f0c3defb1a80e47ba76e58814c9a",
    "agents/fable-reviewer.md": "2f3d2f1ed5737bbf8accc40541eec8228f73d785e0e7fe9a864238da9d12af58",
    "agents/kimi-reviewer.md": "1abf4be7ea1755418782588986c256d08c570c32a6b7599c037bcd4338705f61",
    "agents/opus-reviewer.md": "a61b44e7a26c777c81859c3cc76ecfa27ceb9329ae53480e8e96315f18247e12",
    "agents/planner.md": "3078a5b001a9e673d61b4f23a93cc6d7d15efe62526606cdde6a028a01d5a7ca",
    "agents/review-orchestrator.md": "7bfa8b6dfcb5b825d9b48ee425ca8005506b13fb33439d6acd17ce287447b162",
    "agents/sol-reviewer.md": "022d3bc66e1c1f86a550a62878579b75be9c889b34f198cbff6f6528535810a6",
    "agents/task.md": "e35afff829a1ab9df8d74aef9fb44fdaf87b4ca9b9694f8b8d1910f4a46959e3",
    "templates/supership-plan.html": "ff49d5ace29fb13f1210f77785215ac1aa65bcd39cf40a53f083fd8bfd51fc73",
};
const PROFILE_COMMANDS: Record<string, Record<string, string>> = {
    siftly: { "supership": "501dcd8ec4b47fbff25e589af661ca72173115a51c8a2e5a1861a8d3e91cde1d", "superreview": "a433b7a73c2e86d8b24fc99c9f2198e544b28a82be05d62769ecf91d1c08ad6a" },
    palmyra: { "supership": "2cf6426eba957eff69a68f9daf57dd11e7a72c4ac956bf0d8af082d38748178b", "shipit": "cd87c810c23c861668f00182cbbf051fb04fb92adc027740c63a5e03a8717032", "ultraship": "57a16c022df12f10f1e02ad1f2e83467a7f5eadc170e29999c9fd2be99979e92", "ultrashipit": "9cdfa68cd6e27222f16b28ef212d2ffccfccc07592274993c5a1ab36575856e2", "superreview": "6b234d9538ac8818328825b5f32d8285b8ac1e349de033faa5ee0e923233a775" },
};
export function migrationPolicy(profile: "global" | "siftly" | "palmyra", root: string): PolicyOverlay {
    const policy: PolicyOverlay = { schemaVersion: 1, seats: [], namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], requiredVerification: [], phaseGates: [], pathRouting: [], instructionRefs: [] };
    const ref = (path: string, summary: string): EvidenceRef => {
        const target = join(root, path), current = snapshot(target);
        return { id: `${profile}-${path.replaceAll(/[^a-z0-9]/gi, "-")}`, kind: "file", uri: path, ...(current.digest ? { digest: current.digest } : {}), mediaType: "text/markdown", summary, availability: current.kind === "file" ? "available" : "unavailable" };
    };
    const restrict = (id: string, rule: string, paths: string[] = []) => policy.phaseGates.push({ id: `${profile}-${id}`, phases: ["plan", "build", "review", "verify", "commit", "publish"], paths, requirement: { kind: "restriction", rule }, evidence: [] });
    const route = (id: string, agentName: string, paths: string[], reason: string) => {
        if (!policy.seats.some(seat => seat.seatId === agentName)) policy.seats.push({ seatId: agentName, agentName });
        policy.pathRouting.push({ id: `${profile}-${id}`, paths, seatId: agentName, reason, evidence: [] });
    };
    restrict("consent", "Preserve OMP shell approvals and permission settings. Commit and push require explicit consent. Never weaken approvals, stage secrets, or publish during a run without final consent.");
    if (profile === "global") {
        for (const path of ["agents/task.md", "agents/fable-reviewer.md"]) {
            const current = snapshot(join(root, path));
            if (current.kind === "file" && current.digest !== LEGACY_PAYLOAD[path]) policy.instructionRefs.push(ref(path, "Preserved user-owned persona; retain its model and frontmatter choices through OMP agent resolution."));
        }
    }
    if (profile === "siftly") {
        route("data-owner", "siftly-dev", ["**/*.sql", "**/schema/**", "**/database/**", "**/pipeline/**"], "Schema, database, and pipeline work belongs to the repository specialist.");
        route("ui-owner", "web-dev", ["**/*.tsx", "**/ui/**"], "UI work belongs to the repository UI specialist.");
        policy.seats.push({ seatId: "scout", agentName: "siftly-scout" });
        for (const path of ["APPEND_SYSTEM.md", "RULES.md", "agents/planner.md", "agents/task.md", "agents/deep-reviewer.md", "agents/review-orchestrator.md", "agents/deep-debugger.md", "agents/david-research.md"]) {
            if (path.startsWith("agents/") && snapshot(join(root, path)).digest === LEGACY_PAYLOAD[path]) continue;
            policy.instructionRefs.push(ref(path, "Required Siftly project policy. Read this preserved source before work."));
        }
        restrict("data-safety", "Protect PostgreSQL/pgvector live data and frozen database files. Before risky changes stop siftly and both cocoindex replicas; create external custom-format pg_dump in SIFTLY_BACKUP_DIR, preserve permissions and validate with pg_restore --list. Require explicit operator approval. Use additive SQL only. Never apply live migrations automatically, destructive SQL, reset-style migrations, or volume cleanup.");
        restrict("data-review", "Review raw-source versus derived-projection boundaries, credential boundaries, index consistency, retries and CocoIndex isolation. Raw source remains authoritative; derived records remain rebuildable. Route data fixes to siftly-dev. Keep independent reviewers and no clean verdict when a reviewer or check is unavailable. Never weaken tests.");
        policy.requiredVerification!.push({ id: "siftly-checks", description: "Repository TypeScript check and Bun tests", scopePaths: [], instructions: "Read package.json and preserved project policy for the repository TypeScript check. Execute that TypeScript check and the repository Bun tests; retain exit status and evidence.", source: [ref("APPEND_SYSTEM.md", "Repository verification requirements")] });
    }
    if (profile === "palmyra") {
        route("contracts", "contracts-codegen", ["contracts/*.yaml", "tools/codegen/**"], "Contracts and code generation precede their consumers.");
        route("frontend", "commodity-frontend", ["apps/commodities/**", "apps/web-admin-platform/**", "domains/*/fe/**", "packages/ui/**", "packages/utils/**", "packages/hooks/**", "packages/api-sdk/**", "packages/persistence-sdk/**"], "Use the repository frontend owner.");
        route("backend", "task", ["apps/api/**", "domains/*/be/**", "platform/go/**"], "Use task for backend implementation.");
        policy.seats.push({ seatId: "go-domain-reviewer", agentName: "go-domain-reviewer" });
        policy.requiredLenses.push("layering", "generated-purity", "conventions");
        policy.phaseGates.push({ id: "palmyra-contract-first", phases: ["plan", "build"], paths: ["contracts/**"], requirement: { kind: "dependency", prerequisiteIds: ["contracts-codegen"] }, evidence: [] });
        policy.phaseGates.push({ id: "palmyra-domain-consultation", phases: ["plan", "review"], paths: [], requirement: { kind: "consultation", seatId: "go-domain-reviewer", before: "Before general or ultra critique of backend design, and before accepting persistence/blob/timeout/multipart findings. Consult documented orphan-blob steady state, ErrAlreadyExists asymmetry and ReadTimeout choices. Dismiss deliberate-design findings with their reasons; only unsettled questions proceed to the critic." }, evidence: [] });
        for (const path of ["commands/check.md", "commands/regen.md", "commands/add-migration.md", "commands/e2e-local.md"]) policy.instructionRefs.push(ref(path, "Preserved Palmyra command defines required repository policy. Do not execute destructive examples automatically."));
        restrict("contract-order", "Never run contract/codegen changes concurrently with backend/frontend consumers. Added or renamed contracts enter Go generator/config lists and tools/codegen/openapi/ts/openapi-ts.config.ts. Run both generators, review generated/ and packages/api-sdk/src/generated/ for codegen-only differences, preserve hand edits until explicit conflict resolution.");
        restrict("review", "Layering lens uses go-domain-reviewer and enforces BE-LAYER-009/BE-EDGE-008: no generated types past handlers, platform/go imports from domains, or unauthorized cross-domain dependencies. Every hand edit under generated/** or packages/api-sdk/src/generated/** is a finding. Conventions require new-file license headers, domain-sdk wrappers, no raw generated-client imports, @domains entries in TypeScript and Vite config, no agent-named tests and no duplicate helpers.");
        restrict("publication", "Never push an open PR branch mid-run: it provisions real infrastructure and approximately 60 minutes of cloud E2E work. Batch publication until all final verification and final user consent. Exclude serviceAccount.json and docker-compose.override.yml from staging. Preserve user branch choice; otherwise retain the repository SAAS-NNNN convention.");
        restrict("migrations", "Add schema migrations only to database/migrations/NEXT.sql or NEXT.sh. Never edit released migrations. Use the existing add-migration policy and repository runner, including schema-definition upserts and no eager entity-document tables.", ["database/migrations/**"]);
        restrict("completion", "Add the appropriate project/change-type changelog fragment. Offer e2e-local for changed commodities with coverage. Never run destructive cleanup automatically. Autonomous planning reads RULES.md, docs/adr/ and consults go-domain-reviewer when relevant. Trivial and review-only modes retain every repository gate.");
        const checks: [string, string[], string[]][] = [
            ["go", ["apps/api/**", "domains/*/be/**", "platform/go/**"], ["Use repository-local GOMODCACHE and GOCACHE.", "Run go build ./apps/... ./domains/... ./platform/...", "Run go vet ./apps/... ./domains/... ./platform/...", "Run go test -count=1 -short -timeout 300s ./apps/... ./domains/... ./platform/..."]],
            ["contracts", ["contracts/**"], ["Run go generate ./tools/codegen/openapi/go", "Run pnpm openapi:ts", "Review generated output for unexpected hand-edit loss."]],
            ["always", [], ["Run NODE_OPTIONS='--max-old-space-size=10240' node_modules/.bin/biome check --max-diagnostics=20 .", "Run the license check from commands/check.md with apache/skywalking-eyes:0.8.0."]],
            ["domains", ["domains/*/fe/**"], ["Build each consuming application because root Biome configuration does not cover domains/**."]],
            ["sdk", ["packages/api-sdk/**", "packages/persistence-sdk/**"], ["Run each changed SDK package's checks and builds; persistence-sdk also runs its tests."]],
            ["admin-cli", ["apps/cli-platform-admin-v2/**", "packages/**"], ["Run apps/cli-platform-admin-v2 test, typecheck, and build commands."]],
            ["docs", ["docs/**"], ["Run python3 tools/docs/validate-agent-index.py --mode strict"]],
        ];
        for (const [id, paths, steps] of checks) {
            const requirement = { id: `palmyra-${id}`, description: `Required Palmyra ${id} verification`, scopePaths: paths, source: [ref("commands/check.md", "Repository verification gate")] };
            if (id === "docs") policy.verificationChecks.push({ ...requirement, required: true, scenario: { kind: "command", command: ["python3", "tools/docs/validate-agent-index.py", "--mode", "strict"], cwd: dirname(root) } });
            else policy.requiredVerification!.push({ ...requirement, instructions: steps.join("\n") });
        }
    }
    assertSchema(PolicyOverlaySchema, policy);
    return policy;
}
export function knownInstallManifest(options: { canonicalRoot: string; agentRoot: string; pluginRoot: string; backupRoot: string; repositories: { profile: "siftly" | "palmyra"; root: string }[]; includeProtected: boolean }): InstallManifest {
    const manifest: InstallManifest = { schemaVersion: 1, roots: [{ id: "canonical", path: options.canonicalRoot, kind: "canonical" }, { id: "global", path: options.agentRoot, kind: "global" }, ...options.repositories.map(repository => ({ id: repository.profile, path: repository.root, kind: "repository" as const }))], backupRoot: options.backupRoot, entries: [], blockers: [] };
    validateManifest(manifest);
    validateAbsolutePath(options.pluginRoot);
    const add = (root: string, relativePath: string, baselineDigests: string[], effect: InstallManifest["entries"][number]["effect"], protectedSource = false, provenance = "SHA-256 inventory of legacy Supership payload") => manifest.entries.push({ root, relativePath, baselineDigests, effect, protected: protectedSource, provenance });
    for (const root of manifest.roots) {
        if (root.kind === "canonical") {
            for (const name of ["review-orchestrator", "kimi-reviewer"]) add(root.id, `omp/agents/${name}.md`, [LEGACY_PAYLOAD[`agents/${name}.md`]!], { kind: options.includeProtected ? "remove" : "preserve" }, true, "Protected source user work; full content and individual final confirmation required");
            continue;
        }
        for (const [path, baseline] of Object.entries(LEGACY_PAYLOAD)) {
            const isCommand = path.startsWith("commands/");
            if (root.id === "palmyra" && !isCommand) continue;
            let current: Snapshot;
            try { current = snapshot(join(root.path, path)); } catch (error) {
                manifest.blockers!.push(`Inventory blocked at ${join(root.path, path)}: ${(error as Error).message}`);
                add(root.id, path, [baseline], { kind: "preserve" });
                continue;
            }
            const name = path.split("/")[1]!.replace(/\.md$/, "");
            const profileDigest = PROFILE_COMMANDS[root.id]?.[name];
            if (isCommand && current.kind !== "absent" && current.digest !== baseline && current.digest !== profileDigest) {
                manifest.blockers!.push(`Uninventoried workflow requires an explicit reviewed policy mapping: ${join(root.path, path)}`);
                add(root.id, path, [baseline], { kind: "preserve" });
                continue;
            }
            const customAgent = path.startsWith("agents/") && current.kind !== "absent" && current.digest !== baseline;
            add(root.id, path, [baseline], { kind: customAgent ? "preserve" : "remove" }, false, profileDigest ? `Known ${root.id} policy conversion, observed legacy SHA-256 ${profileDigest}; modified workflow requires per-file review` : customAgent ? "User-owned customized persona; basename grants no ownership" : "Canonical legacy SHA-256 inventory");
        }
        try {
            const policy = migrationPolicy(root.id as "global" | "siftly" | "palmyra", root.path);
            for (const reference of policy.instructionRefs) {
                if (reference.kind === "file" && !manifest.entries.some(entry => entry.root === root.id && entry.relativePath === reference.uri)) add(root.id, reference.uri, reference.digest ? [reference.digest] : [], { kind: "preserve" }, false, "Required policy source; preserve and bind its reviewed checksum");
            }
            const policyPath = join(root.path, "supership.json"), policyState = snapshot(policyPath);
            let content: Buffer = Buffer.from(JSON.stringify(policy, null, 2) + "\n");
            if (policyState.kind === "file") {
                const existing: unknown = JSON.parse(fileBytes(policyPath).toString("utf8")); assertSchema(PolicyOverlaySchema, existing);
                const prior = existing as PolicyOverlay;
                // Required replacements appear in the full-file diff; existing bytes need per-file approval.
                const merge = <T extends { id: string }>(a: T[], b: T[]) => [...a.map(old => b.find(item => item.id === old.id) ?? old), ...b.filter(item => !a.some(old => old.id === item.id))];
                const merged = { ...prior, seats: [...prior.seats, ...policy.seats.filter(seat => !prior.seats.some(old => old.seatId === seat.seatId))], requiredLenses: [...new Set([...prior.requiredLenses, ...policy.requiredLenses])], verificationChecks: merge(prior.verificationChecks, policy.verificationChecks), requiredVerification: merge(prior.requiredVerification ?? [], policy.requiredVerification ?? []), phaseGates: merge(prior.phaseGates, policy.phaseGates), pathRouting: merge(prior.pathRouting, policy.pathRouting), instructionRefs: merge(prior.instructionRefs, policy.instructionRefs) };
                content = digestJson(existing) === digestJson(merged) ? fileBytes(policyPath) : Buffer.from(JSON.stringify(merged, null, 2) + "\n");
            }
            add(root.id, "supership.json", [], { kind: "write", content: content.toString("base64"), mode: policyState.kind === "file" ? policyState.mode : 0o600 }, false, `Versioned ${root.id} policy overlay; preserve existing seats, limits, unrelated policy and configuration`);
        } catch (error) { manifest.blockers!.push(`Policy inventory blocked at ${root.path}: ${(error as Error).message}`); }
    }
    try {
        const globalPrompt = join(options.agentRoot, "APPEND_SYSTEM.md"), prompt = snapshot(globalPrompt);
        if (prompt.kind !== "absent") {
            if (prompt.kind !== "file") throw new Error(`Global APPEND_SYSTEM must be a regular file: ${globalPrompt}`);
            const prefix = fileBytes(globalPrompt).subarray(0, 4664);
            if (sha256(prefix) === "4675080d3edba717a8933306b8e29141fe4e64a8f5aa8d1e0a5ab42b3b8730a9") add("global", "APPEND_SYSTEM.md", [prompt.digest!], { kind: "strip-prefix", prefix: prefix.toString("base64"), suffixDigest: sha256(fileBytes(globalPrompt).subarray(4664)) }, false, "Exact legacy 4664-byte prefix; preserve every suffix byte");
            else if (fileBytes(globalPrompt).includes(Buffer.from("parallel(")) || fileBytes(globalPrompt).includes(Buffer.from("librarian"))) throw new Error(`Unrecognized legacy APPEND_SYSTEM prefix requires a reviewed manifest: ${globalPrompt}`);
            else add("global", "APPEND_SYSTEM.md", [], { kind: "preserve" }, false, "Unrelated or already-migrated system guidance");
        }
    } catch (error) { manifest.blockers!.push(`Inventory blocked at ${join(options.agentRoot, "APPEND_SYSTEM.md")}: ${(error as Error).message}`); }
    const packagePath = join(options.canonicalRoot, "package.json");
    try {
        const content = fileBytes(packagePath), pkg = JSON.parse(content.toString("utf8"));
        const registration = { canonicalRoot: options.canonicalRoot, pluginRoot: options.pluginRoot, packageName: pkg.name, version: pkg.version, packageDigest: sha256(content) };
        assertSchema(InstallManifestSchema.properties.registration, registration);
        manifest.registration = registration;
    } catch (error) { manifest.blockers!.push(`Inventory blocked at ${packagePath}: ${(error as Error).message}`); }
    validateManifest(manifest);
    return manifest;
}
export function defaultInstallPaths() {
    const siftly = join(homedir(), "dev/x/Siftly/.omp"), palmyra = join(homedir(), "dev/zengate-dev/pro/palmyra-pro-saas-pr-343/.omp");
    return { canonicalRoot: resolve(import.meta.dir, ".."), agentRoot: join(homedir(), ".omp", "agent"), pluginRoot: getPluginsDir(), backupRoot: join(homedir(), ".local", "state", "supership", "migrations"), siftly: existsSync(siftly) ? siftly : undefined, palmyra: existsSync(palmyra) ? palmyra : undefined };
}
