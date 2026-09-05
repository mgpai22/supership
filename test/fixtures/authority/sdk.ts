import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { main } from "@oh-my-pi/pi-coding-agent";

const root = process.env.AUTHORITY_ROOT!, cwd = process.env.AUTHORITY_CWD!, source = process.env.AUTHORITY_SOURCE_ROOT!;
assert.ok(isAbsolute(root) && isAbsolute(cwd) && isAbsolute(source), "Authority proof requires explicit absolute paths");
const policy = {
  schemaVersion: 1,
  seats: ["scout", "architect", "critic", "judge", "judge-secondary", "correctness", "simplicity", "builder"].map(seatId => ({ seatId, agentName: "reviewer", model: "openai-codex/authority-worker" })),
  namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], phaseGates: [], pathRouting: [], instructionRefs: [],
};
mkdirSync(join(cwd, ".omp"), { recursive: true });
writeFileSync(join(cwd, ".omp", "supership.json"), JSON.stringify(policy));
const config = join(root, "offline.yml");
writeFileSync(config, Bun.YAML.stringify({
  startup: { checkUpdate: false }, marketplace: { autoUpdate: false }, memory: { backend: "off" },
  autolearn: { enabled: false }, compaction: { enabled: false }, title: { refreshOnReplan: false },
  prewalk: { enabled: false }, retry: { enabled: false }, eval: { py: false, js: true },
  browser: { enabled: false }, computer: { enabled: false },
  task: { maxConcurrency: 2, isolation: { enabled: true, apply: false }, agentPrewalk: { reviewer: "off" }, agentAdvisor: { reviewer: "off" } },
  providers: { "openai-codex": { codeMode: "off" } },
  extensions: [join(source, "src", "extension.ts"), join(import.meta.dir, "provider.ts")],
}));
// Public main binds the real print host's extension actions. A bare SDK session does not.
// The resume lowers the run cap beneath the configured OMP ceiling of 2, so the recorded snapshot must still report the true ceiling.
const command = process.env.AUTHORITY_PHASE === "resume" ? "/shipit --resume authority-proof --concurrency 1" : "/shipit --slug authority-proof Inspect baseline.txt. No source changes are required; verify its bytes.";
await main(["--config", config, "--no-title", "--no-session", "--no-lsp", "--no-skills", "--no-rules", "--model", "openai-codex/authority-parent", "-p", command]);
