import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import {
  toolApprovalScope, assertSchema, canonicalJson, digestJson, sha256Utf8, ToolProposalSchema,
  type CapturedToolProposal, type CodeObservation, type EvidenceRef, type ToolDefinitionRecord,
  type ToolGrant, type ToolProposal, type ValidationResult, type WorkItem,
} from "./contracts.ts";

export const PARENT_ACCESS = "worktree isolation with parent access";
export const TOOL_POLICY_LIMIT = "Source checks enforce a reviewed coding policy, not a JavaScript sandbox. Parent callbacks can access the parent session. Approved tool.bash can execute arbitrary commands.";
export interface ProposalContext { runPath: string; existingNames: string[] }
export interface ToolPolicyReport { allowed: boolean; violations: string[]; limitations: string[] }

/** Never evaluates source. Obvious violations fail closed; passing this scan is not proof of safety. */
export function inspectProposal(proposal: ToolProposal, existingNames: string[] = []): ToolPolicyReport {
  assertSchema(ToolProposalSchema, proposal, "tool proposal");
  const violations: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(proposal.name) || proposal.name.startsWith("supership_")) violations.push("Use a non-reserved JavaScript tool name.");
  if (existingNames.includes(proposal.name)) violations.push(`Tool name ${proposal.name} already belongs to another registry.`);
  const source = proposal.source;
  if (/\b(?:import|require|fetch|XMLHttpRequest|WebSocket|Worker|process|Deno)\b|\bBun\s*(?:\.|\[)|\b(?:node:|https?:\/\/)/.test(source)) violations.push("Raw filesystem, network, process, module loading, and worker APIs are forbidden. Use approved await tool.* calls.");
  if (/\btool\s*(?:\.\s*supership_|\[\s*["']supership_)|\b(?:eval|Function)\s*\(|\btool\s*\(|\btool\s*\.\s*(?:define|undefine|defined)\s*\(|\b(?:agent|workpool|completion)\s*\(/.test(source)) violations.push("Recursive registration, dynamic code evaluation, and worker-owned orchestration are forbidden.");
  const captured = canonicalJson(proposal);
  if (/(?:sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|api[_-]?key|access[_-]?token|secret)\s*["']?\s*[:=]\s*["'][^"']{8,}["'])/i.test(captured)) violations.push("The proposal appears to contain a credential. Remove it and reference approved secret-free inputs.");
  if (!/^\s*(?:async\s+)?(?:function\b|\([^]*?\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(source)) violations.push("Source must be one JavaScript function expression with explicit parameters, not a registration cell.");
  if (proposal.initialization.some(input => input.ref.availability !== "available" || !input.ref.digest)) violations.push("Initialization inputs need available, content-hashed, secret-free evidence references.");
  if (new Set(proposal.intendedUsers).size !== proposal.intendedUsers.length || !proposal.intendedUsers.length) violations.push("Declare distinct intended users before granting the tool.");
  return { allowed: violations.length === 0, violations, limitations: [TOOL_POLICY_LIMIT, PARENT_ACCESS] };
}

export async function captureProposal(proposal: ToolProposal, context: ProposalContext): Promise<CapturedToolProposal> {
  const report = inspectProposal(proposal, context.existingNames);
  if (!report.allowed) throw new Error(report.violations.join("\n"));
  const sourceHash = sha256Utf8(proposal.source);
  const uri = `tools/${proposal.name}-${sourceHash}.js`;
  await mkdir(join(context.runPath, "tools"), { recursive: true });
  if (await realpath(join(context.runPath, "tools")) !== join(await realpath(context.runPath), "tools")) throw new Error("Tool capture directory must not be a symlink.");
  try { await writeFile(join(context.runPath, uri), proposal.source, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(join(context.runPath, uri))).isFile() || await readFile(join(context.runPath, uri), "utf8") !== proposal.source) throw error;
  }
  const { source: _source, ...captured } = proposal;
  return { ...captured, sourceHash, schemaHash: digestJson(proposal.parameters), sourceRef: { id: sourceHash, kind: "file", uri, digest: sourceHash, mediaType: "text/javascript", summary: `${proposal.name}: ${proposal.purpose}`, availability: "available" } };
}

export function validateGrant(definition: ToolDefinitionRecord, recipient: WorkItem, generation: number): ValidationResult {
  const fail = (message: string): ValidationResult => ({ valid: false, issues: [{ code: "tool-grant", path: definition.name, message, evidence: definition.evidence }] });
  if (definition.registration !== "registered" || !definition.runtimeName) return fail("The parent kernel has not registered this tool.");
  if (definition.kernelGeneration !== generation) return fail("The parent kernel changed. Recreate or re-propose the tool through approval; never replay recorded source.");
  if (definition.approvalScopeHash !== toolApprovalScope(definition, definition.grants)) return fail("Source, schema, effects, initialization, or grants changed after approval.");
  if (!definition.approvalId) return fail("The tool has no approved scope.");
  if (!definition.grants.some(grant => grant.workId === recipient.id && grant.workRevision === recipient.revision && grant.seatId === recipient.attempt.seatId)) return fail("This work revision and seat have no grant.");
  if (!recipient.toolGrants.some(grant => grant.name === definition.name && grant.version === definition.version && grant.approvalId === definition.approvalId)) return fail("The assignment does not reference the approved tool version.");
  return { valid: true };
}

export async function readCapturedSource(runPath: string, definition: CapturedToolProposal): Promise<string> {
  const path = resolve(runPath, definition.sourceRef.uri);
  const rel = relative(resolve(runPath), path);
  if (definition.sourceRef.kind !== "file" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Tool source must be a run-local captured file.");
  if (!(await lstat(path)).isFile() || !(await realpath(dirname(path))).startsWith((await realpath(runPath)) + "/")) throw new Error("Captured source must be a regular file inside the run.");
  const source = await readFile(path, "utf8");
  if (sha256Utf8(source) !== definition.sourceHash || digestJson(definition.parameters) !== definition.schemaHash) throw new Error("Captured source or schema changed. Re-propose and approve a new tool version.");
  return source;
}
