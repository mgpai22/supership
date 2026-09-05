
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "@oh-my-pi/pi-coding-agent";

// The public main entry selects OMP's real print host. Bare createAgentSession leaves
// ExtensionAPI action methods unbound; constructing a replacement runtime would hide that defect.
const root = process.env.PRODUCT_ROOT!, cwd = process.env.PRODUCT_CWD!;
const extension = process.env.PRODUCT_EXTENSION ?? resolve(import.meta.dir, "../../../src/extension.ts");
const provider = join(import.meta.dir, "provider.ts");
const policy = { schemaVersion: 1, seats: ["scout", "architect", "critic", "judge", "judge-secondary", "correctness", "simplicity", "builder"].map(seatId => ({ seatId, agentName: "reviewer", model: "openai-codex/product-a" })), namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], phaseGates: [], pathRouting: [], instructionRefs: [] };
mkdirSync(join(cwd, ".omp"), { recursive: true });
writeFileSync(join(cwd, ".omp", "supership.json"), JSON.stringify(policy));
const config = join(root, "offline.yml");
writeFileSync(config, `startup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\ncompaction:\n  enabled: false\ntitle:\n  refreshOnReplan: false\nprewalk:\n  enabled: false\nretry:\n  enabled: false\neval:\n  py: false\n  js: true\nbrowser:\n  enabled: false\ncomputer:\n  enabled: false\ntask:\n  maxConcurrency: 2\n  isolation:\n    enabled: true\n    apply: false\n  agentPrewalk:\n    reviewer: off\n  agentAdvisor:\n    reviewer: off\nproviders:\n  openai-codex:\n    codeMode: on\nextensions:\n  - ${JSON.stringify(extension)}\n  - ${JSON.stringify(provider)}\n`);
await main(["--config", config, "--no-title", "--no-session", "--no-lsp", "--no-skills", "--no-rules", "--model", "openai-codex/product-parent", "-p", "/shipit --slug product-smoke No changes; inspect only", "/shipit --slug second-run Cannot start concurrently", "PRODUCT_CELL\nawait Bun.write("+JSON.stringify(join(root,"unauthorized.txt"))+",'unexpected');"]);

