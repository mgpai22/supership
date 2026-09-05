import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Type from "@sinclair/typebox/type";
import type { Static, TSchema } from "@sinclair/typebox";
import { IdSchema, RelativePathSchema, SequenceSchema, WorkAssignmentSchema, WorkRefSchema, assertSchema, canonicalJson, digestJson } from "./contracts.ts";
import { captureBaseline, capturePatch } from "./git.ts";
import type { BaselineRecord, PatchEvidence } from "./git.ts";
import { ChildGuardConfigSchema, WorkspaceBindingSchema, validateWorkspaceBinding, workspaceGrantPath } from "./child-guard.ts";
import type { ChildGuardConfig, WorkspaceBinding } from "./child-guard.ts";
export type { WorkspaceBinding } from "./child-guard.ts";

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const PrepareWorkspaceSchema = object({ runPath: Type.String(), runId: IdSchema, repositoryRoot: Type.String(), parentSessionId: IdSchema, ownerEpoch: SequenceSchema, actionId: IdSchema, work: WorkRefSchema, assignment: WorkAssignmentSchema, grantedToolNames: Type.Array(Type.String({ pattern: "^supership_[a-zA-Z0-9_]{1,54}$", maxLength: 64 }), { uniqueItems: true }) });
export type PrepareWorkspace = Static<typeof PrepareWorkspaceSchema>;
const intent = { i: Type.Optional(Type.String()) };
const schemas = {
  read: object({ ...intent, path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
  write: object({ ...intent, path: Type.String(), content: Type.String() }),
  edit: object({ ...intent, input: Type.String({ minLength: 1 }) }),
  bash: object({ ...intent, command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number({ minimum: 0 })), env: Type.Optional(Type.Record(Type.String(), Type.String())), async: Type.Optional(Type.Literal(false)), pty: Type.Optional(Type.Literal(false)) }),
};
export type WorkspaceOperation = keyof typeof schemas;

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Workspace Git setup failed: ${result.error?.message ?? result.stderr}`);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(path: string): void {
  let ancestor = path;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || !lstatSync(ancestor).isDirectory()) throw new Error("Workspace directory has a symlink or non-directory ancestor");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error("Workspace directory has a symlink ancestor");
}
function immutable(path: string, content: string | Buffer, mode = 0o600): void {
  const fd = openSync(path, "wx", mode);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function grant(binding: WorkspaceBinding, active: boolean): void {
  const path = workspaceGrantPath(binding); directory(dirname(path));
  const next = `${path}.${randomBytes(8).toString("hex")}`;
  immutable(next, canonicalJson({ schemaVersion: 1, runId: binding.runId, ownerEpoch: binding.ownerEpoch, work: binding.work, manifestDigest: binding.manifestDigest, active }));
  renameSync(next, path); syncDirectory(dirname(path));
}
/** Writes the immutable generated guard root that isolated children discover through settings.extensions. Idempotent per owner. */
export function guardExtension(config: ChildGuardConfig): { extensionRoot: string; extensionPath: string } {
  assertSchema(ChildGuardConfigSchema, config);
  const extensionRoot = join(config.runPath, "child-guard", digestJson({ parentSessionId: config.parentSessionId, ownerEpoch: config.ownerEpoch }));
  directory(extensionRoot);
  const extensionPath = join(extensionRoot, "index.ts");
  const code = `import { installChildGuard } from ${JSON.stringify(fileURLToPath(new URL("./child-guard.ts", import.meta.url)))};\nexport default api => installChildGuard(api, ${canonicalJson(config)});\n`;
  if (lstatSync(extensionPath, { throwIfNoEntry: false })) {
    if (realpathSync(extensionPath) !== extensionPath || readFileSync(extensionPath, "utf8") !== code) throw new Error("Trusted child guard configuration changed");
  } else immutable(extensionPath, code);
  return { extensionRoot, extensionPath };
}

/** Creates code ownership before any worker starts. Native isolation remains disposable scratch. */
export async function prepareWorkspace(request: PrepareWorkspace): Promise<WorkspaceBinding> {
  assertSchema(PrepareWorkspaceSchema, request, "workspace preparation");
  if (request.work.id !== request.assignment.id || request.work.revision !== request.assignment.revision || request.grantedToolNames.length !== request.assignment.toolGrants.length) throw new Error("Workspace assignment does not match its work or exact grants");
  const runPath = resolve(request.runPath);
  if (realpathSync(runPath) !== runPath) throw new Error("Run root must be a canonical existing directory");
  const source = await captureBaseline(request.repositoryRoot);
  // Reuse Git's byte, blob, index, scope, and baseline validation before materialization.
  capturePatch(source, source, { kind: "isolated", workId: request.work.id }, request.assignment.expectedPaths);
  if (request.assignment.isolation.kind === "worktree") {
    const expected = request.assignment.isolation.base;
    if (expected.head !== source.identity.head || expected.indexTree !== source.identity.indexTree || expected.worktreeDigest !== source.identity.worktreeDigest) throw new Error("Workspace source changed since assignment");
  }
  const config: ChildGuardConfig = { schemaVersion: 1, runPath, runId: request.runId, repositoryRoot: source.repo, parentSessionId: request.parentSessionId, ownerEpoch: request.ownerEpoch };
  const extension = guardExtension(config);
  const marker = randomBytes(32).toString("hex");
  const container = join(runPath, "worktrees", marker); directory(container);
  const isolationKind = request.assignment.mutation === "read-only" ? "active-checkout" : request.assignment.isolation.kind;
  const path = isolationKind === "worktree" ? join(container, "checkout") : source.repo;
  try {
    if (isolationKind === "worktree") {
      // No checkout filters: hydrate Git's captured raw images into a new, empty registered worktree.
      git(source.repo, ["worktree", "add", "--detach", "--no-checkout", path, source.identity.head]);
      git(path, ["read-tree", source.identity.indexTree]);
      for (const entry of source.worktree) {
        const target = join(path, entry.path); directory(dirname(target));
        if (entry.image.mode === "120000") { symlinkSync(Buffer.from(entry.image.bytes, "base64"), target); syncDirectory(dirname(target)); }
        else immutable(target, Buffer.from(entry.image.bytes, "base64"), entry.image.mode === "100755" ? 0o755 : 0o644);
      }
    }
    const before = await captureBaseline(path);
    if (digestJson(before.identity) !== digestJson(source.identity) || digestJson(before.head) !== digestJson(source.head) || digestJson(before.index) !== digestJson(source.index) || digestJson(before.worktree) !== digestJson(source.worktree)) throw new Error("Workspace does not preserve the captured dirty baseline");
    immutable(join(container, "baseline.json"), canonicalJson(before));
    const body = { ...config, actionId: request.actionId, work: structuredClone(request.work), path, isolationKind, mutation: request.assignment.mutation, grantedToolNames: [...request.grantedToolNames], ...extension, grantName: `supership_workspace_${marker.slice(0, 40)}`, marker, manifestPath: join(container, "manifest.json"), baselineDigest: digestJson(before), createdAt: Date.now(), expectedPaths: [...request.assignment.expectedPaths], parentAccess: "worktree isolation with parent access" as const };
    const binding: WorkspaceBinding = { ...body, manifestDigest: digestJson(body) };
    assertSchema(WorkspaceBindingSchema, binding);
    immutable(binding.manifestPath, canonicalJson(binding));
    grant(binding, true);
    validateWorkspaceBinding(binding);
    Object.freeze(binding.work); Object.freeze(binding.expectedPaths); Object.freeze(binding.grantedToolNames);
    return Object.freeze(binding);
  } catch (error) {
    throw new Error(`Workspace setup failed before worker mutation. Retained setup: ${container}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function routePath(binding: WorkspaceBinding, input: string, mutation: boolean, allowRoot = false): string {
  if (!input || /[\u0000-\u001f\\:#?\[\]]/.test(input) || input.startsWith("~")) throw new Error("Workspace paths must be plain local paths without selectors");
  if (input !== "." && !isAbsolute(input)) assertSchema(RelativePathSchema, input, "workspace relative path");
  const path = isAbsolute(input) ? input : join(binding.path, input);
  const name = relative(binding.path, path);
  if (name === "" && allowRoot) return binding.path;
  assertSchema(RelativePathSchema, name, "workspace path");
  if (resolve(path) !== path || name.split("/").some(part => !part || part.toLowerCase() === ".git")) throw new Error("Workspace path escapes code ownership");
  if (mutation && !binding.expectedPaths.some(scope => name === scope || name.startsWith(`${scope}/`))) throw new Error("Workspace path is outside the work assignment");
  let ancestor = path;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor || lstatSync(ancestor).isSymbolicLink()) throw new Error("Workspace path follows a symlink");
  return path;
}
function editInput(binding: WorkspaceBinding, input: string): string {
  let sections = 0;
  const routed = input.split("\n").map(line => {
    if (line.startsWith("+")) return line;
    const header = /^\[(.+)#([A-Fa-f0-9]{4})\]$/.exec(line);
    if (header) { sections++; return `[${routePath(binding, header[1]!, true)}#${header[2]}]`; }
    if (line.startsWith("MV ")) {
      const raw = line.slice(3).trim();
      const destination = raw.startsWith('"') ? JSON.parse(raw) : raw;
      if (typeof destination !== "string") throw new Error("Invalid hashline move destination");
      return `MV ${JSON.stringify(routePath(binding, destination, true))}`;
    }
    if (line && line !== "*** Begin Patch" && line !== "*** End Patch" && line !== "REM" && !/^(?:PUT|CUT) [0-9<>$]/.test(line)) throw new Error("Only native hashline edit operations are supported");
    return line;
  }).join("\n");
  if (!sections) throw new Error("Workspace edit requires native hashline [PATH#TAG] sections");
  return routed;
}

/** Returns native tool parameters. The parent callback must invoke public tool.* and retain its hooks and signal. */
export function routeWorkspaceOperation(binding: WorkspaceBinding, operation: WorkspaceOperation, input: Record<string, unknown>): { toolName: WorkspaceOperation; input: Record<string, unknown> } {
  validateWorkspaceBinding(binding);
  if (binding.mutation === "read-only" && operation !== "read") throw new Error("Read-only work cannot mutate through a workspace callback");
  if (!Object.hasOwn(schemas, operation)) throw new Error("Unknown workspace operation");
  if (operation === "read") {
    assertSchema(schemas.read, input, "workspace read");
    return { toolName: operation, input: { ...input, path: routePath(binding, input.path, false, true) } };
  }
  if (operation === "write") {
    assertSchema(schemas.write, input, "workspace write");
    return { toolName: operation, input: { ...input, path: routePath(binding, input.path, true) } };
  }
  if (operation === "edit") {
    assertSchema(schemas.edit, input, "workspace edit");
    return { toolName: operation, input: { ...input, input: editInput(binding, input.input) } };
  }
  assertSchema(schemas.bash, input, "workspace bash");
  // Bash can run arbitrary commands, even after cwd routing. This is approved parent access, not confinement.
  return { toolName: operation, input: { ...input, cwd: routePath(binding, input.cwd ?? ".", false, true), async: false } };
}

/** Capture after settlement, including cancellation. Revocation does not prevent forensic capture. */
export async function captureWorkspace(binding: WorkspaceBinding): Promise<{ before: BaselineRecord; after: BaselineRecord; patch: PatchEvidence }> {
  validateWorkspaceBinding(binding, false);
  const baselinePath = join(dirname(binding.manifestPath), "baseline.json");
  if (realpathSync(baselinePath) !== baselinePath || !lstatSync(baselinePath).isFile()) throw new Error("Workspace baseline was replaced");
  const before = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineRecord;
  if (digestJson(before) !== binding.baselineDigest || before.repo !== binding.path) throw new Error("Workspace baseline digest mismatch");
  const after = await captureBaseline(binding.path);
  return { before, after, patch: capturePatch(before, after, { kind: binding.isolationKind === "worktree" ? "isolated" : "parent-callback", workId: binding.work.id }, binding.expectedPaths) };
}

/** Revokes only this attempt. Durable code and evidence remain until separately confirmed cleanup. */
export function revokeWorkspace(binding: WorkspaceBinding): void {
  validateWorkspaceBinding(binding, false);
  const current = JSON.parse(readFileSync(workspaceGrantPath(binding), "utf8"));
  if (current.manifestDigest === binding.manifestDigest && current.active === true) grant(binding, false);
}
