// Loaded by the real installed omp host beside a decoy 0.0.0 `@oh-my-pi/pi-coding-agent` in this directory's node_modules.
// Records which module the host actually served for the extension's import, then exits before any model call.
import * as host from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function versionAlias(api: ExtensionAPI) {
  api.registerProvider("openai-codex", { api: "version-alias-probe", baseUrl: "http://127.0.0.1:1/never", apiKey: "offline-fixture-no-credential", models: [{ id: "alias-probe", name: "Alias probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }], streamSimple() { throw new Error("The alias probe never calls a model"); } });
  api.on("session_start", () => {
    const served = host as unknown as { VERSION?: string; DECOY?: boolean; main?: unknown };
    writeFileSync(process.env.ALIAS_REPORT!, JSON.stringify({ VERSION: served.VERSION, decoy: served.DECOY ?? false, hasMain: typeof served.main, exports: Object.keys(host).length }));
    process.exit(0);
  });
}
