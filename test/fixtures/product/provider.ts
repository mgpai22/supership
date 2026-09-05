import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.env.PRODUCT_ROOT!;
const log = (item: unknown) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(item) + "\n");
export default function fixture(api: ExtensionAPI) {
  log({event:"factory"});
  api.on("before_agent_start", event => { log({event:"before_agent_start",prompt:event.prompt}); });
  api.on("context", event => { log({event:"context",messages:event.messages.map(message=>({role:message.role, ...(message.role === "custom" ? {customType:message.customType, ...(message.customType === "supership-diagnostic" ? {content:message.content} : {})}: {})}))}); });
  api.registerCommand("product-inspect", {description:"Inspect real product registration", async handler(_args,ctx) {log({event:"inspect",commands:api.getCommands().map(command=>command.name),branch:ctx.sessionManager.getBranch()});} });
  api.registerProvider("openai-codex", {
    api: "supership-scripted", baseUrl: "http://127.0.0.1:1/never", apiKey: "offline-fixture-no-credential",
    models: ["parent", "a", "b"].map(id => ({ id: `product-${id}`, name: `Product ${id}`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
    streamSimple(model, context, options) {
      const messages = context.messages.map(message => ({ role: message.role, text: typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n") }));
      const user = messages.findLast(message => message.role === "user")?.text ?? "";
      log({ event: "provider", model: model.id, user: user.slice(0, 200), ...(user.includes("PRODUCT_CELL") ? {lastToolResult:messages.findLast(message=>message.role==="toolResult")?.text} : {}), tools: context.tools?.map(tool => tool.name) });
      let response: NonNullable<Parameters<typeof createMockModel>[0]>["handler"];
      if (model.id !== "product-parent") {
        const joined = messages.map(message => message.text).join("\n");
        const marker = /\{"assignment":([^]*)/.exec(joined);
        let assignment: { assignment: { kind: string }; work: { id: string; revision: number; attemptId: string } } | undefined;
        if (marker) { const start = joined.indexOf('{"assignment":'); for (let end = joined.length; end > start; end--) { try { assignment = JSON.parse(joined.slice(start, end)); break; } catch { /* Find the exact JSON assignment before OMP's surrounding instructions. */ } } }
        if (!assignment) response = { content: ["No valid fixture assignment."] };
        else { const work = assignment.work; response = { content: [{ type: "toolCall", name: "yield", arguments: { data: { schemaVersion: 1, kind: "research", workId: work.id, workRevision: work.revision, attemptId: work.attemptId, answers: [], gaps: [], proposedPaths: [] } } }], delayMs: 100 }; }
      } else if (user.includes("PRODUCT_CELL\n")) {
        const after = messages.slice(messages.findLastIndex(message => message.role === "user") + 1);
        response = after.some(message => message.role === "toolResult") ? { content: ["fixture cell complete"] } : { content: [{ type: "toolCall", name: "eval", arguments: { language: "js", code: user.slice(user.indexOf("PRODUCT_CELL\n") + "PRODUCT_CELL\n".length) } }] };
      } else if (user.includes("Supership preflight") || user.includes("Continue Supership")) {
        const after = messages.slice(messages.findLastIndex(message => message.role === "user") + 1);
        const latest = existsSync(join(root, "next.json")) ? JSON.parse(readFileSync(join(root, "next.json"), "utf8")) : undefined;
        if (!after.some(message => message.role === "toolResult")) response = { content: [{ type: "toolCall", name: "eval", arguments: { language: "js", code: "display(await tool.supership_next({}));", timeout: 0 } }] };
        else if (latest?.cell && after.filter(message => message.role === "toolResult").length === 1) response = { content: [{ type: "toolCall", name: "eval", arguments: { language: "js", code: latest.cell.code } }] };
        else response = { content: ["fixture stopped at the observed product boundary"] };
      } else response = { content: ["fixture ready"] };
      return createMockModel({ id: model.id, provider: model.provider, handler: response }).stream(model, context, options);
    },
  });
  api.on("tool_call", event => { log({ event: "tool_call", name: event.toolName, input: event.input }); });
  api.on("tool_result", event => { log({ event: "tool_result", name: event.toolName, details: event.details, content: event.content, error: event.isError || !!(event.details as {isError?:boolean})?.isError }); if (event.toolName === "supership_next") writeFileSync(join(root, "next.json"), JSON.stringify(event.details)); });
}
