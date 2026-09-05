import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context } from "@oh-my-pi/pi-ai";
import { z, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// OMP's compatibility loader binds this documented facade to the active session.
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = process.env.PHASE_A_ROOT!;
const workerSchema = z.object({ model: z.string(), value: z.number() }).strict();
const schema = workerSchema.toJsonSchema();
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
function messageText(context: Context) {
  return context.messages.map(message => ({ role: message.role, text: typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n") }));
}

export default function phaseA(pi: ExtensionAPI) {
  const log = (value: unknown) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(value) + "\n");
  log({ kind: "factory" });
  pi.on("session_start", (_event, ctx) => { log({ kind: "session_start", cwd: ctx.cwd, session: ctx.sessionManager.getSessionId() }); });
  let run = "";
  let runRoot = "";
  let revision = 1;
  let aliases: string[] = [];
  const actions = new Map<string, { code: string; hash: string; inputHash: string; revision: number; started: boolean; receipts: Set<string> }>();
  pi.registerProvider("openai-codex", {
    api: "phase-a-scripted", baseUrl: "http://127.0.0.1:1/never", apiKey: "phase-a-no-credential",
    models: ["parent", "a", "b", "c", "d"].map(id => ({
      id: `phase-a-${id}`, name: `Phase A ${id}`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
    })),
    streamSimple(model, context, options) {
      const messages = messageText(context);
      const latestUser = messages.findLastIndex(message => message.role === "user");
      let prompt = messages[latestUser]?.text ?? "";
      if (prompt.includes("PHASE_A_LATEST")) prompt = "PHASE_A_EVAL\n" + JSON.parse(readFileSync(join(root, "binary", "action.json"), "utf8")).code;
      log({ kind: "provider", model: model.id, tools: context.tools?.map(tool => tool.name), prompt: prompt.slice(-180) });
      options?.signal?.addEventListener("abort", () => log({ kind: "provider_abort", model: model.id }), { once: true });
      const main = prompt.indexOf("PHASE_A_EVAL\n");
      let response;
      if (main >= 0) {
        response = messages.slice(latestUser + 1).some(message => message.role === "toolResult")
          ? { content: ["phase-a-control-finished"] }
          : { content: [{ type: "toolCall" as const, name: "eval", arguments: { language: "js", code: prompt.slice(main + "PHASE_A_EVAL\n".length) } }] };
      } else {
        const worker = messages.map(message => message.text).join("\n").match(/PHASE_A_WORKER:(\w+)/)?.[1];
        if (!worker) response = { content: ["phase-a-ready"] };
        else if (worker === "slow") response = { content: ["unreachable slow result"], delayMs: 60_000 };
        else if (worker === "invalid") response = { content: [{ type: "toolCall" as const, name: "yield", arguments: { data: { model: model.id, value: "wrong-type" } } }] };
        else if (worker === "dynamic") {
          const transformed = messages.slice(latestUser + 1).findLast(message => message.role === "toolResult");
          response = transformed
            ? { content: [{ type: "toolCall" as const, name: "yield", arguments: { data: { model: model.id, value: JSON.parse(transformed.text) } } }] }
            : { content: [{ type: "toolCall" as const, name: "eval", arguments: { language: "js", code: "const transformed = await tool.phase_a_transform({ value: 7 }); display(JSON.parse(transformed.text));" } }] };
        } else response = { content: [{ type: "toolCall" as const, name: "yield", arguments: { ...(prompt.includes("<workpool ") ? { key: 1 } : {}), data: { model: model.id, value: worker === "poolbad" ? "wrong-type" : 7 } } }], delayMs: 150 };
      }
      const stream = createMockModel({ id: model.id, provider: model.provider, handler: response }).stream(model, context, options);
      void stream.result().then(message => log({ kind: "provider_settled", model: model.id, stopReason: message.stopReason }));
      return stream;
    },
  });
  pi.registerTool({
    name: "supership_receipt", label: "Supership Phase A receipt", description: "Validate a hash-bound Phase A action receipt",
    parameters: Type.Object({ run: Type.String(), revision: Type.Number(), action: Type.String(), kind: Type.String(), data: Type.Unknown() }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const action = actions.get(args.action);
      if (args.run !== run || args.revision !== revision || !action || !action.started) throw new Error("stale or unknown receipt");
      if (action.receipts.has(args.kind)) { log({ kind: "duplicate_receipt", run, action: args.action }); return { content: [{ type: "text", text: "duplicate ignored" }], details: { duplicate: true } }; }
      const snapshot = ctx.getAsyncJobSnapshot();
      if (args.kind === "recovered") {
        const reportedId = (args.data as { id: string }).id;
        if (![...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].some(job => job.id === reportedId)) throw new Error("receipt refers to unknown runtime job");
      }
      const itemValidation: Array<{ id: string; valid: boolean }> = [];
      if (args.kind === "pool_complete") {
        const data = args.data as { peek: { batches: Array<{ items: string[]; output: string }> } };
        for (const batch of data.peek.batches) {
          const results = JSON.parse(batch.output);
          for (const item of batch.items) itemValidation.push({ id: item, valid: workerSchema.safeParse(results[item]).success });
        }
      }
      action.receipts.add(args.kind);
      log({ ...args, kind: "receipt", receiptKind: args.kind, snapshot, itemValidation });
      return { content: [{ type: "text", text: "accepted" }], details: { accepted: true } };
    },
  });
  pi.registerCommand("phase-a", {
    description: "Test-only Supership Phase A proof command",
    async handler(raw, ctx) {
      const args = JSON.parse(raw) as { op: string; run?: string; models?: string[]; scenario?: string };
      const settings = await SettingsManager.create(ctx.cwd);
      const binary = args.op === "binary";
      if (binary) { args.run = "binary"; args.models = ["a", "b"]; args.scenario = "startup"; }
      if (args.op === "start" || binary) {
        if (settings.get("task.disabledAgents").includes("reviewer")) throw new Error("Required base agent reviewer is disabled");
        run = args.run!; runRoot = join(root, run); mkdirSync(join(runRoot, "agents"), { recursive: true });
        const reviewer = readFileSync(join(root, "bundled", "reviewer.md"), "utf8");
        const body = reviewer.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
        aliases = args.models!.map((model, index) => {
          const name = `${run}-${hash(runRoot).slice(0, 8)}-reviewer-${index}`;
          const prewalk = settings.get("task.agentPrewalk").reviewer ?? "off";
          const advisor = settings.get("task.agentAdvisor").reviewer ?? "off";
          writeFileSync(join(runRoot, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Run-bound reviewer fixture\nmodel: openai-codex/phase-a-${model}\nprewalk: ${JSON.stringify(prewalk === "off" ? false : prewalk === "on" ? true : prewalk)}\nadvisor: ${JSON.stringify(advisor === "off" ? false : advisor === "on" ? true : advisor)}\n---\n${body}`);
          return name;
        });
        settings.override("extensions", [...settings.get("extensions"), runRoot]);
        log({ kind: "started", run, aliases, extensions: settings.get("extensions"), bodyHash: hash(body) });
        if (!binary) return;
      }
      if (args.op === "restore") {
        settings.override("extensions", settings.get("extensions").filter((path: string) => path !== runRoot));
        log({ kind: "restored", run, extensions: settings.get("extensions") });
        return;
      }
      if (args.op === "revise") { revision++; return; }
      const scenario = args.scenario!;
      const id = `${run}-${actions.size}-${scenario}`;
      const prefix = `/* phase-a ${run} revision ${revision} action ${id} recipients ${aliases.join(",")} */\n`;
      const receipt = (kind: string, data: string) => `await tool.supership_receipt({run:${JSON.stringify(run)},revision:${revision},action:${JSON.stringify(id)},kind:${JSON.stringify(kind)},data:${data}});`;
      let program: string;
      if (scenario === "finite") {
        program = `const results = await tool.task({context:"Offline Phase A scripted proof",tasks:${JSON.stringify(aliases.map((agent, index) => ({ agent, name: `${run}-seat-${index}`, task: "PHASE_A_WORKER:valid", outputSchema: schema, schemaMode: "strict" })))}}); ${receipt("created", "results")} const settled = results.details.results.filter(result=>result.structuredOutput).map(result=>({id:result.id,status:result.exitCode===0?"completed":"failed",structured:result.structuredOutput,resolvedModel:result.resolvedModel})); let pending = ${JSON.stringify(aliases.map((_agent,index) => `${run}-seat-${index}`))}; pending=pending.filter(id=>!settled.some(job=>job.id===id)); const deadline=Date.now()+20000; while(pending.length) { if(Date.now()>deadline) throw new Error("task wait deadline"); const snapshot=await tool.hub({op:"wait",ids:pending,timeoutMs:2000}); if(!snapshot.details?.jobs?.length) throw new Error(JSON.stringify(snapshot)); for(const job of snapshot.details.jobs) if(job.status!=="running") settled.push(job); pending=pending.filter(id=>!settled.some(job=>job.id===id)); }; ${receipt("complete", "settled")}`;
      } else if (scenario === "isolated") {
        program = `const result = await tool.task({context:"Offline Phase A scripted proof",tasks:[{agent:${JSON.stringify(aliases[0])},name:${JSON.stringify(run + "-isolated")},task:"PHASE_A_WORKER:valid",isolated:true,outputSchema:${JSON.stringify(schema)},schemaMode:"strict"}]}); ${receipt("created", "result")} const settled = result.details.results.filter(result=>result.structuredOutput).map(result=>({id:result.id,status:result.exitCode===0?"completed":"failed",structured:result.structuredOutput,resolvedModel:result.resolvedModel})); let pending = ${JSON.stringify([run+"-isolated"])}; pending=pending.filter(id=>!settled.some(job=>job.id===id)); const deadline=Date.now()+20000; while(pending.length) { if(Date.now()>deadline) throw new Error("task wait deadline"); const snapshot=await tool.hub({op:"wait",ids:pending,timeoutMs:2000}); if(!snapshot.details?.jobs?.length) throw new Error(JSON.stringify(snapshot)); for(const job of snapshot.details.jobs) if(job.status!=="running") settled.push(job); pending=pending.filter(id=>!settled.some(job=>job.id===id)); }; ${receipt("complete", "settled")}`;
      } else if (scenario === "dynamic") {
        program = `tool(({value}) => value * 3 + 2, {name:"phase_a_transform",description:"Fixture arbitrary parent closure",parameters:{type:"object",properties:{value:{type:"number"}},required:["value"],additionalProperties:false}}); const result = await tool.task({context:"Offline Phase A scripted proof",tasks:[{agent:${JSON.stringify(aliases[0])},name:${JSON.stringify(run + "-dynamic")},task:"PHASE_A_WORKER:dynamic",isolated:true,tools:["phase_a_transform"],outputSchema:${JSON.stringify(schema)},schemaMode:"strict"}]}); ${receipt("created", "result")} const settled = result.details.results.filter(result=>result.structuredOutput).map(result=>({id:result.id,status:result.exitCode===0?"completed":"failed",structured:result.structuredOutput,resolvedModel:result.resolvedModel})); let pending = ${JSON.stringify([run+"-dynamic"])}; pending=pending.filter(id=>!settled.some(job=>job.id===id)); const deadline=Date.now()+20000; while(pending.length) { if(Date.now()>deadline) throw new Error("task wait deadline"); const snapshot=await tool.hub({op:"wait",ids:pending,timeoutMs:2000}); if(!snapshot.details?.jobs?.length) throw new Error(JSON.stringify(snapshot)); for(const job of snapshot.details.jobs) if(job.status!=="running") settled.push(job); pending=pending.filter(id=>!settled.some(job=>job.id===id)); }; ${receipt("complete", "settled")}`;
      } else if (scenario === "pool") {
        program = `globalThis.phasePool = await workpool(${JSON.stringify(aliases[0])}, {name:${JSON.stringify(run+"-pool")},context:"Offline Phase A pool"}); const ids=await globalThis.phasePool.push("PHASE_A_WORKER:valid","PHASE_A_WORKER:poolbad"); ${receipt("created", "{name:globalThis.phasePool.name,ids,status:await globalThis.phasePool.status()}")}`;
      } else if (scenario === "pool-collect") {
        program = `${receipt("pool_complete", "{status:await globalThis.phasePool.status(),peek:await globalThis.phasePool.peek()}")} await globalThis.phasePool.close();`;
      } else if (scenario === "pool-slow") {
        program = `globalThis.slowPool = await workpool(${JSON.stringify(aliases[0])}, {name:${JSON.stringify(run+"-slow-pool")},context:"Offline Phase A cancellation"}); const ids=await globalThis.slowPool.push("PHASE_A_WORKER:slow","PHASE_A_WORKER:slow","PHASE_A_WORKER:slow"); ${receipt("created", "{name:globalThis.slowPool.name,ids,status:await globalThis.slowPool.status()}")}`;
      } else if (scenario === "pool-cancel") {
        program = `await globalThis.slowPool.close(); ${receipt("closed", "{status:await globalThis.slowPool.status(),peek:await globalThis.slowPool.peek()}")} const cancellation=await tool.hub({op:"cancel",ids:[globalThis.slowPool.name]}); ${receipt("cancelling", "cancellation")}`;
      } else if (scenario === "pool-stopped") {
        program = `${receipt("cancelled", "{status:await globalThis.slowPool.status(),peek:await globalThis.slowPool.peek(),roster:await tool.hub({op:'list'})}")}`;
      } else if (scenario === "interrupt") {
        program = `globalThis.phaseHandle = await agent("PHASE_A_WORKER:slow", {agent:${JSON.stringify(aliases[0])},label:${JSON.stringify(run + "-interrupted")},schema:${JSON.stringify(schema)},schemaMode:"strict"}); throw new Error("phase-a interruption after spawn before receipt");`;
      } else if (scenario === "recover") {
        program = `const before = await tool.hub({op:"jobs"}); const rosterBefore = await tool.hub({op:"list"}); ${receipt("recovered", "{id:globalThis.phaseHandle.id,before,rosterBefore}")} await globalThis.phaseHandle.cancel(); let settled; try { await globalThis.phaseHandle.wait(); settled="unexpected-success"; } catch(error) { settled=String(error); } const after=await tool.hub({op:"jobs"}); const rosterAfter=await tool.hub({op:"list"}); ${receipt("cancelled", "{settled,after,rosterAfter}")}`;
      } else if (scenario === "duplicate") {
        program = `${receipt("complete", "{value:7}")} ${receipt("complete", "{value:7}")}`;
      } else if (scenario === "invalid") {
        program = `const result=await tool.task({context:"Offline Phase A scripted proof",tasks:[{agent:${JSON.stringify(aliases[0])},name:${JSON.stringify(run + "-invalid")},task:"PHASE_A_WORKER:invalid",outputSchema:${JSON.stringify(schema)},schemaMode:"strict"}]}); ${receipt("created", "result")} const settled = result.details.results.filter(result=>result.structuredOutput).map(result=>({id:result.id,status:result.exitCode===0?"completed":"failed",structured:result.structuredOutput,resolvedModel:result.resolvedModel})); let pending = ${JSON.stringify([run+"-invalid"])}; pending=pending.filter(id=>!settled.some(job=>job.id===id)); const deadline=Date.now()+20000; while(pending.length) { if(Date.now()>deadline) throw new Error("task wait deadline"); const snapshot=await tool.hub({op:"wait",ids:pending,timeoutMs:2000}); if(!snapshot.details?.jobs?.length) throw new Error(JSON.stringify(snapshot)); for(const job of snapshot.details.jobs) if(job.status!=="running") settled.push(job); pending=pending.filter(id=>!settled.some(job=>job.id===id)); }; ${receipt("complete", "settled")}`;
      } else program = receipt("complete", "{startup:true}");
      const code = prefix + program;
      const inputHash = hash(JSON.stringify({ run, revision, id, scenario, recipients: aliases }));
      actions.set(id, { code, hash: hash(code), inputHash, revision, started: false, receipts: new Set() });
      writeFileSync(join(runRoot, "action.json"), JSON.stringify({ run, revision, id, code, inputHash }));
      log({ kind: "issued", run, id, revision, scenario, hash: hash(code), inputHash, recipients: aliases });
      // Print mode receives its next explicit user prompt from the test process.
    },
  });
  pi.on("tool_call", event => {
    log({ kind: "tool_call", run, name: event.toolName, input: event.input });
    if (run && event.toolName === "eval") {
      const code = String(event.input.code);
      const action = [...actions.values()].find(action => action.hash === hash(code));
      if (!action || action.revision !== revision || action.started) { log({ kind: "rejected", run, codeHash: hash(code) }); return { block: true, reason: "unrecognized, stale, or consumed control cell" }; }
      action.started = true;
      log({ kind: "authorized", run, hash: action.hash, inputHash: action.inputHash });
    }
  });
  pi.on("tool_result", event => { log({ kind: "tool_result", run, name: event.toolName, error: event.isError, details: event.details, content: event.content }); });
}
