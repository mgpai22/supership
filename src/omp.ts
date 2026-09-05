import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "@sinclair/typebox/type";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Settings } from "@oh-my-pi/pi-coding-agent";
import {
  toolApprovalScope, assertSchema, canonicalJson, digestJson, sha256Utf8, schemaByName, WorkerOutputSchema, RawWorkerOutputSchema,
  type ToolProposal, type CapturedToolProposal,
  type ActionRecord, type EngineInput, type EvidenceRef, type Receipt, type ReceiptObservation,
  type Reconciliation, type RunRecord, type RuntimeOwner, type SchedulingSnapshot, type WorkRef,
  type SeatBinding, type SeatRequest, type ToolDefinitionRecord, type ValidationResult,
} from "./contracts.ts";
import type { WorkspaceBinding } from "./workspace.ts";
import { PARENT_ACCESS, TOOL_POLICY_LIMIT } from "./tools.ts";

const exec = promisify(execFile);
export const EXPECTED_OMP_RANGE = ">=18.1.10 <18.2.0";
export const CapabilityReportSchema = Type.Object({ supported: Type.Boolean(), observedVersion: Type.String(), expectedRange: Type.String(), checks: Type.Array(Type.Object({ name: Type.String(), available: Type.Boolean(), expected: Type.String(), observed: Type.String(), evidence: Type.Array(Type.String()) }, { additionalProperties: false })), limitations: Type.Array(Type.String()) }, { additionalProperties: false });
export type CapabilityReport = Static<typeof CapabilityReportSchema>;
export interface DoctorOptions { cwd?: string; observedVersion?: string; runtime?: { settings: boolean; extensionAgents: boolean; toolHooks: boolean; eval: boolean; task: boolean; planMode: boolean; session: boolean } }
export async function doctor(options: DoctorOptions = {}): Promise<CapabilityReport> {
  const checks: CapabilityReport["checks"] = [];
  let observedVersion = options.observedVersion ?? "unavailable", versionEvidence = options.observedVersion ? "running host package version" : "omp --version";
  if (!options.observedVersion) {
    try { observedVersion = (await exec("omp", ["--version"], { cwd: options.cwd, timeout: 15000 })).stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "unavailable"; }
    catch (error) {
      // The failed probe stays in the report verbatim: spawn errno, exit status or signal, timeout, and the CLI's own stderr.
      const failure = error as NodeJS.ErrnoException & { code?: string | number; signal?: string; killed?: boolean; stderr?: string };
      versionEvidence = `omp --version failed: ${[failure.code !== undefined ? `code ${failure.code}` : "", failure.signal ? `signal ${failure.signal}` : "", failure.killed ? "killed by timeout" : "", failure.stderr?.trim() || failure.message].filter(Boolean).join("; ")}`;
    }
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(observedVersion);
  checks.push({ name: "version", available: !!parts && +parts[1]! === 18 && +parts[2]! === 1 && +parts[3]! >= 10, expected: EXPECTED_OMP_RANGE, observed: observedVersion, evidence: [versionEvidence] });
  checks.push({ name: "platform", available: process.platform === "linux", expected: "linux", observed: process.platform, evidence: ["process.platform"] });
  try { await exec("git", ["--version"], { cwd: options.cwd, timeout: 15000 }); checks.push({ name: "git", available: true, expected: "Git executable", observed: "available", evidence: ["git --version"] }); }
  catch { checks.push({ name: "git", available: false, expected: "Git executable", observed: "unavailable", evidence: [] }); }
  if (options.runtime) for (const [name, value] of Object.entries(options.runtime)) checks.push({ name, available: name === "planMode" ? !value : value, expected: name === "planMode" ? "disabled" : "available", observed: String(value), evidence: ["public extension context and session-scoped settings"] });
  return { supported: checks.every(check => check.available), observedVersion, expectedRange: EXPECTED_OMP_RANGE, checks, limitations: [TOOL_POLICY_LIMIT, "Task and eval lifecycle is cooperative. Runtime snapshots may omit expired jobs; absence is not proof of cancellation.", ...(options.runtime ? [] : ["CLI checks do not prove active-session routing. Startup checks the current session before creating durable state."])] };
}

/** In-session probe: the version is the running host's own (public VERSION export), not a spawned CLI that may be another install or fail to start under load. */
export async function probeCapabilities(api: ExtensionAPI, ctx: ExtensionContext, settings: Settings, freshMode: "disabled" | "enabled" | "unknown"): Promise<CapabilityReport> {
  const names = api.getAllTools().map(tool => tool.name);
  return doctor({ cwd: ctx.cwd, observedVersion: VERSION, runtime: { settings: typeof settings.override === "function", extensionAgents: Array.isArray(settings.get("extensions")), toolHooks: typeof api.on === "function", eval: settings.get("eval.js") && names.includes("eval"), task: names.includes("task"), planMode: freshMode !== "disabled", session: !!ctx.sessionManager.getSessionId() && typeof ctx.getAsyncJobSnapshot === "function" } });
}

export interface SeatResolution { root: string; bindings: SeatBinding[] }
interface AgentSource { path: string; kind: SeatBinding["source"]["kind"]; body: string; metadata: Record<string, unknown>; content: string }
async function parseSource(path: string, kind: AgentSource["kind"]): Promise<AgentSource> {
  const content = await readFile(path, "utf8");
  const match = /^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)([^]*)$/.exec(content);
  if (!match) throw new Error(`Agent ${path} has no YAML frontmatter.`);
  const metadata = Bun.YAML.parse(match[1]!) as Record<string, unknown>;
  if (!metadata || typeof metadata.name !== "string" || typeof metadata.description !== "string") throw new Error(`Agent ${path} needs name and description.`);
  return { path, kind, body: match[2]!, metadata, content };
}
async function directoryAgents(path: string, kind: AgentSource["kind"]): Promise<AgentSource[]> {
  let files: string[];
  try { files = await readdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return Promise.all(files.filter(file => file.endsWith(".md")).sort().map(file => parseSource(join(path, file), kind)));
}
export async function resolveSeats(ctx: ExtensionContext, settings: Settings, requests: SeatRequest[], runId: string, generation = 0, fallbackSeats: Array<{ seatId: string; fallbackSeatIds: string[] }> = []): Promise<SeatResolution> {
  const disabled = settings.get("task.disabledAgents");
  for (const request of requests) if (disabled.includes(request.agentName)) throw new Error(`Required seat ${request.seatId}: agent ${request.agentName} is disabled by task.disabledAgents.`);
  const root = await mkdtemp(join(tmpdir(), "supership-seats-"));
  const sources: AgentSource[] = [];
  for (let directory = resolve(ctx.cwd); ; directory = dirname(directory)) {
    const found = await directoryAgents(join(directory, ".omp", "agents"), "project");
    if (found.length) { sources.push(...found); break; }
    if (dirname(directory) === directory) break;
  }
  sources.push(...await directoryAgents(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "agents"), "user"));
  for (const extension of [...settings.get("extensions"), resolve(import.meta.dir, "..")]) {
    const path = extension.startsWith("~/") ? join(homedir(), extension.slice(2)) : resolve(ctx.cwd, extension);
    if ((await stat(path).catch(() => undefined))?.isDirectory()) sources.push(...await directoryAgents(join(path, "agents"), "extension"));
  }
  let unpacked = false;
  const bindings: SeatBinding[] = [];
  const definitions: string[] = [];
  for (const request of requests) {
    let source = request.sourcePath ? await parseSource(resolve(ctx.cwd, request.sourcePath), "explicit") : sources.find(source => source.metadata.name === request.agentName);
    if (!source) {
      if (!unpacked) { await exec("omp", ["agents", "unpack", "--dir", join(root, "bundled"), "--json"], { cwd: ctx.cwd, timeout: 30000 }); sources.push(...await directoryAgents(join(root, "bundled"), "bundled")); unpacked = true; }
      source = sources.find(source => source.metadata.name === request.agentName);
    }
    if (!source || source.metadata.name !== request.agentName) throw new Error(`Required seat ${request.seatId}: agent ${request.agentName} was not found in project, user, or configured extension definitions, or bundled export. Set sourcePath for an explicitly registered extension root.`);
    const requested = request.model ?? settings.get("task.agentModelOverrides")[request.agentName] ?? source.metadata.model;
    const patterns = Array.isArray(requested) ? requested : requested ? [requested] : [];
    const selected = patterns.map(pattern => ({ pattern: String(pattern), model: ctx.models.resolve(String(pattern)) })).find(item => item.model);
    const model = selected?.model ?? (patterns.length ? undefined : ctx.models.current());
    if (!model || !ctx.models.list().some(candidate => candidate.provider === model.provider && candidate.id === model.id)) throw new Error(`Required seat ${request.seatId} (${request.agentName}): no authenticated model matches ${patterns.join(", ") || "the parent model"}. Configure the logical seat or an explicit named fallback.`);
    const alias = `supership-${sha256Utf8(root + runId).slice(0, 12)}-${sha256Utf8(request.seatId).slice(0, 12)}`;
    const metadata: Record<string, unknown> = { ...source.metadata, name: alias, model: selected?.pattern ?? `${model.provider}/${model.id}` };
    for (const [field, key] of [["prewalk", "task.agentPrewalk"], ["advisor", "task.agentAdvisor"]] as const) {
      const policy = settings.get(key)[request.agentName];
      if (policy !== undefined) metadata[field] = policy === "off" ? false : policy === "on" ? true : policy;
      else if (field === "prewalk" && source.kind === "bundled" && request.agentName === "task" && metadata.prewalk === undefined) metadata.prewalk = settings.get("task.prewalk");
    }
    definitions.push(`---\n${Bun.YAML.stringify(metadata)}\n---\n${source.body}`);
    bindings.push({ seatId: request.seatId, baseAgent: request.agentName, alias, ...(request.model ? { requestedModel: request.model } : {}), resolvedModel: `${model.provider}/${model.id}`, fallbackSeatIds: fallbackSeats.find(item => item.seatId === request.seatId)?.fallbackSeatIds ?? [], source: { agentName: request.agentName, kind: source.kind, path: source.kind === "bundled" ? "omp-bundled:" + request.agentName : source.path, contentHash: sha256Utf8(source.content), bodyHash: sha256Utf8(source.body), metadataHash: digestJson(source.metadata) }, bindingGeneration: generation });
  }
  await mkdir(join(root, "agents"));
  await Promise.all(bindings.map((binding, index) => writeFile(join(root, "agents", `${binding.alias}.md`), definitions[index]!, { flag: "wx", mode: 0o600 })));
  settings.override("extensions", [...settings.get("extensions"), root]);
  return { root, bindings };
}
/** Drops run-added extension roots from the session override; whatever the current configuration and other runtime layers provide stays visible. */
export function removeExtensionRoots(settings: Settings, roots: readonly string[]): void {
  const current = settings.get("extensions");
  settings.clearOverride("extensions");
  const base = settings.get("extensions");
  const foreign = current.filter(path => !roots.includes(path) && !base.includes(path));
  if (foreign.length) settings.override("extensions", [...base, ...foreign]);
}
export function releaseSeatBindings(settings: Settings, resolution: SeatResolution): void {
  removeExtensionRoots(settings, [resolution.root]);
  // Alias bodies are run-local routing evidence only; the durable seat record keeps the source hashes.
  rmSync(resolution.root, { recursive: true, force: true });
}

export interface ControlCell { language: "js"; timeout:0; code: string; inputHash: string; programHash: string; actionId: string; runId: string; ownerEpoch: number; expectedStateRevision: number; recipients: ActionRecord["recipients"] }
const runtimeKey = (runId: string) => `supership_${sha256Utf8(runId).slice(0, 20)}`;
export function runtimeToolName(definition: ToolDefinitionRecord, grant: ToolDefinitionRecord["grants"][number]): string {
  if(!definition.runtimeName)throw new Error("Dynamic tool has no current native registration prefix.");
  return `${definition.runtimeName}_${digestJson(grant).slice(0, 12)}`;
}
/** Run-unique native job name for one finite recipient; OMP may allocate a `-N` suffix on collision. */
export function nativeName(action:ActionRecord,index:number){return `supership-${sha256Utf8(action.runId).slice(0,12)}-${action.id}-${index}`;}
/** Identity the child usage observer binds; it never grants anything. */
function usagePacket(action: ActionRecord, state: RunRecord, work: WorkRef[]) { return { runId: state.runId, parentSessionId: state.owner.sessionId, ownerEpoch: action.ownerEpoch, actionId: action.id, work }; }
function allocatedName(id:string,requested:string){return id===requested || id.startsWith(requested+"-") && /^[1-9][0-9]*$/.test(id.slice(requested.length+1));}
export function taskParameters(action: ActionRecord, state: RunRecord, workspaces: readonly WorkspaceBinding[] = []) {
  if (action.input.kind !== "run_finite") throw new Error("Expected a finite action.");
  return { context: `Supership ${state.runId}, plan revision ${action.planRevision}. Return only the assigned versioned schema through yield.`, tasks: action.input.assignments.map((assignment, index) => {
    const seat = state.seats.find(seat => seat.seatId === assignment.seatId);
    if (!seat) throw new Error(`Missing required seat ${assignment.seatId}.`);
    const workspace=workspaces.find(binding=>binding.work.id===assignment.id && binding.work.revision===assignment.revision);
    const grants = assignment.toolGrants.map(grant => {
      const definition = state.tools.find(tool => tool.name === grant.name && tool.version === grant.version);
      if (!definition?.runtimeName || definition.registration !== "registered" || definition.kernelGeneration !== state.kernelGeneration || definition.approvalId !== grant.approvalId || !definition.grants.some(recipient => recipient.workId === assignment.id && recipient.workRevision === assignment.revision && recipient.seatId === assignment.seatId) || definition.approvalScopeHash !== toolApprovalScope(definition, definition.grants)) throw new Error(`Tool grant ${grant.name}@${grant.version} is unavailable or changed.`);
      return runtimeToolName(definition, { workId: assignment.id, workRevision: assignment.revision, seatId: assignment.seatId });
    });
    if(workspace) grants.push(workspace.grantName);
    const work = action.input.kind === "run_finite" ? action.input.work[index]! : undefined;
    return { agent: seat.alias, name: nativeName(action,index), task: canonicalJson({ assignment, work: work ?? null, parentAccess: grants.length ? PARENT_ACCESS : "no dynamic parent callback grant", ...(workspace ? {workspace:{marker:workspace.marker,path:workspace.path,grantName:workspace.grantName,manifestDigest:workspace.manifestDigest,workId:workspace.work.id,workRevision:workspace.work.revision,attemptId:workspace.work.attemptId}} : {}), ...(work ? { supership: usagePacket(action, state, [work]) } : {}) }), outputSchema: schemaByName(assignment.outputSchema.name, assignment.outputSchema.version), schemaMode: "strict", ...(assignment.isolation.kind === "worktree" ? { isolated: true } : {}), ...(grants.length ? { tools: grants } : {}) };
  }) };
}
export function renderControlCell(action: ActionRecord, state: RunRecord, source?: string, initialization: Record<string, unknown> = {}, workspaces: readonly WorkspaceBinding[] = []): ControlCell {
  const id = JSON.stringify(action.id), key = JSON.stringify(runtimeKey(state.runId));
  const report = (operation: string, expression: string) => `await tool.supership_runtime({actionId:${id},operation:${JSON.stringify(operation)},data:${expression}})`;
  const registry = `globalThis[${key}]`;
  let body: string;
  switch (action.input.kind) {
    case "run_finite": {
      const params = taskParameters(action, state, workspaces);
      if (action.input.scheduler === "task") body = `const result=await tool.task(${canonicalJson(params)}); ${report("native-results", "result")};`;
      else body = `for (const spec of ${canonicalJson(params.tasks)}) { const handle=await agent(spec.task,{agent:spec.agent,label:spec.name,schema:spec.outputSchema,schemaMode:"strict",...(spec.isolated?{isolated:true,apply:false,merge:false}:{}),...(spec.tools?{tools:spec.tools}:{})}); ${registry}.handles[handle.id]=handle; ${report("handle-created", "{id:handle.id,label:spec.name}")}; }`;
      break;
    }
    case "verify": {
      const scenario = action.input.check.scenario;
      const operations = scenario.kind === "command" ? [scenario] : scenario.operations;
      const commands = operations.map(operation => {
        if (operation.kind === "command") {
          const command = operation.command.map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");
          return `const value=await tool.bash(` + canonicalJson({ command, cwd: operation.cwd, async: false }) + `); observations.push({kind:"command",value}); if(value.isError||value.hasError||value.details?.exitCode||value.details?.timedOut||value.details?.async?.state==="running") throw new Error("Verification command failed or remains unsettled");`;
        }
        const name = JSON.stringify(`ss_` + sha256Utf8(state.runId).slice(0,10) + `_` + operation.name);
        switch(operation.kind) {
          case "browser-open": return `if(typeof browser==="undefined") {unavailable=true;throw new Error("Browser capability unavailable");} await browser.open({name:` + name + `,url:` + JSON.stringify(operation.url) + `}); opened.push(` + name + `); observations.push({kind:"browser-open",name:` + name + `});`;
          case "browser-click": return `await browser.tab(` + name + `).click(` + JSON.stringify(operation.selector) + `); observations.push({kind:"browser-click"});`;
          case "browser-fill": return `await browser.tab(` + name + `).fill(` + JSON.stringify(operation.selector) + `,` + JSON.stringify(operation.value) + `); observations.push({kind:"browser-fill"});`;
          case "browser-assert-text": return `const text=await browser.tab(` + name + `).extract("text"); if(!text.includes(` + JSON.stringify(operation.text) + `)) throw new Error("Expected browser text absent"); observations.push({kind:"browser-assert-text",text});`;
          case "browser-screenshot": return `const path=await browser.tab(` + name + `).screenshot({fullPage:true}); observations.push({kind:"browser-screenshot",path});`;
          case "browser-close": return `await browser.close({name:` + name + `}); opened.splice(opened.indexOf(` + name + `),1); observations.push({kind:"browser-close"});`;
        }
      });
      body = `const startedAt=Date.now(),observations=[],opened=[]; let outcome="passed",unavailable=false; try { ` + commands.map(command => "{"+command+"}").join("\n") + ` } catch(error) {outcome=unavailable?"unavailable":"failed"; observations.push({kind:"error",message:String(error)});} finally {for(const name of opened) await browser.close({name});} ` + report("verification-results", "{startedAt,endedAt:Date.now(),outcome,observations}") + `;`;
      break;
    }
    case "wait": {
      const pools = [...new Set(action.input.owners.filter(owner => owner.kind === "pool" || owner.kind === "pool-item").map(owner => owner.parentId ?? owner.id))];
      const finite = action.input.owners.filter(owner => owner.kind !== "pool" && owner.kind !== "pool-item");
      body = `const result=await tool.hub({op:"wait",ids:${canonicalJson([...finite.map(owner=>owner.id),...pools])},timeoutMs:1000}); ` + (finite.length ? report("native-results", "result")+`; for(const job of result.details?.jobs??[]) {if(job.status!=="completed" || job.structured || job.structuredOutput) continue; const agentId=job.agentId??job.id,path="agent://"+agentId+"?q=.",source=await tool.read({path}); ${report("native-replay", "{ownerId:job.id,agentId,path,source}")};}` : "") + pools.map(poolId => `{const pool=${registry}.pools[${JSON.stringify(poolId)}]; if(!pool) throw new Error("Supership kernel lost"); ${report("pool-results", `{poolId:${JSON.stringify(poolId)},status:await pool.status(),peek:await pool.peek()}`)};}`).join("\n") + report("wait-complete", "{}");
      break;
    }
    case "cancel_runtime": body = `${report("cancel-requested", "{}")}; const result=await tool.hub({op:"cancel",ids:${canonicalJson(action.input.owners.map(owner => owner.id))}}); ${report("cancel-observed", "result")};`; break;
    case "pool_create": {
      const seat = state.seats.find(seat => seat.seatId === (action.input.kind === "pool_create" ? action.input.seatId : ""));
      if (!seat) throw new Error("The WorkPool seat is missing.");
      const seatId = action.input.seatId;
      // OMP resolves eval tool grants by exact registered name: the per-grant registrations for this seat, never the base name.
      const tools = action.input.toolGrants.flatMap(grant => {
        const definition = state.tools.find(tool => tool.name === grant.name && tool.version === grant.version);
        if (!definition?.runtimeName || definition.registration !== "registered" || definition.kernelGeneration !== state.kernelGeneration || definition.approvalId !== grant.approvalId) throw new Error(`Pool tool grant ${grant.name}@${grant.version} is unavailable or changed.`);
        return definition.grants.filter(recipient => recipient.seatId === seatId).map(recipient => runtimeToolName(definition, recipient));
      });
      // pool.status().limit is Infinity under an unlimited OMP ceiling and would not survive the receipt; only the item counts are reported.
      body = `const pool=await workpool(${JSON.stringify(seat.alias)},{name:${JSON.stringify(action.input.poolId)},context:${JSON.stringify(action.input.contextRef.summary)}${tools.length ? `,tools:${canonicalJson(tools)}` : ""}}); ${registry}.pools[pool.name]=pool; ${report("pool-created", "{id:pool.name,status:{items:(await pool.status()).items}}")};`; break;
    }
    case "pool_push": body = `const pool=${registry}.pools[${JSON.stringify(action.input.poolId)}]; if(!pool) throw new Error("Supership kernel lost"); const keys=await pool.push(...${canonicalJson(action.input.items.map(item => canonicalJson({ ...item, supership: usagePacket(action, state, [item.work]) })))}); ${report("pool-pushed", "{keys,status:{items:(await pool.status()).items}}")};`; break;
    case "pool_close": body = `const pool=${registry}.pools[${JSON.stringify(action.input.poolId)}]; if(!pool) throw new Error("Supership kernel lost"); await pool.close(); ${report("pool-closed", "{status:{items:(await pool.status()).items},peek:await pool.peek()}")};`; break;
    case "register_tool": {
      const definition = state.tools.find(tool => tool.name === (action.input.kind === "register_tool" ? action.input.toolName : "") && tool.version === (action.input.kind === "register_tool" ? action.input.toolVersion : 0));
      if (!definition || source === undefined || sha256Utf8(source) !== definition.sourceHash || definition.approvalScopeHash !== toolApprovalScope(definition, definition.grants) || action.input.approvalScopeHash !== definition.approvalScopeHash) throw new Error("Tool source or approval scope does not match the issued registration action.");
      const name = `supership_${digestJson({runId:state.runId,name:definition.name,version:definition.version,generation:state.kernelGeneration}).slice(0,32)}`;
      const names = definition.grants.map(grant => ({ grant, name: runtimeToolName({ ...definition, runtimeName: name }, grant) }));
      const callback = (stage: string, data: string) => `await tool.supership_callback({actionId:${id},name:${JSON.stringify(definition.name)},version:${definition.version},grant:binding.grant,token:${registry}.token,stage:${JSON.stringify(stage)},data:${data}})`;
      body = `const handler=(${source}); const initialization=${canonicalJson(initialization)}; for(const binding of ${canonicalJson(names)}) { tool(async function(args){ const before=${callback("begin", "{}")}; if(before.hasError||before.isError||typeof before.details?.invocationId!=="string")throw new Error("Parent callback did not authorize this invocation."); try { const result=await handler(args,initialization); ${callback("end", '{invocationId:before.details.invocationId,outcome:"success"}')}; return result; } catch(error) { ${callback("end", '{invocationId:before.details.invocationId,outcome:"failed"}')}; throw error; } },{name:binding.name,description:${JSON.stringify(`${definition.description}. ${PARENT_ACCESS}`)},parameters:${canonicalJson(definition.parameters)}}); } ${report("tool-registered", canonicalJson({ name: definition.name, version: definition.version, runtimeName: name, sourceHash: definition.sourceHash, schemaHash: definition.schemaHash, kernelGeneration: state.kernelGeneration }))};`; break;
    }
    case "retire_tool": {
      const definition = state.tools.find(tool => tool.name === (action.input.kind === "retire_tool" ? action.input.toolName : "") && tool.version === (action.input.kind === "retire_tool" ? action.input.toolVersion : 0));
      if (!definition?.runtimeName) throw new Error("Tool has no runtime registration.");
      const names=definition.grants.map(grant=>runtimeToolName(definition,grant));
      body = `for(const name of `+canonicalJson(names)+`) tool.undefine(name); `+report("retired", "{}")+`;`; break;
    }
    default: throw new Error(`Action ${action.input.kind} requires the extension's trusted runtime operation, not eval.`);
  }
  if(action.input.kind==="run_finite") {
    const registrations=workspaces.filter(binding=>binding.actionId===action.id).map(binding=>{
      const fixed=canonicalJson({actionId:action.id,work:binding.work,manifestDigest:binding.manifestDigest});
      const schema=canonicalJson({type:"object",properties:{operation:{enum:["read","write","edit","bash"]},input:{type:"object"}},required:["operation","input"],additionalProperties:false});
      return `tool(async function(args){const fixed=${fixed};const opened=await tool.supership_workspace({...fixed,token:${registry}.token,stage:"begin",operation:args.operation,input:args.input});if(opened.hasError||opened.isError||typeof opened.details?.invocationId!=="string")throw new Error("Parent workspace callback did not authorize this operation.");let outcome="failed";try {const response=await tool[opened.details.toolName](opened.details.input);outcome=response.hasError||response.isError?"failed":"success";return response;}finally {await tool.supership_workspace({...fixed,token:${registry}.token,stage:"end",invocationId:opened.details.invocationId,outcome});}},{name:${JSON.stringify(binding.grantName)},description:${JSON.stringify("Perform an assigned native operation in "+binding.path+". "+PARENT_ACCESS)},parameters:${schema}});`;
    });
    body=registrations.join("\n")+"\n"+body;
  }
  // The kernel receives its authorization token only through a bridged result while the claimed cell executes; the model never sees it.
  const code = `/* Supership ${canonicalJson({ runId: action.runId, ownerEpoch: action.ownerEpoch, actionId: action.id, planRevision: action.planRevision, inputHash: action.inputHash, recipients: action.recipients })} */\n{\nlet prior=${registry}; if(prior && prior.generation!==${state.kernelGeneration}) { ${registry}=undefined; prior=undefined; } const seeded=${report("kernel", "{present:!!prior,generation:prior?.generation??null}")}; if(seeded.hasError||seeded.isError||typeof seeded.details?.token!=="string") throw new Error("Supership kernel authorization refused"); ${registry}??={generation:${state.kernelGeneration},handles:{},pools:{}}; ${registry}.token=seeded.details.token;\n${body}\n}`;
  return { language: "js", timeout:0, code, inputHash: action.inputHash, programHash: sha256Utf8(code), actionId: action.id, runId: action.runId, ownerEpoch: action.ownerEpoch, expectedStateRevision: action.expectedStateRevision, recipients: action.recipients };
}
export function validateControlCall(input: Record<string, unknown>, action: ActionRecord, cell: ControlCell): ValidationResult {
  const valid = input.language === "js" && input.timeout === 0 && input.reset !== true && typeof input.code === "string" && sha256Utf8(input.code) === cell.programHash && action.programHash === cell.programHash && action.status === "issued";
  return valid ? { valid: true } : { valid: false, issues: [{ code: "control-cell", path: action.id, message: "Unrecognized, changed, stale, or consumed control cell. Execute the exact JavaScript cell with timeout:0.", evidence: [] }] };
}

export function readRuntimeSnapshot(ctx: ExtensionContext, state: RunRecord, ceiling: number): SchedulingSnapshot {
  const raw = ctx.getAsyncJobSnapshot();
  const jobs = [...raw?.running ?? [], ...raw?.recent ?? []];
  const activeOwners: RuntimeOwner[] = [], knownCompletedOwners: RuntimeOwner[] = [], unknownOwners: RuntimeOwner[] = [];
  // A live pool spawns one native batch job per worker (`<poolId>-<n>[-<m>]-b<turn>`); those rows, not the item count, are the pool's actual concurrency.
  const dispatched = new Map<string, number>();
  const queued = (owner: RuntimeOwner) => {
    const poolId = owner.parentId!;
    if (!dispatched.has(poolId)) dispatched.set(poolId, jobs.filter(job => job.status === "running" && typeof job.agentId === "string" && job.agentId.startsWith(poolId + "-") && job.agentId.slice(poolId.length + 1).split("-").every(part => /^[0-9]+$/.test(part)) && job.id.startsWith(job.agentId + "-b")).length);
    const remaining = dispatched.get(poolId)!;
    dispatched.set(poolId, remaining - 1);
    return remaining <= 0;
  };
  for (const owner of state.work.flatMap(work => work.runtimeOwners)) {
    if (owner.status === "observed-terminal") { knownCompletedOwners.push(owner); continue; }
    // Pool items are not async jobs; the parent WorkPool job row is their only public runtime evidence.
    const job = jobs.find(job => job.id === owner.id || job.agentId === owner.id) ?? (owner.kind === "pool-item" && owner.parentId ? jobs.find(job => job.id === owner.parentId) : undefined);
    if (!job) unknownOwners.push({ ...owner, status: "unknown" });
    else if (job.status !== "running") knownCompletedOwners.push({ ...owner, status: "observed-terminal" });
    // ponytail: batch rows carry no item keys, so the first non-terminal items in work order are taken as the dispatched ones; the count is exact, the identity approximate.
    else if (owner.kind === "pool-item" && owner.parentId && queued(owner)) continue;
    else activeOwners.push({ ...owner, status: "observed-running" });
  }
  // The pool owner is the WorkPool's aggregate job, which OMP registers only on the first non-empty push: a created but
  // unpushed pool lives solely in the parent kernel registry, so a missing job row is not evidence that it ended.
  // A pushed pool's job resolves when its queue drains and may then leave the bounded public snapshot; once every pushed
  // item carries an observed-terminal receipt the drain has happened, so the pool is settled by those receipts, not by the gap.
  for (const pool of state.pools) {
    const owner = pool.owner;
    if (!owner) continue;
    if (owner.status === "observed-terminal") { knownCompletedOwners.push(owner); continue; }
    if (!pool.items.some(item => item.key !== undefined)) { activeOwners.push({ ...owner, status: "observed-running" }); continue; }
    const job = jobs.find(job => job.id === owner.id);
    if (job) { (job.status === "running" ? activeOwners : knownCompletedOwners).push({ ...owner, status: job.status === "running" ? "observed-running" : "observed-terminal" }); continue; }
    const drained = pool.items.every(item => item.key !== undefined && state.work.some(work => work.runtimeOwners.some(candidate => candidate.parentId === pool.id && candidate.id === item.key && candidate.status === "observed-terminal")));
    (drained ? knownCompletedOwners : unknownOwners).push({ ...owner, status: drained ? "observed-terminal" : "unknown" });
  }
  for (const action of state.actions.filter(action => action.status === "claimed" || action.status === "running")) for (const [index, recipient] of action.recipients.entries()) {
    const job = jobs.find(job => allocatedName(job.agentId??job.id,nativeName(action,index)));
    if (!job || [...activeOwners, ...knownCompletedOwners, ...unknownOwners].some(owner => owner.id === job.id)) continue;
    const owner: RuntimeOwner = { kind: "task", id: job.id, actionId: action.id, workId: recipient.workId, workRevision: recipient.workRevision, attemptId: recipient.attemptId, sessionId: state.owner.sessionId, ownerEpoch: state.owner.epoch, status: job.status === "running" ? "observed-running" : "observed-terminal" };
    (job.status === "running" ? activeOwners : knownCompletedOwners).push(owner);
  }
  return { ompCeiling: ceiling===0?null:ceiling, activeOwners, knownCompletedOwners, unknownOwners, observedAt: Date.now() };
}
export function reconcileRuntime(state: RunRecord, snapshot: SchedulingSnapshot, evidence: EvidenceRef[] = []): Reconciliation {
  return { confirmed: [...snapshot.activeOwners, ...snapshot.knownCompletedOwners], unresolved: snapshot.unknownOwners, candidateResults: evidence, requiredChoices: state.work.filter(work => work.status === "running" || work.status === "awaiting-recovery").filter(work => work.mutation !== "read-only" || snapshot.unknownOwners.some(owner => owner.workId === work.id)).map(work => ({ kind: "adopt", affectedWork: [{ id: work.id, revision: work.revision }], reason: `${work.id} needs live-owner, result, and effect inspection before adopt, retry, or discard.` })) };
}

export function receiptBase(action: ActionRecord, kind: string, suffix: string) { return { schemaVersion: 1 as const, receiptId: `${action.id}:${kind}:${suffix}`, runId: action.runId, ownerEpoch: action.ownerEpoch, actionId: action.id, inputHash: action.inputHash, planRevision: action.planRevision, evidence: [] as EvidenceRef[] }; }
export async function captureWorkerOutput(candidate:unknown,capture:(proposal:ToolProposal)=>Promise<CapturedToolProposal>):Promise<Static<typeof WorkerOutputSchema>> {
  assertSchema(RawWorkerOutputSchema, candidate, "observed worker output");
  const raw = candidate;
  const common = raw.proposedTools ? { proposedTools: await Promise.all(raw.proposedTools.map(capture)) } : {};
  let output: unknown = { ...raw, ...common };
  if (raw.kind === "plan") output = { ...raw, ...common, plan: { ...raw.plan, toolProposals: await Promise.all(raw.plan.toolProposals.map(capture)) } };
  if (raw.kind === "build" && raw.proposedAmendment) output = { ...raw, ...common, proposedAmendment: { ...raw.proposedAmendment, proposedPlan: { ...raw.proposedAmendment.proposedPlan, toolProposals: await Promise.all(raw.proposedAmendment.proposedPlan.toolProposals.map(capture)) } } };
  assertSchema(WorkerOutputSchema, output, "captured worker output");
  return output;
}
export async function normalizeNativeResult(action: ActionRecord, result: unknown, state: RunRecord, observation: ReceiptObservation, capture: (proposal: ToolProposal) => Promise<CapturedToolProposal>, recovered?: ReadonlyMap<string,unknown>): Promise<EngineInput[]> {
  const value = result as { details?: { results?: Array<Record<string, unknown>>; jobs?: Array<Record<string, unknown>>; progress?: Array<Record<string, unknown>> } };
  const results = value?.details?.results ?? value?.details?.jobs;
  const rows: Array<Record<string, unknown>> | undefined = Array.isArray(results) ? [...results, ...(value.details?.progress ?? []).filter(progress => !results.some(row => row.id === progress.id)).map(progress => ({ ...progress, status: "running" }))] : undefined;
  if (!Array.isArray(rows) || !rows.length) throw new Error("OMP returned no native task results or owners. Inspect the native preflight error; no work is complete.");
  const inputs: EngineInput[] = [];
  for (const row of rows) {
    const label = String(row.label ?? row.id ?? "");
    const oldOwner = state.work.flatMap(work => work.runtimeOwners).find(owner => owner.id === row.id);
    const recipient = oldOwner ? state.work.find(work => work.id === oldOwner.workId && work.revision === oldOwner.workRevision && work.attempt.id === oldOwner.attemptId) : undefined;
    if (recipient && ["succeeded","failed","cancelled"].includes(recipient.status)) continue;
    const index = action.input.kind === "run_finite" ? action.input.work.findIndex((_work, index) => allocatedName(String(row.id),nativeName(action,index))) : -1;
    const workRef = index >= 0 && action.input.kind === "run_finite" ? action.input.work[index]! : recipient ? { id: recipient.id, revision: recipient.revision, attemptId: recipient.attempt.id } : undefined;
    if (!workRef) throw new Error(`Native job ${label} is not a recipient of action ${action.id}.`);
    const owner: RuntimeOwner = oldOwner ?? { kind: "task", id: String(row.id), actionId: action.id, workId: workRef.id, workRevision: workRef.revision, attemptId: workRef.attemptId, sessionId: state.owner.sessionId, ownerEpoch: action.ownerEpoch, status: "reported" };
    const baseAction = oldOwner ? state.actions.find(item => item.id === oldOwner.actionId)! : action;
    if (!oldOwner) inputs.push({ kind: "observe-receipt", receipt: { ...receiptBase(baseAction, "created", workRef.id), kind: "created", work: workRef, kernelGeneration: state.kernelGeneration, owner }, observation });
    const structured = (row.structuredOutput ?? row.structured) as { status?: string; data?: unknown } | undefined;
    const terminal = row.status !== undefined ? row.status !== "running" : row.exitCode !== undefined && row.exitCode !== null;
    const hasRecovered=recovered?.has(String(row.id))??false,candidate=hasRecovered?recovered!.get(String(row.id)):structured?.data;
    if (!terminal || !hasRecovered && structured === undefined && row.status === "completed" && !row.error) continue;
    try {
      if(!hasRecovered && structured?.status!=="valid") throw new Error(String(row.error??"Strict structured output is unavailable or invalid."));
      const output=await captureWorkerOutput(candidate,capture);
      inputs.push({ kind: "observe-receipt", receipt: { ...receiptBase(baseAction, "completed", workRef.id), kind: "completed", work: workRef, owner: { ...owner, status: "observed-terminal" }, output }, observation: { ...observation, kind: "runtime-confirmed" } });
    } catch(error) {
      inputs.push({ kind: "record-invalid-output", work: workRef, actionId: baseAction.id, outputRef: { id: owner.id, kind: "artifact", uri: `agent://${owner.id}`, mediaType: "application/json", summary: "Native task returned an invalid or failed structured result.", availability: "unverified" }, issues: [{ code: "native-output", path: workRef.id, message: error instanceof Error ? error.message : "Observed worker output is invalid.", evidence: [] }], observation:{...observation,settledOwners:[{...owner,status:"observed-terminal"}]} });
    }
  }
  return inputs;
}
