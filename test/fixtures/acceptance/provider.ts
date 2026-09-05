import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertSchema, WorkAssignmentSchema, type FindingRecord, type RunRecord } from "../../../src/contracts.ts";
import { amendedPlan, dynamicProposal, packetFrom, planFor, type BuildStep, type Packet, type Scenario } from "./scenarios.ts";

const root = process.env.ACCEPTANCE_ROOT!;
const cwd = process.env.ACCEPTANCE_CWD!;
const scenario: Scenario = JSON.parse(readFileSync(join(root, "scenario.json"), "utf8"));
const statePath = join(cwd, ".planning", scenario.id, "state.json");
const readState = (): RunRecord | undefined => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
const log = (entry: Record<string, unknown>) => appendFileSync(join(root, "provider.jsonl"), JSON.stringify({ time: Date.now(), pid: process.pid, ...entry }) + "\n");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const toolCall = (name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id: `acceptance-${randomUUID()}`, name, arguments: args });
const textMessages = (context: Context) => context.messages.map(message => ({ role: message.role, text: typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n") }));

function reportedAssignment(packet: Packet) {
  if (packet.assignment.context?.kind !== "correction") return packet.assignment;
  const assignment: unknown = JSON.parse(packet.assignment.instructions).originalAssignment;
  assertSchema(WorkAssignmentSchema, assignment, "original reporting assignment");
  return assignment;
}

// The scripted worker malforms only the first attempt of the named work (an exact id, or an id prefix such as "review-1-correctness"); a trusted retry gets a valid report.
function invalidAttempt(invalid: NonNullable<Scenario["invalid"]>, work: { id: string; attemptId: string }): boolean {
  return (work.id === invalid.work || work.id.startsWith(invalid.work + "-")) && /:1$/.test(work.attemptId);
}

// An uncertain-callback row registers two versions: the research proposal (ungranted) and the parent's granted version whose source also writes an undeclared parent path. Dynamic rows walk four approval versions.
const proposalCount = scenario.uncertainCallback ? 2 : 4;
const proposalFor = (version: number) => scenario.uncertainCallback && version > 1 ? dynamicProposal(3, "undeclared.txt") : dynamicProposal(version);

function workerOutput(packet: Packet) {
  const { work } = packet;
  const assignment = reportedAssignment(packet);
  const state = readState();
  if (!state?.code) throw new Error("The real Supership run has no observed code identity");
  const base = { schemaVersion: 1, workId: work.id, workRevision: work.revision, attemptId: work.attemptId };
  const context = assignment.context;
  switch (assignment.outputSchema.name) {
    case "research": return { ...base, kind: "research", answers: [{ question: "Which baseline does this run inspect?", answer: "The native read inspected baseline.txt; the extension captured these baseline bytes before work.", citations: [state.repository.baselineRef] }], gaps: [], proposedPaths: scenario.builds.map(step => step.path), ...(scenario.dynamic || scenario.recursiveProposal ? { proposedTools: [{ ...proposalFor(1), ...(scenario.recursiveProposal ? { name: "acceptance_recursive", source: 'async function(args) { await tool(async function() { return 1; }, {name:"nested_acceptance",description:"forbidden nested registry",parameters:{type:"object"}}); return args.value; }' } : {}) }] } : {}) };
    case "plan": return { ...base, kind: "plan", plan: planFor(scenario, { ...packet, assignment }, cwd, state.code.identity, state.plan) };
    case "critique": return { ...base, kind: "critique", targetPlanIds: assignment.dependencies.map(item => item.id), issues: [], retainedDecisions: ["Preserve the cited shared evidence and declared paths"] };
    case "build": return { ...base, kind: "build", outcome: assignment.kind === "fix" && !scenario.fixChanges ? "no-change" : "changed", summary: assignment.kind === "fix" && !scenario.fixChanges ? "The scripted repair makes no code change" : "Wrote the declared fixture bytes", changes: assignment.kind === "fix" && !scenario.fixChanges ? [] : assignment.expectedPaths.map(path => ({ path, description: "Fixture output" })), verificationClaims: [], evidence: [state.repository.baselineRef], proposedTools: [], ...(scenario.amendment && (work.id === "initial" || scenario.command === "superreview" && assignment.kind === "fix") && state.plan?.revision === 1 ? { proposedAmendment: { schemaVersion: 1, baseRevision: 1, proposedPlan: amendedPlan(state.plan, scenario.amendment, cwd), reason: `Scripted ${scenario.amendment} request`, evidence: [state.repository.baselineRef] } } : {}) };
    case "review": {
      if (context?.kind !== "review") throw new Error("Review assignment lacks an explicit round/lens/code context");
      const ids = scenario.findings?.[context.round - 1] ?? [];
      return { ...base, kind: "review", round: context.round, lens: context.lens, reviewedCodeIdentity: context.codeIdentity, evidence: [], findings: context.lens !== "correctness" ? [] : ids.map(id => ({
        schemaVersion: 1, id: `finding-${id}`, fingerprint: hash(id), lens: context.lens,
        location: { path: scenario.builds[0]?.path ?? "baseline.txt", startLine: 1 }, condition: id,
        claim: `The fixture condition ${id} remains unresolved`, impact: "The declared fixture contract differs", severity: "medium",
        evidence: [state.repository.baselineRef], fixTarget: { path: scenario.builds[0]?.path ?? "baseline.txt", description: `Repair ${id}` }, verdicts: [],
      })) };
    }
    case "judge": {
      if (context?.kind !== "judge") throw new Error("Judge assignment lacks an explicit packet hash");
      const packetFindings = (JSON.parse(assignment.instructions) as { packet: { findings: FindingRecord[] } }).packet.findings;
      return { ...base, kind: "judge", round: context.round, judgeSeatId: assignment.seatId, reviewPacketHash: context.packetHash,
        verdicts: context.findingIds.map(findingId => {
          const finding = packetFindings.find(finding => finding.id === findingId);
          if (!finding) throw new Error("The assigned judge finding is absent from its explicit packet");
          return { findingId, verdict: scenario.disagree && assignment.seatId === "judge-secondary" || !(scenario.findings?.[context.round - 1] ?? []).includes(finding.condition) ? "rejected" : "accepted", reason: `Independent scripted ${assignment.seatId} decision from the explicit current round`, evidence: [state.repository.baselineRef] };
        }) };
    }
    case "verification": return { ...base, kind: "verification", checks: [], summary: "The extension must run actual verification commands" };
  }
}

// This fixture supplies deterministic model transport only. It never advances product state,
// grants approvals, registers replacement workflow tools, or invokes a tool class directly.
export default function acceptanceProvider(api: ExtensionAPI) {
  let sessionId = "unstarted";
  let lastNext: { cell?: { language: "js"; code: string; timeout: number }; lifecycle?: string; message?: string } | undefined;
  let parentCalls = 0;
  let snapshotRecorded = false;
  api.on("session_start", (_event, context) => {
    sessionId = context.sessionManager.getSessionId();
    log({ event: "session-start", sessionId, cwd: context.cwd });
    if (!existsSync(join(root, "parent-session.txt"))) writeFileSync(join(root, "parent-session.txt"), sessionId);
  });
  api.on("context", event => {
    for (const message of event.messages) if (message.role === "custom" && message.customType === "supership-diagnostic") log({ event: "diagnostic", sessionId, content: message.content });
    if (!readState()) log({ event: "preflight-context", sessionId, messages: event.messages.map(message => ({ role: message.role, ...(message.role === "custom" ? { customType: message.customType } : {}), ...("content" in message ? { content: message.content } : {}) })) });
  });
  api.on("before_agent_start", (event, ctx) => { log({ event: "turn", sessionId, prompt: event.prompt, branch: ctx.sessionManager.getBranch().map(entry => ({ type: entry.type, ...(entry.type === "message" ? { message: entry.message } : {}) })) }); });
  api.on("message_end", (event, ctx) => { if (event.message.role === "custom") log({ event: "native-message", sessionId: ctx.sessionManager.getSessionId(), content: event.message }); });
  api.on("tool_call", (event, ctx) => { log({ event: "tool-call", sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId, name: event.toolName, input: event.input }); });
  api.on("tool_result", (event, ctx) => {
    log({ event: "tool-result", sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId, name: event.toolName, details: event.details, content: event.content, error: event.isError });
    if (event.toolName === "supership_next") {
      lastNext = event.details as typeof lastNext;
      if (!snapshotRecorded && readState()?.pools.some(pool => pool.items.some(item => item.key !== undefined))) { log({ event: "native-snapshot", sessionId: ctx.sessionManager.getSessionId(), content: ctx.getAsyncJobSnapshot() }); snapshotRecorded = true; }
      writeFileSync(join(root, "next.json"), JSON.stringify(lastNext ?? null));
    }
    if (ctx.sessionManager.getSessionId() === readFileSync(join(root, "parent-session.txt"), "utf8") && (event.isError || event.details && typeof event.details === "object" && "isError" in event.details && event.details.isError === true)) writeFileSync(join(root, "parent-error.json"), JSON.stringify({ content: event.content, details: event.details }));
  });
  api.registerCommand("acceptance-inspect", {
    description: "Read actual command registration for the offline acceptance harness",
    async handler(_args, ctx) { log({ event: "registration", sessionId, commands: api.getCommands().map(command => command.name), commandDetails: api.getCommands(), mode: ctx.mode, tools: api.getAllTools().map(tool => tool.name) }); },
  });
  api.registerProvider("openai-codex", {
    api: "supership-acceptance-scripted", baseUrl: "http://127.0.0.1:1/never", apiKey: "offline-fixture-no-credential",
    models: ["parent", "worker", "alternate", "fallback"].map(id => ({ id: `acceptance-${id}`, name: `Acceptance ${id}`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 })),
    streamSimple(model, context, options) {
      const providerSessionId = options?.sessionId ?? "unattributed";
      const messages = textMessages(context);
      const latest = messages.findLastIndex(message => message.role === "user");
      const after = messages.slice(latest + 1);
      const joined = messages.map(message => message.text).join("\n");
      const packet = model.id === "acceptance-parent" ? undefined : packetFrom(joined);
      log({ event: "provider", sessionId: providerSessionId, model: model.id, tools: context.tools?.map(tool => tool.name), packet: packet ?? null, userMessages: messages.filter(message => message.role === "user").length, contextHash: hash(joined), privateMarkers: joined.match(/ACCEPTANCE_PRIVATE_[A-Za-z0-9-]+/g) ?? [] });
      options?.signal?.addEventListener("abort", () => log({ event: "provider-abort", sessionId: providerSessionId, model: model.id, work: packet?.work }), { once: true });
      let response: NonNullable<Parameters<typeof createMockModel>[0]>["handler"];
      try {
        if (model.id === "acceptance-parent") {
          if (++parentCalls > 400) throw new Error("Fixture exceeded 400 parent turns without terminal product progress");
          const state = readState();
          lastNext = existsSync(join(root, "next.json")) ? JSON.parse(readFileSync(join(root, "next.json"), "utf8")) : undefined;
          const lastError = existsSync(join(root, "parent-error.json")) ? readFileSync(join(root, "parent-error.json"), "utf8") : undefined;
          if (lastError) response = { content: ["ACCEPTANCE_ERROR " + lastError] };
          else if (scenario.dynamic && state?.phase === "build" && state.tools.filter(tool => tool.name === "acceptance_mosaic").length < proposalCount && state.work.some(work => work.id === "granted-a" && work.status === "pending") && !state.actions.some(action => ["issued", "claimed", "running", "uncertain"].includes(action.status)) && (!state.tools.length || state.tools.at(-1)?.registration === "registered")) {
            const version = state.tools.filter(tool => tool.name === "acceptance_mosaic").length + 1;
            const grants = state.work.filter(work => work.id === "granted-a" || version === 4 && work.id === "granted-b").map(work => ({ workId: work.id, workRevision: work.revision, seatId: work.seatId }));
            response = { content: [toolCall("eval", { language: "js", code: `display(await tool.supership_propose_tool(${JSON.stringify({ proposal: proposalFor(version), grants })}));` })] };
          } else if (!state) response = { content: ["ACCEPTANCE_NO_RUN"] };
          else if (lastNext?.cell && state.actions.some(action => action.status === "issued" && action.programHash === hash(lastNext!.cell!.code))) {
            response = { content: [toolCall("eval", { language: lastNext.cell.language, code: lastNext.cell.code, timeout: lastNext.cell.timeout })] };
          } else if (lastNext && !lastNext.cell && (state.lifecycle !== "active" || lastNext.message?.startsWith("No eligible action.")) || (scenario.stopAfter && state.phase === scenario.stopAfter)) {
            response = { content: ["ACCEPTANCE_BOUNDARY " + JSON.stringify({ lifecycle: state.lifecycle, phase: state.phase, recovery: state.recovery ?? null })] };
          } else response = { content: [toolCall("eval", { language: "js", code: "display(await tool.supership_next({}));", timeout: 0 })] };
        } else if (!packet) throw new Error("Worker received no explicit assignment packet");
        else {
          const isBuild = packet.assignment.outputSchema.name === "build";
          const assignment = reportedAssignment(packet);
          const declared = /^ACCEPTANCE_BUILD ([^\n]+)/.exec(assignment.instructions);
          const step: BuildStep | undefined = declared ? JSON.parse(declared[1]!) : scenario.builds.find(step => step.id === (packet.assignment.context?.kind === "correction" ? packet.assignment.context.original.id : packet.work.id));
          const path = step?.path ?? assignment.expectedPaths[0];
          const target = scenario.builds.find(step => step.path === path)?.content ?? "user baseline\nreview target repaired\n";
          if (isBuild && packet.assignment.context?.kind !== "correction" && !packet.workspace) throw new Error("The builder received no approved workspace callback");
          if (packet.workspace && (packet.workspace.workId !== packet.work.id || packet.workspace.workRevision !== packet.work.revision || packet.workspace.attemptId !== packet.work.attemptId)) throw new Error("Workspace callback targets another attempt");
          const content = packet.assignment.kind === "fix" ? target : step?.initialContent ?? step?.content ?? target;
          const shouldWrite = isBuild && packet.assignment.context?.kind !== "correction" && (packet.assignment.kind !== "fix" || scenario.fixChanges);
          const operationResults = context.messages.slice(latest + 1).flatMap(message => message.role === "toolResult" && message.toolName !== "yield" ? [message] : []);
          if (operationResults.length) log({ event: "worker-tool-results", sessionId: providerSessionId, work: packet.work, content: operationResults });
          if (operationResults.some(message => message.isError || ("details" in message && !!message.details && typeof message.details === "object" && "isError" in message.details && message.details.isError === true) || message.content.some(block => block.type === "text" && block.text.startsWith("Error:")))) throw new Error("A native worker operation failed before its output: " + JSON.stringify(operationResults));
          const exposed = new Set(context.tools?.map(tool => tool.name));
          const nativeCall = (name: string, args: Record<string, unknown>) => {
            if (packet.workspace && ["read", "write", "edit", "bash"].includes(name)) { args = { operation: name, input: args }; name = packet.workspace.grantName; }
            if (exposed.has(name)) return toolCall(name, args);
            if (exposed.has("eval")) return toolCall("eval", { language: "js", code: `display(await tool.${name}(${JSON.stringify(args)}));` });
            throw new Error(`Worker cannot invoke ${name}; native tools are ${[...exposed].join(", ")}`);
          };
          // Code Mode advertises bridge tools only as TypeScript declarations inside the eval tool description; that is the child's sole public view of its per-grant callback.
          const declarations = context.tools?.find(tool => tool.name === "eval")?.description ?? "";
          const runtimeNames = [...new Set(declarations.match(/\bsupership_[a-f0-9]{32}_[a-f0-9]{12}\b/g) ?? [])];
          if (scenario.dynamic && isBuild) log({ event: "worker-grants", sessionId: providerSessionId, work: packet.work, runtimeNames });
          if (step?.tool && runtimeNames.length !== 1) throw new Error("A granted worker must receive exactly its run-bound tool name");
          if (scenario.dynamic && step?.id === "ungranted" && runtimeNames.length) throw new Error("The ungranted worker received a parent callback tool");
          if ((packet.assignment.kind === "research" || packet.assignment.context?.kind === "correction") && !operationResults.length) {
            response = { content: [nativeCall("read", { path: packet.assignment.context?.kind === "correction" ? path ?? "baseline.txt" : "baseline.txt" })] };
          } else if (shouldWrite && step?.before && !operationResults.length) {
            const source = `if ((await Bun.file(${JSON.stringify(step.before.path)}).text()) !== ${JSON.stringify(step.before.content)}) throw new Error("Predecessor bytes are not integrated");`;
            const command = ["bun", "-e", source].map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");
            response = { content: [nativeCall("bash", { command })] };
          } else if (shouldWrite && step?.tool && operationResults.length === (step.before ? 1 : 0)) {
            response = { content: [nativeCall(runtimeNames[0]!, { value: 5, label: "fixture" })] };
          } else if (shouldWrite && operationResults.length < 1 + (step?.tool ? 1 : 0) + (step?.before ? 1 : 0)) {
            if (!path) throw new Error("Mutation fixture has no declared path");
            response = { content: [nativeCall("write", { path, content })], delayMs: step?.delayMs ?? 0 };
          } else if (scenario.invalid && invalidAttempt(scenario.invalid, packet.assignment.context?.kind === "correction" ? packet.assignment.context.original : packet.work) && scenario.invalid.stages > (packet.assignment.context?.kind === "correction" ? packet.assignment.context.stage === "fallback" ? 2 : 1 : 0)) {
            response = after.some(message => message.role === "toolResult" && /yield|schema|invalid/i.test(message.text)) ? { content: ["Malformed result retained; no mutation replay."] } : { content: [toolCall("yield", { data: { schemaVersion: 999, invalid: true } })] };
          } else {
            const key = /(?:key[=:"\s]+)(\d+)/i.exec(messages[latest]?.text ?? "")?.[1];
            response = { content: [...(["review", "judge"].includes(packet.assignment.kind) ? [`ACCEPTANCE_PRIVATE_${providerSessionId}`] : []), toolCall("yield", { ...(joined.includes("<workpool ") ? { key: Number(key ?? 1) } : {}), data: workerOutput(packet) })], delayMs: shouldWrite ? scenario.reportDelayMs ?? 80 : packet.assignment.context?.kind === "planning" ? scenario.planningDelayMs ?? 80 : packet.assignment.kind === "review" ? scenario.reviewDelayMs ?? 80 : 80 };
          }
        }
      } catch (error) {
        log({ event: "fixture-error", sessionId: providerSessionId, message: String(error) });
        response = { content: ["ACCEPTANCE_FIXTURE_ERROR " + String(error)] };
      }
      if (scenario.reportUsage && typeof response !== "function") response = { ...response, usage: { input: 11, output: 7, cacheRead: 5, totalTokens: 23, cost: scenario.reportUsage === "unpriced" ? { input: 0, output: 0, total: 0 } : { input: 0.002, output: 0.001, total: 0.003 } } };
      const stream = createMockModel({ id: model.id, provider: model.provider, handler: response }).stream(model, context, options);
      void stream.result().then(result => log({ event: "provider-settled", sessionId: providerSessionId, model: model.id, work: packet?.work, stopReason: result.stopReason }));
      return stream;
    },
  });
}
