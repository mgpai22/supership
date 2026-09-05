import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Static, TProperties } from "@sinclair/typebox";
import * as Type from "@sinclair/typebox/type";
import {
  ApprovalRecordSchema, CodeIdentitySchema, CodeObservationSchema, CommitGroupSchema, DigestSchema,
  IdSchema, RelativePathSchema, RunRecordSchema, RunSlugSchema, SchemaVersion, TrustedConfirmationSchema,
  assertSchema, digestJson,
} from "./contracts.ts";
import { attributedPatch, commitGroups, currentPlanApproval, planApprovalScope } from "./engine.ts";

const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = Type.String();
const strings = Type.Array(text);
const mode = Type.Union([Type.Literal("100644"), Type.Literal("100755"), Type.Literal("120000")]);
export const FileImageSchema = object({ mode, blob: text, digest: DigestSchema, bytes: text });
const image = Type.Union([FileImageSchema, Type.Null()]);
const entry = object({ path: RelativePathSchema, image: FileImageSchema });
export const BaselineRecordSchema = object({
  schemaVersion: SchemaVersion, repo: text, gitDir: text, commonDir: text, branch: Type.Union([text, Type.Null()]),
  identity: CodeIdentitySchema, head: Type.Array(entry), index: Type.Array(entry), worktree: Type.Array(entry),
});
export const PatchEvidenceSchema = object({
  schemaVersion: SchemaVersion, source: object({ kind: Type.Union([Type.Literal("isolated"), Type.Literal("parent-callback")]), workId: IdSchema }),
  baselineDigest: DigestSchema, baseIdentity: CodeIdentitySchema, baseWorktree: Type.Array(entry),
  changes: Type.Array(object({ path: RelativePathSchema, before: image, after: image })), digest: DigestSchema,
});
export const OwnershipRecordSchema = object({ baseline: BaselineRecordSchema, patches: Type.Array(PatchEvidenceSchema) });
export const IntegrationRequestSchema = object({
  repo: text, ownership: OwnershipRecordSchema, incoming: PatchEvidenceSchema, expected: CodeIdentitySchema,
});
export const BranchRequestSchema = object({
  repo: text, slug: RunSlugSchema, userBranch: Type.Optional(text), expected: CodeIdentitySchema,
  planApproved: Type.Boolean(), needed: Type.Boolean(),
});
// `authorization` is null only for a review-only run: its invocation requested commits and its scope plan carries no approval record.
export const CommitPlanSchema = object({
  schemaVersion: SchemaVersion, repo: text, expected: CodeIdentitySchema, branch: text,
  planRevision: Type.Integer({ minimum: 0 }), ownerEpoch: Type.Integer({ minimum: 0 }), requested: Type.Boolean(),
  groups: Type.Array(object({ group: CommitGroupSchema, tree: text })), finalIndexTree: text, scopeHash: DigestSchema,
  authorization: Type.Union([ApprovalRecordSchema, Type.Null()]), invocationDigest: DigestSchema, approvedPlanHash: DigestSchema,
});
export const CommitConsentSchema = object({ approval: CommitPlanSchema.properties.authorization, reviewedPlanHash: DigestSchema });
export const PushPlanSchema = object({
  schemaVersion: SchemaVersion, repo: text, remote: text, url: text, branch: text, head: text,
  remoteHead: Type.Union([text, Type.Null()]), commits: Type.Array(text, { minItems: 1 }), expected: CodeIdentitySchema,
  planRevision: Type.Integer({ minimum: 0 }), ownerEpoch: Type.Integer({ minimum: 0 }), scopeHash: DigestSchema,
});
export const PushRequestSchema = object({ repo: text, remote: text, branch: text, commits: Type.Array(text, { minItems: 1 }), requested: Type.Boolean(), expected: CodeIdentitySchema, planRevision: Type.Integer({ minimum: 0 }), ownerEpoch: Type.Integer({ minimum: 0 }) });
export const IntegrationDecisionSchema = Type.Union([object({ kind: Type.Literal("ready"), changes: PatchEvidenceSchema.properties.changes }), object({ kind: Type.Literal("pause"), reason: text, paths: strings })]);
export const IntegrationEvidenceSchema = object({ before: CodeIdentitySchema, after: CodeIdentitySchema, patch: PatchEvidenceSchema, parentEffects: Type.Array(PatchEvidenceSchema) });
export const GitOperationEvidenceSchema = object({ operation: Type.Union([Type.Literal("branch"), Type.Literal("commit"), Type.Literal("push")]), before: CodeIdentitySchema, after: CodeIdentitySchema, branch: text, commits: strings, remote: Type.Optional(text) });
export const ReviewScopeSchema = object({ kind: Type.Union([Type.Literal("explicit"), Type.Literal("dirty"), Type.Literal("merge-base")]), base: text, head: text, paths: strings, patch: text, stagedPatch: text, unstagedPatch: text, untracked: Type.Array(entry), identity: CodeIdentitySchema });
export type FileImage = Static<typeof FileImageSchema>;
export type BaselineRecord = Static<typeof BaselineRecordSchema>;
export type PatchEvidence = Static<typeof PatchEvidenceSchema>;
export type OwnershipRecord = Static<typeof OwnershipRecordSchema>;
export type IntegrationRequest = Static<typeof IntegrationRequestSchema>;
export type BranchRequest = Static<typeof BranchRequestSchema>;
export type CommitPlan = Static<typeof CommitPlanSchema>;
export type CommitConsent = Static<typeof CommitConsentSchema>;
export type PushPlan = Static<typeof PushPlanSchema>;
type CodeIdentity = Static<typeof CodeIdentitySchema>;
type CodeObservation = Static<typeof CodeObservationSchema>;
type RunRecord = Static<typeof RunRecordSchema>;
type TrustedConfirmation = Static<typeof TrustedConfirmationSchema>;
type FileEntry = Static<typeof entry>;
type Images = Map<string, FileImage>;
export type IntegrationDecision = Static<typeof IntegrationDecisionSchema>;
export type IntegrationEvidence = Static<typeof IntegrationEvidenceSchema>;
export type GitOperationEvidence = Static<typeof GitOperationEvidenceSchema>;
export type ReviewScope = Static<typeof ReviewScopeSchema>;
export type PushRequest = Static<typeof PushRequestSchema>;

/** The caller converts a pause into the engine's recovery decision. No operation retries a mutation. */
export class GitPause extends Error {
  constructor(message: string, readonly paths: string[] = []) { super(message); this.name = "GitPause"; }
}

function git(repo: string, args: string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}, allowFailure = false) {
  // Do not inherit a caller's alternate index or object directory into a different repository.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete (env as NodeJS.ProcessEnv)[key];
  const result = spawnSync("git", ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
    cwd: repo, env: { ...env, ...extraEnv }, input, maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new GitPause(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result;
}
const out = (repo: string, args: string[]) => git(repo, args).stdout.toString().trim();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const map = (entries: FileEntry[]): Images => new Map(entries.map(entry => [entry.path, entry.image]));
const entries = (images: Images): FileEntry[] => [...images].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, image]) => ({ path, image }));
const same = (a: FileImage | undefined | null, b: FileImage | undefined | null) => (!a && !b) || (!!a && !!b && a.mode === b.mode && a.blob === b.blob && a.digest === b.digest && a.bytes === b.bytes);
const bytes = (image: FileImage) => Buffer.from(image.bytes, "base64");
const objectFormats = new Map<string, "sha1" | "sha256">();
function fileImage(repo: string, content: Buffer, mode: FileImage["mode"]): FileImage {
  let format = objectFormats.get(repo);
  if (!format) {
    const observed = out(repo, ["rev-parse", "--show-object-format"]);
    if (observed !== "sha1" && observed !== "sha256") throw new GitPause("Unsupported Git object format");
    format = observed; objectFormats.set(repo, format);
  }
  const blob = createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
  return { mode, blob, digest: hash(content), bytes: content.toString("base64") };
}
function pathSafe(path: string) {
  assertSchema(RelativePathSchema, path, "Git path");
  if (path.split("/").some(part => !part || part.toLowerCase() === ".git")) throw new GitPause("Git metadata or noncanonical paths cannot be output", [path]);
}
function verifyImage(repo: string, image: FileImage) {
  const content = bytes(image);
  if (content.toString("base64") !== image.bytes || hash(content) !== image.digest || fileImage(repo, content, image.mode).blob !== image.blob) throw new GitPause("File image identity does not match its bytes");
}
function verifyBaseline(baseline: BaselineRecord) {
  assertSchema(BaselineRecordSchema, baseline, "Git baseline");
  for (const layer of [baseline.head, baseline.index, baseline.worktree]) {
    const seen = new Set<string>();
    for (const item of layer) {
      pathSafe(item.path);
      if (seen.has(item.path)) throw new GitPause("Duplicate baseline path", [item.path]);
      seen.add(item.path); verifyImage(baseline.repo, item.image);
    }
  }
  if (digestJson(baseline.worktree) !== baseline.identity.worktreeDigest) throw new GitPause("Baseline worktree digest mismatch");
  if (resolvedCommit(baseline.repo, baseline.identity.head) !== baseline.identity.head || digestJson(treeImages(baseline.repo, baseline.identity.head)) !== digestJson(baseline.head) || tree(baseline.repo, map(baseline.index)) !== baseline.identity.indexTree) throw new GitPause("Baseline HEAD or index identity mismatch");
}
function temporary<T>(operation: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "supership-git-"));
  try { return operation(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function tree(repo: string, images: Images): string {
  return temporary(directory => {
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    git(repo, ["read-tree", "--empty"], undefined, env);
    const records: string[] = [];
    for (const [path, image] of images) {
      pathSafe(path); verifyImage(repo, image);
      git(repo, ["hash-object", "-w", "--stdin"], bytes(image));
      records.push(`${image.mode} ${image.blob}\t${path}\0`);
    }
    if (records.length) git(repo, ["update-index", "-z", "--index-info"], records.join(""), env);
    return git(repo, ["write-tree"], undefined, env).stdout.toString().trim();
  });
}
function treeImages(repo: string, ref: string): FileEntry[] {
  const rows = git(repo, ["ls-tree", "-rz", "--full-tree", ref]).stdout.toString().split("\0").filter(Boolean);
  return rows.map(row => {
    const split = row.indexOf("\t"); const [mode, kind, blob] = row.slice(0, split).split(" "); const path = row.slice(split + 1);
    pathSafe(path);
    if (kind !== "blob" || !["100644", "100755", "120000"].includes(mode)) throw new GitPause("Submodules and special files require separate ownership", [path]);
    return { path, image: fileImage(repo, git(repo, ["cat-file", "blob", blob]).stdout, mode as FileImage["mode"]) };
  });
}
function parentEffectsDigest(parentEffects: PatchEvidence[]): string {
  // Code identity describes net endpoints; the ledger retains attribution and intermediate changes.
  const net = new Map<string, PatchEvidence["changes"][number]>();
  for (const patch of parentEffects) for (const change of patch.changes) {
    const prior = net.get(change.path);
    if (prior) prior.after = change.after;
    else net.set(change.path, { path: change.path, before: change.before, after: change.after });
  }
  return digestJson([...net.values()].filter(change => !same(change.before, change.after)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function identity(head: string, indexTree: string, worktree: FileEntry[], scope: string[] = [], parentEffects: PatchEvidence[] = []): CodeIdentity {
  return { head, indexTree, worktreeDigest: digestJson(worktree), scopeDigest: digestJson(worktree.filter(item => !scope.length || scope.some(path => item.path === path || item.path.startsWith(`${path}/`)))), parentEffectDigest: parentEffectsDigest(parentEffects) };
}
function assertIdentity(expected: CodeIdentity, current: CodeIdentity) {
  if (expected.head !== current.head || expected.indexTree !== current.indexTree || expected.worktreeDigest !== current.worktreeDigest) throw new GitPause("Repository changed since the reviewed observation");
}

/** Includes raw staged, unstaged, untracked and symlink bytes, independent of Git filters. */
export async function captureBaseline(repo: string): Promise<BaselineRecord> {
  repo = realpathSync(out(repo, ["rev-parse", "--show-toplevel"]));
  const head = out(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const gitDir = out(repo, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = resolve(repo, out(repo, ["rev-parse", "--git-common-dir"]));
  const branchResult = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], undefined, {}, true);
  const flags = git(repo, ["ls-files", "-v", "-z"]).stdout.toString().split("\0").filter(Boolean);
  if (flags.some(row => row[0] === "S" || row[0] === row[0].toLowerCase())) throw new GitPause("Sparse or assume-unchanged index entries require reconciliation");
  const debug = git(repo, ["ls-files", "--debug"]).stdout.toString();
  if ([...debug.matchAll(/flags: ([0-9a-f]+)/g)].some(match => (parseInt(match[1], 16) & 0x20000000) !== 0)) throw new GitPause("Intent-to-add entries require reconciliation");
  const staged = git(repo, ["ls-files", "--stage", "-z"]).stdout.toString().split("\0").filter(Boolean);
  const index = staged.map(row => {
    const split = row.indexOf("\t"); const [mode, blob, stage] = row.slice(0, split).split(" "); const path = row.slice(split + 1);
    pathSafe(path);
    if (stage !== "0") throw new GitPause("The index contains unresolved conflicts", [path]);
    if (!["100644", "100755", "120000"].includes(mode)) throw new GitPause("Submodule ownership is not a file patch", [path]);
    return { path, image: fileImage(repo, git(repo, ["cat-file", "blob", blob]).stdout, mode as FileImage["mode"]) };
  });
  const headImages = treeImages(repo, head);
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.toString().split("\0").filter(Boolean);
  const worktree: FileEntry[] = [];
  for (const path of [...new Set([...headImages.map(item => item.path), ...index.map(item => item.path), ...untracked])].sort()) {
    pathSafe(path);
    const absolute = join(repo, path);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    // A replaced parent symlink must never cause reads or writes outside the checkout.
    if (realpathSync(dirname(absolute)) !== dirname(absolute)) throw new GitPause("Path has a symlink ancestor", [path]);
    if (stat.isDirectory()) continue; // A tracked file may have become a directory of untracked files.
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new GitPause("Special file replaced a tracked path", [path]);
    const content = stat.isSymbolicLink() ? readlinkSync(absolute, { encoding: "buffer" }) : readFileSync(absolute);
    worktree.push({ path, image: fileImage(repo, content, stat.isSymbolicLink() ? "120000" : stat.mode & 0o100 ? "100755" : "100644") });
  }
  const result: BaselineRecord = { schemaVersion: 1, repo, gitDir, commonDir, branch: branchResult.status === 0 ? branchResult.stdout.toString().trim() : null, identity: identity(head, tree(repo, map(index)), worktree), head: headImages, index, worktree };
  if (out(repo, ["rev-parse", "HEAD"]) !== head || git(repo, ["ls-files", "--stage", "-z"]).stdout.toString().split("\0").filter(Boolean).join("\0") !== staged.join("\0")) throw new GitPause("Repository changed during baseline capture");
  return result;
}

export async function observeCode(repo: string, scope: string[], parentEffects: PatchEvidence[] = []): Promise<CodeObservation> {
  scope.forEach(pathSafe);
  const baseline = await captureBaseline(repo); const head = map(baseline.head); const index = map(baseline.index); const worktree = map(baseline.worktree);
  return {
    identity: identity(baseline.identity.head, baseline.identity.indexTree, baseline.worktree, scope, parentEffects),
    paths: [...new Set([...head.keys(), ...index.keys(), ...worktree.keys()])].sort().filter(path => !scope.length || scope.some(root => path === root || path.startsWith(`${root}/`))).map(path => {
      const before = head.get(path); const current = worktree.get(path);
      return { path, ...(before ? { baselineDigest: before.digest } : {}), ...(current ? { currentDigest: current.digest } : {}), kind: !current ? "deleted" : current.mode === "120000" ? "symlink" : !before && !index.has(path) ? "untracked" : "tracked", staged: !same(before, index.get(path)) };
    }), evidence: [], observedAt: Date.now(),
  };
}
function differences(before: Images, after: Images): PatchEvidence["changes"] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => !same(before.get(path), after.get(path))).map(path => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
}
export function capturePatch(before: BaselineRecord, after: BaselineRecord, source: PatchEvidence["source"], expectedPaths: string[]): PatchEvidence {
  verifyBaseline(before); verifyBaseline(after); expectedPaths.forEach(pathSafe);
  if (before.repo !== after.repo || before.identity.head !== after.identity.head) throw new GitPause("Patch capture crossed repository or HEAD identity");
  const changes = differences(map(before.worktree), map(after.worktree));
  const unexpected = changes.filter(change => !expectedPaths.some(path => change.path === path || change.path.startsWith(`${path}/`))).map(change => change.path);
  if (unexpected.length) throw new GitPause("Patch changed paths outside its assignment", unexpected);
  const body = { schemaVersion: 1 as const, source, baselineDigest: digestJson({ identity: before.identity, worktree: before.worktree }), baseIdentity: before.identity, baseWorktree: before.worktree, changes };
  const patch = { ...body, digest: digestJson(body) }; assertSchema(PatchEvidenceSchema, patch); return patch;
}
function verifyPatch(repo: string, patch: PatchEvidence) {
  assertSchema(PatchEvidenceSchema, patch, "patch evidence");
  const { digest, ...body } = patch;
  if (digestJson(body) !== digest) throw new GitPause("Patch evidence digest mismatch");
  if (digestJson({ identity: patch.baseIdentity, worktree: patch.baseWorktree }) !== patch.baselineDigest || digestJson(patch.baseWorktree) !== patch.baseIdentity.worktreeDigest) throw new GitPause("Patch baseline identity mismatch");
  const captured = map(patch.baseWorktree);
  if (captured.size !== patch.baseWorktree.length) throw new GitPause("Duplicate patch baseline path");
  for (const item of patch.baseWorktree) { pathSafe(item.path); verifyImage(repo, item.image); }
  const seen = new Set<string>();
  for (const change of patch.changes) {
    pathSafe(change.path);
    if (!same(captured.get(change.path), change.before)) throw new GitPause("Patch before image differs from its captured baseline", [change.path]);
    if (seen.has(change.path) || same(change.before, change.after)) throw new GitPause("Duplicate or empty patch change", [change.path]);
    seen.add(change.path);
    if (change.before) verifyImage(repo, change.before);
    if (change.after) verifyImage(repo, change.after);
  }
}
function merged(repo: string, path: string, base: FileImage | null | undefined, current: FileImage | null | undefined, incoming: FileImage | null | undefined, alreadyAttributed = false): FileImage | null {
  if (same(base, incoming)) return current ?? null;
  if (same(base, current) || alreadyAttributed && same(current, incoming)) return incoming ?? null;
  if (same(current, incoming) || !base || !current || !incoming) throw new GitPause("Overlapping or ambiguous file ownership", [path]);
  if ([base, current, incoming].some(image => image.mode === "120000")) throw new GitPause("Overlapping symlink ownership", [path]);
  const targetMode = base.mode === current.mode ? incoming.mode : base.mode === incoming.mode || alreadyAttributed && current.mode === incoming.mode ? current.mode : null;
  if (!targetMode) throw new GitPause("Overlapping file mode ownership", [path]);
  const baseBytes = bytes(base), currentBytes = bytes(current), incomingBytes = bytes(incoming);
  if (baseBytes.equals(currentBytes)) return fileImage(repo, incomingBytes, targetMode);
  if (baseBytes.equals(incomingBytes)) return fileImage(repo, currentBytes, targetMode);
  if ([baseBytes, currentBytes, incomingBytes].some(content => content.includes(0))) throw new GitPause("Overlapping binary ownership", [path]);
  return temporary(directory => {
    const files = ["current", "base", "incoming"].map(name => join(directory, name));
    [currentBytes, baseBytes, incomingBytes].forEach((content, index) => writeFileSync(files[index], content));
    if (!alreadyAttributed) {
      const ranges = [files[0], files[2]].map(file => {
        const diff = git(repo, ["diff", "--no-index", "--text", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--", files[1], file], undefined, {}, true);
        if (diff.status !== 1) throw new GitPause("Cannot establish text hunk ownership", [path]);
        const hunks = [...diff.stdout.toString().matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map(match => {
          const count = match[2] === undefined ? 1 : Number(match[2]); const start = Number(match[1]) - (count ? 1 : 0);
          return { start, end: start + count };
        });
        if (!hunks.length) throw new GitPause("Cannot establish text hunk ownership", [path]);
        return hunks;
      });
      const overlaps = ranges[0].some(left => ranges[1].some(right => left.start === left.end || right.start === right.end
        ? Math.max(left.start, right.start) <= Math.min(left.end, right.end)
        : Math.max(left.start, right.start) < Math.min(left.end, right.end)));
      if (overlaps) throw new GitPause("Overlapping or ambiguous text hunks", [path]);
    }
    const result = git(repo, ["merge-file", "--stdout", ...files], undefined, {}, true);
    if (result.status !== 0) throw new GitPause("Overlapping or ambiguous text hunks", [path]);
    return fileImage(repo, result.stdout, targetMode);
  });
}
function applyChanges(repo: string, target: Images, changes: PatchEvidence["changes"], alreadyAttributed = false): Images {
  const result = new Map(target);
  for (const change of changes) {
    const image = merged(repo, change.path, change.before, target.get(change.path), change.after, alreadyAttributed);
    if (image) result.set(change.path, image); else result.delete(change.path);
  }
  return result;
}
function attributable(ownership: OwnershipRecord): Images {
  const { baseline, patches } = ownership; verifyBaseline(baseline);
  let output = map(baseline.worktree);
  for (const patch of patches) { verifyPatch(baseline.repo, patch); output = applyChanges(baseline.repo, output, patch.changes); }
  // Remove unstaged then staged user changes separately, including staged changes reversed in the worktree.
  const stagedOutput = applyChanges(baseline.repo, map(baseline.index), differences(map(baseline.worktree), output));
  return applyChanges(baseline.repo, map(baseline.head), differences(map(baseline.index), stagedOutput));
}

/** The full observation is required: filenames or CodeIdentity alone cannot prove hunk ownership. */
export function checkIntegration(baseline: BaselineRecord, current: BaselineRecord, incoming: PatchEvidence, prior: PatchEvidence[] = []): IntegrationDecision {
  try {
    verifyBaseline(current); verifyPatch(baseline.repo, incoming);
    if (baseline.repo !== current.repo || baseline.identity.head !== current.identity.head || incoming.baseIdentity.head !== current.identity.head) throw new GitPause("Integration HEAD or repository changed");
    if (incoming.source.kind !== "isolated") throw new GitPause("Parent callbacks already affect the parent; record them separately, never integrate them");
    attributable({ baseline, patches: [...prior, incoming] });
    const result = applyChanges(baseline.repo, map(current.worktree), incoming.changes);
    // A staged concurrent edit cannot be hidden by an inverse unstaged edit.
    const indexedPrior = applyChanges(baseline.repo, map(current.index), differences(map(baseline.head), attributable({ baseline, patches: prior })), true);
    applyChanges(baseline.repo, indexedPrior, incoming.changes);
    return { kind: "ready", changes: differences(map(current.worktree), result) };
  } catch (error) {
    if (!(error instanceof GitPause)) throw error;
    return { kind: "pause", reason: error.message, paths: error.paths };
  }
}
async function locked<T>(repo: string, operation: () => Promise<T>): Promise<T> {
  if (realpathSync(repo) !== realpathSync(out(repo, ["rev-parse", "--show-toplevel"]))) throw new GitPause("Git output operations require the repository root");
  const common = resolve(repo, out(repo, ["rev-parse", "--git-common-dir"]));
  const lock = join(common, "supership-output.lock");
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); } catch { throw new GitPause("Another Git output operation owns this repository; reconcile a stale lock before retry"); }
  try { writeFileSync(fd, `${process.pid}\n`); return await operation(); } finally { closeSync(fd); rmSync(lock); }
}
function diffTrees(repo: string, before: Images, after: Images): Buffer {
  return git(repo, ["diff-tree", "-r", "-p", "--binary", "--full-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames", tree(repo, before), tree(repo, after), "--"]).stdout;
}
function preflightImages(repo: string, changes: PatchEvidence["changes"], desired: Images): string[] {
  for (const path of desired.keys()) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (desired.has(path.slice(0, slash))) throw new GitPause("Output paths collide as files and directories", [path]);
    }
  }
  const removals = new Set(changes.filter(change => !change.after).map(change => change.path));
  const directories = new Set<string>();
  const emptyAfterRemovals = (path: string) => {
    for (const child of readdirSync(join(repo, path), { withFileTypes: true })) {
      const nested = `${path}/${child.name}`;
      if (child.isDirectory()) emptyAfterRemovals(nested);
      else if (!removals.has(nested)) throw new GitPause("Directory replacement would remove unowned contents", [nested]);
    }
    directories.add(path);
  };
  for (const change of changes.filter(change => change.after)) {
    const parts = change.path.split("/"); let replacedParent = false;
    for (let length = 1; length < parts.length; length++) {
      const parent = parts.slice(0, length).join("/"); const stat = lstatSync(join(repo, parent), { throwIfNoEntry: false });
      if (!stat) break;
      if (!stat.isDirectory()) {
        if (!removals.has(parent)) throw new GitPause("Output has a non-directory or symlink ancestor", [parent]);
        replacedParent = true; break;
      }
    }
    if (!replacedParent && lstatSync(join(repo, change.path), { throwIfNoEntry: false })?.isDirectory()) emptyAfterRemovals(change.path);
  }
  return [...directories].sort((left, right) => right.split("/").length - left.split("/").length);
}
function writeImages(repo: string, changes: PatchEvidence["changes"], directories: string[]) {
  try {
    for (const change of changes.filter(change => !change.after)) unlinkSync(join(repo, change.path));
    for (const path of directories) rmdirSync(join(repo, path));
    for (const change of changes) {
      if (!change.after) continue;
      const path = join(repo, change.path);
      let existingParent = dirname(path);
      while (!lstatSync(existingParent, { throwIfNoEntry: false })) existingParent = dirname(existingParent);
      if (realpathSync(existingParent) !== existingParent || !lstatSync(existingParent).isDirectory()) throw new GitPause("Output ancestor changed during integration", [change.path]);
      mkdirSync(dirname(path), { recursive: true });
      if (realpathSync(dirname(path)) !== dirname(path)) throw new GitPause("Output ancestor changed during integration", [change.path]);
      const previous = lstatSync(path, { throwIfNoEntry: false });
      const staging = mkdtempSync(join(dirname(path), ".supership-write-"));
      try {
        const next = join(staging, "image");
        if (change.after.mode === "120000") symlinkSync(bytes(change.after), next);
        else {
          writeFileSync(next, bytes(change.after), { mode: 0o600 });
          const permissions = previous?.isFile() && change.before?.mode === change.after.mode ? previous.mode & 0o777 : (change.after.mode === "100755" ? 0o755 : 0o644) & ~process.umask();
          chmodSync(next, permissions);
        }
        renameSync(next, path);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
  } catch (error) {
    throw new GitPause(`Integration stopped after filesystem effects may have begun; inspect before retry: ${error instanceof Error ? error.message : String(error)}`, changes.map(change => change.path));
  }
}
export async function integrateChecked(request: IntegrationRequest): Promise<IntegrationEvidence> {
  assertSchema(IntegrationRequestSchema, request);
  return locked(request.repo, async () => {
    const current = await captureBaseline(request.repo); assertIdentity(request.expected, current.identity);
    const indexLock = join(current.gitDir, "index.lock");
    let fd: number;
    try { fd = openSync(indexLock, "wx", 0o600); } catch { throw new GitPause("Git index is locked; integration has not started"); }
    try {
      const decision = checkIntegration(request.ownership.baseline, current, request.incoming, request.ownership.patches);
      if (decision.kind === "pause") throw new GitPause(decision.reason, decision.paths);
      const desired = applyChanges(request.repo, map(current.worktree), decision.changes);
      const directories = preflightImages(request.repo, decision.changes, desired);
      assertIdentity(current.identity, (await captureBaseline(request.repo)).identity);
      // Git apply runs clean/smudge/EOL filters. Raw atomic file replacement preserves the reviewed bytes.
      // Cooperating writers hold locks; raw parent callbacks must settle before this boundary.
      writeImages(request.repo, decision.changes, directories);
      const after = await captureBaseline(request.repo);
      if (after.identity.indexTree !== current.identity.indexTree || digestJson(after.worktree) !== digestJson(entries(desired))) throw new GitPause("Repository changed during integration; inspect the partial effects before retry", decision.changes.map(change => change.path));
      return { before: current.identity, after: after.identity, patch: request.incoming, parentEffects: request.ownership.patches.filter(patch => patch.source.kind === "parent-callback") };
    } finally { closeSync(fd); rmSync(indexLock); }
  });
}
function defaultBranches(repo: string): string[] {
  const refs = out(repo, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"]).split("\n");
  const configured = git(repo, ["config", "--get", "init.defaultBranch"], undefined, {}, true).stdout.toString().trim();
  const remoteDefaults = refs.filter(row => /\/HEAD /.test(row)).map(row => {
    const [headRef, target] = row.split(" "); const prefix = headRef.slice(0, -4);
    if (!target.startsWith(prefix)) throw new GitPause("Remote default reference crosses remote namespaces; reconcile it before output");
    return target.slice(prefix.length);
  });
  return [...new Set(["main", "master", configured, ...remoteDefaults])].filter(Boolean);
}
function validBranch(repo: string, branch: string) {
  if (!branch || branch.startsWith("-") || git(repo, ["check-ref-format", `refs/heads/${branch}`], undefined, {}, true).status !== 0) throw new GitPause("Invalid output branch");
}
function outputBranch(repo: string, branch: string | null) {
  if (!branch) throw new GitPause("Detached HEAD cannot receive Supership commits");
  const defaults = defaultBranches(repo);
  if (defaults.includes(branch)) throw new GitPause("Supership never commits or pushes to a default branch");
  const refs = out(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).split("\n");
  if (!defaults.some(name => refs.some(ref => ref === `refs/heads/${name}` || ref.startsWith("refs/remotes/") && ref.split("/").slice(3).join("/") === name))) throw new GitPause("Default branch is unverified; select or configure its local reference before output");
  validBranch(repo, branch);
}
export async function createOutputBranch(request: BranchRequest): Promise<GitOperationEvidence> {
  assertSchema(BranchRequestSchema, request);
  return locked(request.repo, async () => {
    const before = await captureBaseline(request.repo); assertIdentity(request.expected, before.identity);
    const branch = request.userBranch ?? `supership/${request.slug}`;
    validBranch(request.repo, branch);
    if (request.needed) {
      if (!request.planApproved) throw new GitPause("Output branch creation requires plan approval");
      outputBranch(request.repo, branch);
      if (before.branch !== branch) {
        const exists = git(request.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], undefined, {}, true).status === 0;
        if (exists && out(request.repo, ["rev-parse", `refs/heads/${branch}`]) !== before.identity.head) throw new GitPause("Requested branch points at different code; reconcile before switching");
        git(request.repo, ["switch", ...(exists ? [branch] : ["-c", branch])]);
      }
    }
    return { operation: "branch", before: before.identity, after: (await captureBaseline(request.repo)).identity, branch: request.needed ? branch : before.branch ?? "", commits: [] };
  });
}
function resolvedCommit(repo: string, revision: string): string {
  return out(repo, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
}
export async function selectReviewScope(repo: string, base?: string): Promise<ReviewScope> {
  const baseline = await captureBaseline(repo);
  let kind: ReviewScope["kind"];
  let selected: string;
  if (base !== undefined) { if (!base.trim()) throw new GitPause("Explicit review base is empty"); selected = resolvedCommit(repo, base); kind = "explicit"; }
  else if (differences(map(baseline.head), map(baseline.index)).length || differences(map(baseline.index), map(baseline.worktree)).length) { selected = baseline.identity.head; kind = "dirty"; }
  else {
    const symbolic = out(repo, ["for-each-ref", "--format=%(symref)", "refs/remotes"]).split("\n").filter(Boolean);
    const defaults = symbolic.length ? symbolic : ["main", "master"].filter(branch => git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], undefined, {}, true).status === 0).map(branch => `refs/heads/${branch}`);
    const tips = [...new Set(defaults.map(ref => resolvedCommit(repo, ref)))];
    if (tips.length !== 1) throw new GitPause("No unambiguous verified default branch; select an explicit review base");
    const bases = out(repo, ["merge-base", "--all", baseline.identity.head, tips[0]]).split("\n").filter(Boolean);
    if (bases.length !== 1) throw new GitPause("Default branch has no unique merge base; select an explicit review base");
    selected = bases[0]; kind = "merge-base";
  }
  const baseImages = map(treeImages(repo, selected));
  const paths = [...new Set([...differences(baseImages, map(baseline.index)), ...differences(baseImages, map(baseline.worktree))].map(change => change.path))].sort();
  if (!paths.length) throw new GitPause("Review scope is empty; select an explicit base with changes");
  const head = map(baseline.head), index = map(baseline.index), worktree = map(baseline.worktree);
  return { kind, base: selected, head: baseline.identity.head, paths, patch: diffTrees(repo, baseImages, worktree).toString("base64"), stagedPatch: diffTrees(repo, baseImages, index).toString("base64"), unstagedPatch: diffTrees(repo, index, worktree).toString("base64"), untracked: baseline.worktree.filter(item => !index.has(item.path) && !head.has(item.path)), identity: baseline.identity };
}

/** Only observed, attributed output may enter the approved plan's logical commit groups. */
export async function prepareCommitGroups(state: RunRecord, observation: CodeObservation, ownership: OwnershipRecord): Promise<CommitPlan> {
  assertSchema(RunRecordSchema, state); assertSchema(CodeObservationSchema, observation); assertSchema(OwnershipRecordSchema, ownership);
  const repo = state.repository.root; const current = await captureBaseline(repo); assertIdentity(observation.identity, current.identity);
  if (!state.invocation.commitRequested) throw new GitPause("Commits were not requested");
  if (!state.plan || state.phase !== "commit" || state.lifecycle !== "active") throw new GitPause("Commit requires the approved, reviewed and verified commit phase");
  if (!state.code) throw new GitPause("Commit requires a reviewed code observation");
  assertIdentity(state.code.identity, current.identity);
  if (state.code.identity.parentEffectDigest !== parentEffectsDigest(ownership.patches.filter(patch => patch.source.kind === "parent-callback"))) throw new GitPause("Parent callback effects differ from the reviewed observation");
  const authorization = currentPlanApproval(state) ?? null;
  if (!authorization && state.invocation.mode !== "review-only") throw new GitPause("Commit plan lacks current approval");
  for (const check of state.plan.verificationChecks.filter(check => check.required)) {
    if (!state.verification.some(result => result.checkId === check.id && result.outcome === "passed" && digestJson(result.codeIdentity) === digestJson(state.code!.identity))) throw new GitPause(`Required verification is stale or missing: ${check.id}`);
  }
  if (state.findings.some(finding => finding.verdicts.some(verdict => verdict.verdict === "accepted") && !finding.resolution)) throw new GitPause("Accepted review findings remain unresolved");
  outputBranch(repo, current.branch);
  if (ownership.baseline.repo !== current.repo || ownership.baseline.identity.head !== current.identity.head || digestJson(ownership.baseline) !== state.repository.baselineDigest) throw new GitPause("Commit baseline differs from the recorded run baseline");
  // Attribution follows work disposition: a patch from discarded or failed work stays in the checkout as unattributed bytes, and the
  // same ownership checks that protect user hunks then protect against sweeping those bytes into a commit.
  const owned: OwnershipRecord = { ...ownership, patches: ownership.patches.filter(patch => attributedPatch(state, patch.source.workId)) };
  const cleanOutput = attributable(owned);
  // All attributed output must remain present, even when external changes are independent.
  const ownedWork = owned.patches.reduce((work, patch) => applyChanges(repo, work, patch.changes), map(ownership.baseline.worktree));
  applyChanges(repo, map(ownership.baseline.worktree), differences(ownedWork, map(current.worktree)));
  const effectiveGroups = commitGroups(state);
  const workGroups = new Map<string, string>(); const completed = new Set<string>();
  for (const group of effectiveGroups) {
    if (completed.has(group.id) || group.dependencies.some(id => !completed.has(id))) throw new GitPause("Commit groups have duplicate or out-of-order dependencies");
    completed.add(group.id);
    for (const id of group.workIds) { if (workGroups.has(id)) throw new GitPause("Work appears in multiple commit groups"); workGroups.set(id, group.id); }
  }
  if (owned.patches.some(patch => !workGroups.has(patch.source.workId))) throw new GitPause("Attributed output is absent from the approved commit groups");
  let grouped = map(ownership.baseline.worktree); let previousClean = map(ownership.baseline.head);
  const groups: CommitPlan["groups"] = [];
  for (const group of effectiveGroups) {
    const patches = owned.patches.filter(patch => workGroups.get(patch.source.workId) === group.id);
    if (patches.some(patch => patch.changes.some(change => !group.paths.some(path => change.path === path || change.path.startsWith(`${path}/`))))) throw new GitPause("Commit output exceeds its approved group paths");
    for (const patch of patches) grouped = applyChanges(repo, grouped, patch.changes);
    const stage = applyChanges(repo, map(ownership.baseline.index), differences(map(ownership.baseline.worktree), grouped));
    const clean = applyChanges(repo, map(ownership.baseline.head), differences(map(ownership.baseline.index), stage));
    if (differences(previousClean, clean).length) groups.push({ group, tree: tree(repo, clean) });
    previousClean = clean;
  }
  if (digestJson(entries(previousClean)) !== digestJson(entries(cleanOutput))) throw new GitPause("Commit group order changes attributed output");
  if (!groups.length) throw new GitPause("There is no attributed output to commit");
  // Rebase only generated hunks into the real index. User staged hunks stay staged after HEAD advances.
  const finalIndexTree = tree(repo, applyChanges(repo, map(current.index), differences(map(ownership.baseline.head), cleanOutput), true));
  const body = { schemaVersion: 1 as const, repo, expected: observation.identity, branch: current.branch!, planRevision: state.plan.revision, ownerEpoch: state.owner.epoch, requested: true, groups, finalIndexTree, authorization, invocationDigest: digestJson(state.invocation), approvedPlanHash: planApprovalScope(state.plan) };
  return { ...body, scopeHash: digestJson(body) };
}
function planUnchanged(plan: CommitPlan | PushPlan) {
  const { scopeHash, ...body } = plan;
  if (digestJson(body) !== scopeHash) throw new GitPause("Output plan changed after preparation");
}
function commitConsentMatches(plan: CommitPlan, consent: CommitConsent) {
  assertSchema(CommitConsentSchema, consent); planUnchanged(plan);
  const approval = consent.approval;
  if (!plan.requested || digestJson(approval) !== digestJson(plan.authorization) || consent.reviewedPlanHash !== plan.approvedPlanHash) throw new GitPause("Commit consent differs from the recorded plan approval");
  if (approval && (approval.decision !== "approve" || !["initial-plan", "material-amendment", "safety"].includes(approval.kind) || approval.ownerEpoch > plan.ownerEpoch)) throw new GitPause("Commit consent differs from the recorded plan approval");
}
function pushConfirmationMatches(plan: PushPlan, confirmation: TrustedConfirmation) {
  assertSchema(TrustedConfirmationSchema, confirmation); planUnchanged(plan);
  const approval = confirmation.approval, scopeHash = plan.scopeHash;
  if (approval.authority !== "omp-tui" || approval.decision !== "approve" || approval.kind !== "push" || approval.scopeHash !== scopeHash || confirmation.reviewedPlanHash !== scopeHash || approval.ownerEpoch !== plan.ownerEpoch || approval.planRevision !== plan.planRevision) throw new GitPause("Final TUI confirmation does not match this exact output plan");
}
/** Consent is the recorded plan approval, or for a review-only run the invocation's own commit request over the reviewed scope plan. */
export async function commitApproved(plan: CommitPlan, consent: CommitConsent): Promise<GitOperationEvidence> {
  assertSchema(CommitPlanSchema, plan); commitConsentMatches(plan, consent);
  if (!plan.requested) throw new GitPause("Commits were not requested");
  return locked(plan.repo, async () => {
    const current = await captureBaseline(plan.repo); assertIdentity(plan.expected, current.identity); outputBranch(plan.repo, current.branch);
    if (current.branch !== plan.branch || !plan.groups.length) throw new GitPause("Commit branch or groups changed");
    const indexLock = join(current.gitDir, "index.lock");
    let fd: number;
    try { fd = openSync(indexLock, "wx", 0o600); } catch { throw new GitPause("Git index is locked; no commits created"); }
    try {
      const commits: string[] = []; let parent = current.identity.head;
      for (const { group, tree } of plan.groups) {
        const commit = git(plan.repo, ["commit-tree", tree, "-p", parent], `${group.title}\n`).stdout.toString().trim();
        commits.push(commit); parent = commit;
      }
      // Materialize the final index under Git's lock before the ref compare-and-swap.
      temporary(directory => {
        const index = join(directory, "index");
        git(plan.repo, ["read-tree", plan.finalIndexTree], undefined, { GIT_INDEX_FILE: index });
        writeFileSync(fd, readFileSync(index));
      });
      assertIdentity(current.identity, (await captureBaseline(plan.repo)).identity);
      git(plan.repo, ["update-ref", "-m", "supership approved commit groups", `refs/heads/${plan.branch}`, parent, current.identity.head]);
      renameSync(indexLock, join(current.gitDir, "index"));
      return { operation: "commit", before: current.identity, after: (await captureBaseline(plan.repo)).identity, branch: plan.branch, commits };
    } finally { closeSync(fd); if (existsSync(indexLock)) rmSync(indexLock); }
  });
}
function remoteTarget(repo: string, remote: string): string {
  if (!out(repo, ["remote"]).split("\n").includes(remote) || remote.startsWith("-")) throw new GitPause("Push requires an explicitly named configured remote");
  const urls = out(repo, ["remote", "get-url", "--push", "--all", remote]).split("\n");
  if (urls.length !== 1) throw new GitPause("Push remote has multiple destinations; select one destination");
  if (git(repo, ["config", "--bool", `remote.${remote}.mirror`], undefined, {}, true).stdout.toString().trim() === "true") throw new GitPause("Mirror remotes cannot receive Supership pushes");
  if (urls[0].includes("://")) {
    const url = new URL(urls[0]);
    if (url.password || ["http:", "https:"].includes(url.protocol) && (url.username || url.search)) throw new GitPause("Credential-bearing remote URLs cannot be recorded; use a credential helper");
  }
  return urls[0];
}
function remoteHead(repo: string, url: string, branch: string): string | null {
  const rows = out(repo, ["ls-remote", "--refs", "--", url, `refs/heads/${branch}`]).split("\n").filter(Boolean);
  if (rows.length > 1) throw new GitPause("Push target is ambiguous");
  return rows.length ? rows[0].split(/\s/)[0] : null;
}
export async function preparePush(request: PushRequest): Promise<PushPlan> {
  assertSchema(PushRequestSchema, request);
  if (!request.requested) throw new GitPause("Push was not requested");
  const current = await captureBaseline(request.repo); assertIdentity(request.expected, current.identity); outputBranch(request.repo, request.branch);
  if (current.branch !== request.branch) throw new GitPause("Push branch is not the reviewed output branch");
  if (!request.commits.length || request.commits.at(-1) !== current.identity.head) throw new GitPause("Push needs the exact ordered output commits through HEAD");
  const url = remoteTarget(request.repo, request.remote); const target = remoteHead(request.repo, url, request.branch);
  if (request.commits.some(commit => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))) throw new GitPause("Push commits must be exact object IDs");
  const firstParent = resolvedCommit(request.repo, `${request.commits[0]}^`);
  if (target !== null && target !== firstParent) throw new GitPause("Remote target is not the parent of the confirmed output commits");
  const commits = out(request.repo, ["rev-list", "--reverse", `${firstParent}..${current.identity.head}`]).split("\n");
  if (digestJson(commits) !== digestJson(request.commits)) throw new GitPause("Push commit list omits or adds commits");
  const body = { schemaVersion: 1 as const, repo: request.repo, remote: request.remote, url, branch: request.branch, head: current.identity.head, remoteHead: target, commits, expected: request.expected, planRevision: request.planRevision, ownerEpoch: request.ownerEpoch };
  return { ...body, scopeHash: digestJson(body) };
}
export async function pushConfirmed(plan: PushPlan, confirmation: TrustedConfirmation): Promise<GitOperationEvidence> {
  assertSchema(PushPlanSchema, plan); pushConfirmationMatches(plan, confirmation);
  return locked(plan.repo, async () => {
    const current = await captureBaseline(plan.repo); assertIdentity(plan.expected, current.identity); outputBranch(plan.repo, plan.branch);
    if (current.branch !== plan.branch || current.identity.head !== plan.head || remoteTarget(plan.repo, plan.remote) !== plan.url || remoteHead(plan.repo, plan.url, plan.branch) !== plan.remoteHead) throw new GitPause("Push target changed after final confirmation");
    // Explicit refspec and --no-follow-tags override implicit configured push targets. No force option exists.
    git(plan.repo, ["-c", "push.followTags=false", "push", "--no-follow-tags", "--", plan.url, `${plan.head}:refs/heads/${plan.branch}`]);
    if (remoteHead(plan.repo, plan.url, plan.branch) !== plan.head) throw new GitPause("Push did not establish the confirmed target; inspect before retry");
    return { operation: "push", before: current.identity, after: (await captureBaseline(plan.repo)).identity, branch: plan.branch, commits: plan.commits, remote: plan.remote };
  });
}
