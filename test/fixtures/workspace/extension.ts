import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as Type from "@sinclair/typebox/type";
import { appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routeWorkspaceOperation } from "../../../src/workspace.ts";
import type { WorkspaceBinding, WorkspaceOperation } from "../../../src/workspace.ts";

const root = process.env.WORKSPACE_PROOF_ROOT!;
const log = (value: object) => appendFileSync(join(root, "events.jsonl"), JSON.stringify(value) + "\n");

export default function proof(api: ExtensionAPI) {
  api.on("session_start", (_event, ctx) => log({ kind: "session", cwd: ctx.cwd, id: ctx.sessionManager.getSessionId() }));
  api.on("tool_result", (event, ctx) => log({ kind: "tool", name: event.toolName, cwd: ctx.cwd, error: event.isError, content: event.content }));
  api.registerTool({
    name: "workspace_proof_route", label: "Route fixture workspace", description: "Controller-side fixture route, restricted to the parent session",
    parameters: Type.Object({ marker: Type.String(), operation: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }),
    async execute(_id, args, _signal, _update, ctx) {
      const bindings = JSON.parse(readFileSync(join(root, "bindings.json"), "utf8")) as WorkspaceBinding[];
      const binding = bindings.find(item => item.marker === args.marker);
      if (!binding || ctx.sessionManager.getSessionId() !== binding.parentSessionId) throw new Error("Fixture route requires the granted parent callback");
      const route = routeWorkspaceOperation(binding, args.operation as WorkspaceOperation, args.input);
      log({ kind: "route", work: binding.work.id, operation: args.operation, input: route.input });
      return { content: [{ type: "text", text: JSON.stringify(route) }], details: route };
    },
  });
  api.registerTool({
    name: "workspace_proof_state", label: "Observe fixture provider", description: "Read whether the child provider has completed mutation",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: existsSync(join(root, "ready")) ? "ready" : "not-yet" }], details: { ready: existsSync(join(root, "ready")) } }; },
  });
  api.registerProvider("openai-codex", {
    api: "workspace-scripted", baseUrl: "http://127.0.0.1:1/never", apiKey: "offline-fixture-no-credential",
    models: ["parent", "child"].map(id => ({ id: `workspace-${id}`, name: `Workspace ${id}`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
    streamSimple(model, context, options) {
      const messages = context.messages.map(message => ({ role: message.role, text: typeof message.content === "string" ? message.content : message.content.map(block => "text" in block ? block.text : "").join("\n") }));
      const latestUser = messages.findLastIndex(message => message.role === "user"); const prompt = messages[latestUser]?.text ?? "";
      let response;
      if (model.id === "workspace-parent" && prompt.includes("WORKSPACE_EVAL\n")) {
        response = messages.slice(latestUser + 1).some(message => message.role === "toolResult") ? { content: ["workspace-control-finished"] } : { content: [{ type: "toolCall" as const, name: "eval", arguments: { language: "js", code: prompt.slice(prompt.indexOf("WORKSPACE_EVAL\n") + "WORKSPACE_EVAL\n".length) } }] };
      } else if (model.id === "workspace-child") {
        if (prompt.includes("WORKSPACE_UNBOUND")) {
          const bindings = JSON.parse(readFileSync(join(root, "bindings.json"), "utf8")) as WorkspaceBinding[];
          const code = `let nativeDenied=false, grantDenied=false;
try { await tool.write({path:"unbound.txt",content:"forbidden"}); } catch(error) { nativeDenied=String(error).includes("child guard denies"); }
try { await tool[${JSON.stringify(bindings[1]!.grantName)}]({operation:"write",input:{path:"new.txt",content:"forbidden"}}); } catch(error) { grantDenied=String(error).includes("child guard denies"); }
if (!nativeDenied || !grantDenied) throw new Error("Missing manifest did not fail closed");
display({marker:"unbound-denied",nativeDenied,grantDenied});`;
          response = messages.some(message => message.role === "toolResult" && message.text.includes("unbound-denied"))
            ? { content: [{ type: "toolCall" as const, name: "yield", arguments: { data: { marker: "unbound-denied", nativeDenied: true, grantDenied: true } } }] }
            : { content: [{ type: "toolCall" as const, name: "eval", arguments: { language: "js", code } }] };
          return createMockModel({ id: model.id, provider: model.provider, handler: response }).stream(model, context, options);
        }
        if (messages.some(message => message.role === "toolResult" && message.text.includes("workspace-mutation-complete"))) {
          writeFileSync(join(root, "ready"), "ready"); response = { content: ["unreachable"], delayMs: 60000 };
        } else {
          const [a, b] = JSON.parse(readFileSync(join(root, "bindings.json"), "utf8")) as WorkspaceBinding[];
          const callback = `tool[${JSON.stringify(a!.grantName)}]`;
          const code = `
let nativeWriteDenied = false; let crossWorkDenied = false;
try { const denied = await tool.write({i:"Trying denied native write",path:"native-denied.txt",content:"forbidden"}); nativeWriteDenied = JSON.stringify(denied).includes("child guard denies"); } catch (error) { nativeWriteDenied = String(error).includes("child guard denies"); }
try { const denied = await tool[${JSON.stringify(b!.grantName)}]({operation:"write",input:{path:"new.txt",content:"forbidden"}}); crossWorkDenied = JSON.stringify(denied).includes("error"); } catch { crossWorkDenied = true; }
if (!nativeWriteDenied || !crossWorkDenied) throw new Error("Guard allowed a forbidden operation");
const approvedRead = await tool.supership_proof_read({});
if (!JSON.stringify(approvedRead).includes("unstaged user")) throw new Error("Exact approved dynamic grant did not read its durable source");
await ${callback}({operation:"write",input:{i:"Writing durable output",path:"new.txt",content:"durable output\\n"}});
const readResult = await ${callback}({operation:"read",input:{i:"Reading durable source",path:"tracked.txt"}});
const tag = JSON.stringify(readResult).match(/#([A-F0-9]{4})/);
if (!tag) throw new Error("Native read did not return a hashline snapshot: " + JSON.stringify(readResult));
const editResult = await ${callback}({operation:"edit",input:{i:"Editing durable source",input:"[tracked.txt#"+tag[1]+"]\\nPUT 1.=1:\\n+child mutation\\n"}});
if (editResult?.isError) throw new Error(JSON.stringify(editResult));
await ${callback}({operation:"bash",input:{i:"Writing through native shell",command:"printf 'native-callback-command\\\\n' > command.txt"}});
display({marker:"workspace-mutation-complete",nativeWriteDenied,crossWorkDenied});`;
          response = { content: [{ type: "toolCall" as const, name: "eval", arguments: { language: "js", code } }] };
        }
      } else response = { content: ["workspace-ready"] };
      return createMockModel({ id: model.id, provider: model.provider, handler: response }).stream(model, context, options);
    },
  });
}
