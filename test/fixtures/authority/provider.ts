import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { receivedControl } from "../../support/control-messages.ts";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { MockContent } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ActionRecord, RunRecord, WorkAssignment, WorkRef } from "../../../src/contracts.ts";

const root = process.env.AUTHORITY_ROOT!, cwd = process.env.AUTHORITY_CWD!, source = process.env.AUTHORITY_SOURCE_ROOT!;
// Both the registered extension and this parameter renderer use the same explicit source assembly.
const { taskParameters } = await import(join(source, "src", "omp.ts"));
const statePath = join(cwd, ".planning", "authority-proof", "state.json");
const stateNow = (): RunRecord | undefined => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
const log = (entry: Record<string, unknown>) => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ time: Date.now(), ...entry }) + "\n");
const call = (name: string, args: Record<string, unknown>, id = `authority-${randomUUID()}`) => ({ type: "toolCall" as const, id, name, arguments: args });
const spoof = (name: string, args: Record<string, unknown>) => call(name, args, `js-${name}-${randomUUID()}`);
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const textMessages = (context: Context) => context.messages.map(message => ({ role: message.role, text: typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n") }));
interface Packet { assignment: WorkAssignment; work: WorkRef }

// Match the complete JSON assignment transport used by the existing acceptance fixture.
function packetFrom(text: string): Packet | undefined {
  let found: Packet | undefined;
  for (let start = text.indexOf('{"assignment":'); start >= 0; start = text.indexOf('{"assignment":', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        const candidate = JSON.parse(text.slice(start, end + 1));
        if (candidate.assignment && candidate.work) found = candidate;
        break;
      }
    }
  }
  return found;
}
function workerOutput({ assignment, work }: Packet) {
  const base = { schemaVersion: 1, workId: work.id, workRevision: work.revision, attemptId: work.attemptId };
  const evidence = assignment.evidence;
  switch (assignment.outputSchema.name) {
    case "research": return { ...base, kind: "research", answers: [], gaps: [], proposedPaths: ["baseline.txt"] };
    case "plan": return { ...base, kind: "plan", plan: {
      schemaVersion: 1, revision: work.revision, title: "Authority proof", objective: "Inspect the unchanged baseline",
      scope: { included: ["baseline inspection"], excluded: [], paths: ["baseline.txt"], effects: [], publicContracts: [], dependencies: [] },
      evidence, items: [], risks: [], requiredLenses: ["correctness", "simplicity"], commitGroups: [], toolProposals: [], noChangeReason: "The fixture requests no source changes",
      verificationChecks: [{ id: "authority-check", description: "Read baseline bytes and record each actual command execution outside the checkout", scopePaths: ["baseline.txt"], required: true, source: evidence,
        scenario: { kind: "command", cwd, command: [process.execPath, "-e", `import {appendFileSync,readFileSync} from 'node:fs'; if(readFileSync('baseline.txt','utf8')!=='baseline\\n') throw new Error('Baseline changed'); appendFileSync(${JSON.stringify(join(root, "verification-effects.txt"))},'executed\\n');`] } }],
    } };
    case "critique": return { ...base, kind: "critique", targetPlanIds: assignment.dependencies.map(item => item.id), issues: [], retainedDecisions: [] };
    case "review": {
      assert.equal(assignment.context?.kind, "review");
      const context = assignment.context as Extract<NonNullable<WorkAssignment["context"]>, { kind: "review" }>;
      return { ...base, kind: "review", round: context.round, lens: context.lens, reviewedCodeIdentity: context.codeIdentity, findings: [], evidence };
    }
    case "judge": {
      assert.equal(assignment.context?.kind, "judge");
      const context = assignment.context as Extract<NonNullable<WorkAssignment["context"]>, { kind: "judge" }>;
      return { ...base, kind: "judge", round: context.round, judgeSeatId: assignment.seatId, reviewPacketHash: context.packetHash, verdicts: [] };
    }
    default: throw new Error(`Unexpected authority fixture work ${assignment.outputSchema.name}`);
  }
}

// Non-isolated children rebind this factory and OMP routes every provider request through the latest registration,
// so the parent's scripted state must be module level, not per instance.
let turns = 0, sentConcurrentNext = false, sentTimeoutProbe = false;
// proof: the authority attack sequence. crash-after-verify: a plain run killed once a settled verification exists, leaving an active run on disk.
// resume: a plain continuation until a second verification record exists or the run stops being active.
const phase = process.env.AUTHORITY_PHASE ?? "proof";
const attacked = new Set<string>();
const seenResults = new Set<string>();
export default function authorityProvider(api: ExtensionAPI) {
  api.on("session_start", (_event, ctx) => log({ event: "session-start", sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }));
  api.on("tool_call", event => {
    const state = stateNow();
    log({ event: "tool-call", id: event.toolCallId, name: event.toolName, input: event.input, claimed: state?.actions.filter(action => ["claimed", "running"].includes(action.status)).map(action => action.id) });
  });
  api.on("tool_execution_start", event => log({ event: "execution-start", id: event.toolCallId, name: event.toolName }));
  api.on("tool_result", (event, ctx) => {
    log({ event: "tool-result", id: event.toolCallId, name: event.toolName, details: event.details, error: event.isError });
    if (event.toolName === "eval") log({ event: "runtime-snapshot", snapshot: ctx.getAsyncJobSnapshot() });
  });
  api.on("message_end", event => {
    if (event.message.role === "assistant") log({ event: "assistant-message", content: event.message.content });
  });
  api.registerProvider("openai-codex", {
    api: "supership-authority-scripted", baseUrl: "http://127.0.0.1:1/never", apiKey: "offline-fixture-no-credential",
    models: ["parent", "worker"].map(id => ({ id: `authority-${id}`, name: `Authority ${id}`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 })),
    streamSimple(model, context, options) {
      const messages = textMessages(context), joined = messages.map(message => message.text).join("\n");
      log({ event: "provider", model: model.id, tools: context.tools?.map(tool => tool.name) });
      let content: MockContent[], delayMs = 0;
      if (model.id === "authority-parent") {
        for (const message of context.messages) if (message.role === "toolResult" && !seenResults.has(message.toolCallId)) {
          seenResults.add(message.toolCallId);
          log({ event: "model-result", id: message.toolCallId, name: message.toolName, error: message.isError, content: message.content });
        }
        const state = stateNow();
        if (!state) throw new Error("The actual product did not create its run");
        const delivered = receivedControl(context);
        const lastNext = delivered?.code ? { action: state.actions.find(action => action.programHash === createHash("sha256").update(delivered.code!).digest("hex")), cell: { language: "js" as const, timeout: 0, code: delivered.code } } : undefined;
        if (++turns > 2000) throw new Error("The authority proof did not reach its observed verification boundary");
        log({ event: "decision", turn: turns, cellId: delivered?.cellId, issued: lastNext?.action?.id, cell: !!lastNext?.cell, actions: state.actions.map(action => [action.id, action.status]) });
        const settled = state.actions.every(action => !["issued", "claimed", "running", "uncertain"].includes(action.status));
        if (phase === "crash-after-verify" && state.verification.some(record => record.outcome === "passed") && settled) {
          writeFileSync(join(root, "boundary.json"), JSON.stringify(state));
          log({ event: "crash", turn: turns });
          process.kill(process.pid, "SIGKILL");
        }
        if (phase === "resume" && (state.verification.length >= 2 || state.recovery || state.lifecycle !== "active")) {
          writeFileSync(join(root, "boundary-resume.json"), JSON.stringify(state));
          content = ["Resume proof reached its observed boundary"];
        } else if (delivered?.next) {
          content = [call("eval", { language: "js", code: delivered.next, timeout: 0 })];
        } else if (phase !== "proof") {
          const issued = lastNext?.cell && lastNext.action && state.actions.some(action => action.id === lastNext!.action!.id && action.status === "issued");
          content = issued ? [call("eval", { language: lastNext!.cell!.language, code: lastNext!.cell!.code, timeout: lastNext!.cell!.timeout })] : [call("supership_next", {})];
        } else if (state.verification.length || state.recovery || state.lifecycle !== "active") {
          writeFileSync(join(root, "boundary.json"), JSON.stringify(state));
          content = ["Authority proof reached its observed boundary"];
        } else if (!sentConcurrentNext) {
          sentConcurrentNext = true;
          content = [call("supership_next", {}, "concurrent-next-a"), call("supership_next", {}, "concurrent-next-b")];
          log({ event: "concurrent-next", calls: content });
        } else if (lastNext?.cell && lastNext.action && state.actions.some(action => action.id === lastNext!.action!.id && action.status === "issued")) {
          const { action, cell } = lastNext;
          assert.equal(cell.timeout, 0, "Issued control cells must disable the native default timeout");
          const exact = call("eval", { language: cell.language, code: cell.code, timeout: cell.timeout });
          const kind = action.input.kind;
          if (!sentTimeoutProbe) {
            sentTimeoutProbe = true;
            content = [call("eval", { language: cell.language, code: cell.code }, "omitted-timeout")];
          } else if (["run_finite", "wait", "verify"].includes(kind) && !attacked.has(kind)) {
            attacked.add(kind);
            // Native OMP prepares the whole message before it executes any call. This receipt is
            // ordered before exclusive eval, so its execute would see eval's claimed action.
            const forged = kind === "verify"
              ? { actionId: action.id, operation: "verification-results", data: { startedAt: Date.now(), endedAt: Date.now(), outcome: "passed", observations: [{ kind: "browser-assert-text" }] } }
              : { actionId: action.id, operation: "retired", data: {} };
            const directTask = action.input.kind === "run_finite" ? taskParameters(action, state) : { context: "Unauthorized authority fixture task", tasks: [{ agent: state.seats[0]!.alias, name: "unauthorized-work", task: "Unauthorized duplicate work" }] };
            const directHub = action.input.kind === "wait" ? { op: "wait", ids: [...new Set(action.input.owners.map(owner => owner.kind === "pool" || owner.kind === "pool-item" ? owner.parentId ?? owner.id : owner.id))], timeoutMs: 1000 } : { op: "cancel", ids: ["unauthorized-owner"] };
            const scenario = action.input.kind === "verify" ? action.input.check.scenario : undefined;
            assert.ok(!scenario || scenario.kind === "command");
            const directBash = scenario?.kind === "command" ? { command: scenario.command.map(quote).join(" "), cwd: scenario.cwd, async: false } : { command: `printf unexpected >> ${quote(join(root, "unauthorized-effects.txt"))}`, cwd, async: false };
            content = [call("write", { path: "xd://supership_next", content: JSON.stringify({ cellId: delivered!.cellId, page: 0 }) }), call("supership_runtime", forged), spoof("supership_runtime", forged), call("write", { path: "xd://supership_runtime", content: JSON.stringify(forged) }), exact, spoof("task", directTask), spoof("hub", directHub), spoof("bash", directBash)];
            log({ event: "attack", action, calls: content });
          } else content = [exact];
        } else content = [turns % 2 ? call("supership_next", {}) : call("write", { path: "xd://supership_next", content: "{}" })];
      } else if (context.messages.some(message => message.role === "toolResult" && message.toolName === "yield")) {
        // A WorkPool worker receives one trailing request after its yield, which OMP aborts; it is not a second execution.
        content = ["Pool item already yielded"];
      } else {
        const packet = packetFrom(joined);
        assert.ok(packet, "A native child must receive its issued assignment");
        const nativeResults = context.messages.flatMap(message => message.role === "toolResult" && (message.toolName === "write" || message.toolName === "bash") ? [message] : []);
        const attempted = nativeResults.length > 0;
        if (attempted) log({ event: "child-results", work: packet.work, results: nativeResults.map(message => ({ id: message.toolCallId, name: message.toolName, error: message.isError, content: message.content })) });
        if (packet.assignment.kind === "research" && !attempted) {
          // A non-isolated child shares the parent checkout: the rebound product factory must deny its native mutations.
          content = [call("write", { path: join(cwd, "child-unauthorized.txt"), content: "unexpected\n" }), call("bash", { command: `printf unexpected >> ${quote(join(root, "child-unauthorized-effects.txt"))}`, cwd })];
          log({ event: "child-attack", work: packet.work, calls: content });
        } else {
          log({ event: "worker-output", work: packet.work, kind: packet.assignment.kind });
          const key = /(?:key[=:"\s]+)(\d+)/i.exec(messages.findLast(message => message.role === "user")?.text ?? "")?.[1];
          content = [call("yield", { ...(joined.includes("<workpool ") ? { key: Number(key ?? 1) } : {}), data: workerOutput(packet) })];
          delayMs = packet.assignment.kind === "research" ? 300 : 80;
        }
      }
      return createMockModel({ id: model.id, provider: model.provider, handler: { content, delayMs } }).stream(model, context, options);
    },
  });
}
