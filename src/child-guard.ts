import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import * as Type from "@sinclair/typebox/type";
import type { Static, TSchema } from "@sinclair/typebox";
import { DigestSchema, IdSchema, MutationSchema, SchemaVersion, SequenceSchema, WorkRefSchema, assertSchema, digestJson, sha256Utf8 } from "./contracts.ts";

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const WorkspaceBindingSchema = object({
  schemaVersion: SchemaVersion, runPath: Type.String(), runId: IdSchema, repositoryRoot: Type.String(),
  parentSessionId: IdSchema, ownerEpoch: SequenceSchema, actionId: IdSchema, work: WorkRefSchema,
  path: Type.String(), extensionRoot: Type.String(), extensionPath: Type.String(), grantName: IdSchema,
  marker: DigestSchema, manifestPath: Type.String(), manifestDigest: DigestSchema, baselineDigest: DigestSchema,
  isolationKind: Type.Union([Type.Literal("worktree"), Type.Literal("active-checkout")]),
  mutation: MutationSchema, grantedToolNames: Type.Array(Type.String({ pattern: "^supership_[a-zA-Z0-9_]{1,54}$", maxLength: 64 }), { uniqueItems: true }),
  createdAt: SequenceSchema, expectedPaths: Type.Array(Type.String()),
  parentAccess: Type.Literal("worktree isolation with parent access"),
});
export type WorkspaceBinding = Static<typeof WorkspaceBindingSchema>;
export const ChildGuardConfigSchema = object({
  schemaVersion: SchemaVersion, runPath: Type.String(), runId: IdSchema, repositoryRoot: Type.String(),
  parentSessionId: IdSchema, ownerEpoch: SequenceSchema,
});
export type ChildGuardConfig = Static<typeof ChildGuardConfigSchema>;

export function workspaceGrantPath(binding: Pick<WorkspaceBinding, "runPath" | "work">): string {
  return join(binding.runPath, "worktrees", "grants", `${digestJson(binding.work.id)}.json`);
}

function regularFile(path: string): string {
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error("Workspace control file is not a canonical regular file");
  return readFileSync(path, "utf8");
}

/** Verifies the controller's immutable receipt, never a model-supplied path or manifest. */
export function validateWorkspaceBinding(binding: WorkspaceBinding, requireActive = true): void {
  assertSchema(WorkspaceBindingSchema, binding, "workspace binding");
  const { manifestDigest, ...body } = binding;
  if (digestJson(body) !== manifestDigest) throw new Error("Workspace manifest digest mismatch");
  const directory = join(binding.runPath, "worktrees", binding.marker);
  if (binding.runPath !== resolve(binding.runPath) || realpathSync(binding.runPath) !== binding.runPath ||
      binding.path !== (binding.isolationKind === "worktree" ? join(directory, "checkout") : binding.repositoryRoot) || binding.manifestPath !== join(directory, "manifest.json") ||
      binding.grantName !== `supership_workspace_${binding.marker.slice(0, 40)}` ||
      binding.extensionRoot !== join(binding.runPath, "child-guard", digestJson({ parentSessionId: binding.parentSessionId, ownerEpoch: binding.ownerEpoch })) ||
      binding.extensionPath !== join(binding.extensionRoot, "index.ts")) throw new Error("Workspace receipt paths do not match their owner");
  if (digestJson(JSON.parse(regularFile(binding.manifestPath))) !== digestJson(binding)) throw new Error("Workspace manifest changed");
  if (sha256Utf8(regularFile(join(directory, "baseline.json"))) !== binding.baselineDigest) throw new Error("Workspace baseline digest mismatch");
  if (realpathSync(binding.path) !== binding.path || !lstatSync(binding.path).isDirectory()) throw new Error("Workspace checkout moved or was replaced");
  if (!requireActive) return;
  const current = JSON.parse(regularFile(workspaceGrantPath(binding)));
  if (digestJson(current) !== digestJson({ schemaVersion: 1, runId: binding.runId, ownerEpoch: binding.ownerEpoch, work: binding.work, manifestDigest, active: true })) throw new Error("Workspace grant is stale or revoked");
}

const readableTools: Record<string, true> = { eval: true, read: true, grep: true, glob: true, ast_grep: true, web_search: true, fetch: true, yield: true, think: true };
/** Per-grant parent callback registrations: `supership_<32 hex>` base plus `_<12 hex>` grant suffix. */
const grantedToolName = /^supership_[a-f0-9]{32}_[a-f0-9]{12}$/;

// Non-isolated children rebind the parent's already loaded extension factories and never re-read the extension list,
// so the parent extension guards them through this process-local registry; isolated children rediscover the generated root.
const activeGuards = new Map<string, ChildGuardConfig>();

/** Activates the run's guard for every child that rebinds the parent extension graph. */
export function activateChildGuard(config: ChildGuardConfig): void {
  assertSchema(ChildGuardConfigSchema, config, "child guard configuration");
  activeGuards.set(config.parentSessionId, config);
}
export function deactivateChildGuard(parentSessionId: string): void { activeGuards.delete(parentSessionId); }

function guard(api: ExtensionAPI, guards: () => ChildGuardConfig[]): void {
  let selected: WorkspaceBinding | undefined;
  let invalid = false;
  const applicable = (sessionId: string) => guards().filter(config => config.parentSessionId !== sessionId);
  api.on("before_agent_start", (event, ctx) => {
    const configs = applicable(ctx.sessionManager.getSessionId());
    if (!configs.length) return;
    // Native task prompts wrap the controller JSON. Only its exact workspace object selects a grant.
    const matches = [...event.prompt.matchAll(/"workspace"\s*:\s*(\{[^{}]*\})/g)];
    if (!matches.length) return;
    try {
      if (matches.length !== 1) throw new Error("Ambiguous workspace assignment");
      const request = JSON.parse(matches[0]![1]!);
      assertSchema(object({ marker: DigestSchema, path: Type.String(), grantName: IdSchema, manifestDigest: DigestSchema, workId: IdSchema, workRevision: SequenceSchema, attemptId: IdSchema }), request);
      const config = configs.find(config => lstatSync(join(config.runPath, "worktrees", request.marker, "manifest.json"), { throwIfNoEntry: false }));
      if (!config) throw new Error("Workspace assignment names no active run");
      const binding = JSON.parse(regularFile(join(config.runPath, "worktrees", request.marker, "manifest.json"))) as WorkspaceBinding;
      validateWorkspaceBinding(binding);
      if (binding.runId !== config.runId || binding.runPath !== config.runPath || binding.ownerEpoch !== config.ownerEpoch ||
          binding.parentSessionId !== config.parentSessionId || binding.repositoryRoot !== config.repositoryRoot ||
          binding.path !== request.path || binding.grantName !== request.grantName || binding.manifestDigest !== request.manifestDigest ||
          binding.work.id !== request.workId || binding.work.revision !== request.workRevision || binding.work.attemptId !== request.attemptId ||
          (selected && selected.manifestDigest !== binding.manifestDigest)) throw new Error("Workspace assignment does not match its grant");
      selected = binding;
    } catch { invalid = true; selected = undefined; }
  });
  api.on("tool_call", (event, ctx) => {
    if (!applicable(ctx.sessionManager.getSessionId()).length) return;
    if (Object.hasOwn(readableTools, event.toolName)) return;
    if (!invalid && selected && (event.toolName === selected.grantName || selected.grantedToolNames.includes(event.toolName))) {
      try { validateWorkspaceBinding(selected); return; } catch { invalid = true; }
    }
    // A child only sees the per-grant callback names its spawn listed; the parent callback validates the grant itself.
    if (!invalid && !selected && grantedToolName.test(event.toolName)) return;
    return { block: true, reason: "Supership child guard denies native mutation or an ungranted tool. Use this work's granted workspace callback; the native checkout is disposable scratch." };
  });
}

/** Cooperative native-tool policy for the generated root that isolated children discover. Raw eval/Bun/Node and browser runtimes are not a security sandbox. */
export function installChildGuard(api: ExtensionAPI, config: ChildGuardConfig): void {
  assertSchema(ChildGuardConfigSchema, config, "child guard configuration");
  guard(api, () => [config]);
}
/** Install from the Supership extension factory; children that rebind the factory are guarded by every active run. */
export function observeChildGuard(api: ExtensionAPI): void { guard(api, () => [...activeGuards.values()]); }
