import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shareNativeCache } from "./support/native-cache.ts";

test("Phase A executes installed OMP and public SDK sessions with inherited network denial", async () => {
  const protectedPaths = [join(process.env.HOME!, ".omp/agent/config.yml"), join(process.env.HOME!, ".omp/agent/models.yml"), resolve(".omp/config.yml")];
  const protectedBytes = protectedPaths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
  const root = mkdtempSync(join(tmpdir(), "supership-phase-a-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(home); mkdirSync(cwd);
  shareNativeCache(home);
  mkdirSync(join(home, ".omp/agent"), { recursive: true });
  const isolatedConfig = join(home, ".omp/agent/config.yml");
  const isolatedConfigBytes = "extensions: []\n";
  writeFileSync(isolatedConfig, isolatedConfigBytes);
  const launcher = join(root, "deny-network");
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"), PI_CODING_AGENT_DIR: join(home, ".omp/agent"),
    TMPDIR: root, LC_ALL: "C", TERM: "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true",
    PHASE_A_ROOT: root, PHASE_A_CWD: cwd,
  };
  const run = (argv: string[]) => {
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(root, "last-command.json"), JSON.stringify({ argv, status: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${argv.join(" ")}\n${result.stdout}\n${result.stderr}\nEvidence: ${root}`);
    return result.stdout;
  };
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve("test/support/deny-network.c")]);
  run(["git", "init", "-q", "-b", "fixture"]);
  run(["git", "-c", "user.name=Offline Fixture", "-c", "user.email=offline@invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const installed = Bun.which("omp");
  assert.ok(installed, "installed OMP binary required");

  run([launcher, installed, "agents", "unpack", "--dir", join(root, "bundled"), "--json"]);
  const config = join(root, "offline.yml");
  writeFileSync(config, "startup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\ncompaction:\n  enabled: false\ntitle:\n  refreshOnReplan: false\nprewalk:\n  enabled: false\nretry:\n  enabled: false\neval:\n  py: false\n  js: true\nbrowser:\n  enabled: false\ncomputer:\n  enabled: false\nproviders:\n  openai-codex:\n    codeMode: on\n");
  const binaryOutput = run([launcher, installed, "--config", config, "--no-title", "--no-session", "--no-lsp", "--no-skills", "--no-rules", "--model", "openai-codex/phase-a-parent", "-e", resolve("test/fixtures/phase-a/extension.ts"), "-p", '/phase-a {"op":"binary"}', "PHASE_A_LATEST"]);
  assert.match(binaryOutput, /phase-a-control-finished/, `Installed CLI evidence: ${root}/last-command.json`);
  assert.ok(readFileSync(join(root, "events.jsonl"), "utf8").includes('"receiptKind":"complete"'));
  const output = run([launcher, process.execPath, resolve("test/fixtures/phase-a/sdk.ts")]);
  assert.equal(readFileSync(isolatedConfig, "utf8"), isolatedConfigBytes);
  assert.deepEqual(protectedPaths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null), protectedBytes);
  writeFileSync(join(root, "global-files-evidence.json"), JSON.stringify({ unchanged: protectedPaths, isolatedConfigUnchanged: true }));
  console.log(output);
}, 300_000);
