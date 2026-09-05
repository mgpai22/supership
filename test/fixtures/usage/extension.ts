import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Type from "@sinclair/typebox/type";
import { observeChildUsage, prepareUsageMeter } from "../../../src/usage.ts";

const root = process.env.USAGE_PROOF_ROOT!;
const log = (value: object) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(value) + "\n");
const cost = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });

export default function proof(api: ExtensionAPI) {
  // The product extension installs this in its factory; children that rebind the factory observe active meters.
  observeChildUsage(api);
  api.on("session_start", (_event, ctx) => log({ kind: "session", id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }));
  // Ground truth for the observer: every assistant message OMP delivers to hooks in every session.
  api.on("message_end", (event, ctx) => { if (event.message.role === "assistant") log({ kind: "assistant", session: ctx.sessionManager.getSessionId(), model: `${event.message.provider}/${event.message.model}`, stopReason: event.message.stopReason, tokens: event.message.usage.totalTokens, cost: event.message.usage.cost.total }); });
  api.registerTool({
    name: "usage_proof_prepare", label: "Prepare usage meter", description: "Controller-side fixture: prepares the run meter inside the extension graph",
    parameters: Type.Object({ runPath: Type.String(), runId: Type.String(), ownerEpoch: Type.Number() }),
    async execute(_id, args, _signal, _update, ctx) {
      const meter = await prepareUsageMeter({ ...args, parentSessionId: ctx.sessionManager.getSessionId() });
      return { content: [{ type: "text", text: JSON.stringify(meter) }], details: meter };
    },
  });
  api.registerProvider("openai-codex", {
    api: "usage-scripted", baseUrl: "http://127.0.0.1:1/never", apiKey: "offline-fixture-no-credential",
    models: [
      { id: "usage-parent", name: "Usage parent", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "usage-priced", name: "Usage priced", reasoning: false, input: ["text"], cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "usage-unpriced", name: "Usage unpriced", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
    ],
    streamSimple(model, context, options) {
      log({ kind: "provider", model: model.id });
      const messages = context.messages.map(message => ({ role: message.role, text: typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n") }));
      const latestUser = messages.findLastIndex(message => message.role === "user"); const prompt = messages[latestUser]?.text ?? "";
      const turnResults = messages.slice(latestUser + 1).filter(message => message.role === "toolResult").length;
      const evalCall = { type: "toolCall" as const, name: "eval", arguments: { language: "js", code: "display(1);" } };
      let response;
      if (model.id === "usage-parent") {
        response = prompt.includes("USAGE_EVAL\n") && !turnResults ? { content: [{ type: "toolCall" as const, name: "eval", arguments: { language: "js", timeout: 120, code: prompt.slice(prompt.indexOf("USAGE_EVAL\n") + "USAGE_EVAL\n".length) } }] } : { content: ["usage-control-finished"] };
      } else if (prompt.includes("<workpool ")) {
        // One yield per item; a two-item batch produces two assistant messages in the same native session.
        const key = turnResults + 1;
        response = { content: [{ type: "toolCall" as const, name: "yield", arguments: { key, data: { item: key } } }], usage: { input: 100 * key, output: 10, cacheRead: 1000, cacheWrite: 0, cost: cost(0.001 * key, 0.0002, 0.001, 0) } };
      } else if (prompt.includes("USAGE_ABORT")) {
        if (turnResults) { writeFileSync(join(root, "abort-ready"), "ready"); response = { content: ["unreachable"], delayMs: 60_000 }; }
        else response = { content: [evalCall], usage: { input: 100, output: 10, cacheRead: 300, cacheWrite: 50, cost: cost(0.001, 0.0002, 0.0003, 0.000625) } };
      } else {
        // Unpriced model: tokens are reported, the rate card is all zeros, so cost stays unknown rather than free.
        response = turnResults ? { content: [{ type: "toolCall" as const, name: "yield", arguments: { data: { done: true } } }], usage: { input: 40, output: 8, cacheRead: 120, cacheWrite: 0 } } : { content: [evalCall], usage: { input: 30, output: 6, cacheRead: 100, cacheWrite: 0 } };
      }
      return createMockModel({ id: model.id, provider: model.provider, handler: response }).stream(model, context, options);
    },
  });
}
