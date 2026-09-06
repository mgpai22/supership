import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSchema, RelativePathSchema, WorkAssignmentSchema, WorkRefSchema, type Limits, type RunRecord } from "../../../src/contracts.ts";
import { Type, type Static } from "@sinclair/typebox/type";
import { dynamicProposal, type Scenario } from "./scenarios.ts";
import { prepareManagedInstallation, type ManagedInstallation } from "./migration.ts";
import { shareNativeCache } from "../../support/native-cache.ts";

const FixtureEventSchema = Type.Object({
  event: Type.String(), time: Type.Number(), pid: Type.Number(),
  sessionId: Type.Optional(Type.String()), toolCallId: Type.Optional(Type.String()), model: Type.Optional(Type.String()), name: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()), message: Type.Optional(Type.String()), content: Type.Optional(Type.Unknown()),
  commands: Type.Optional(Type.Array(Type.String())), commandDetails: Type.Optional(Type.Array(Type.Object({ name: Type.String(), source: Type.String(), location: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }, { additionalProperties: true }))), tools: Type.Optional(Type.Array(Type.String())),
  runtimeNames: Type.Optional(Type.Array(Type.String())), input: Type.Optional(Type.Unknown()), details: Type.Optional(Type.Unknown()), stopReason: Type.Optional(Type.String()), error: Type.Optional(Type.Boolean()),
  privateMarkers: Type.Optional(Type.Array(Type.String())),
  messages: Type.Optional(Type.Array(Type.Object({ role: Type.String(), customType: Type.Optional(Type.String()), content: Type.Optional(Type.Unknown()) }, { additionalProperties: true }))),
  work: Type.Optional(WorkRefSchema), packet: Type.Optional(Type.Union([Type.Null(), Type.Object({ assignment: WorkAssignmentSchema, work: WorkRefSchema })])),
}, { additionalProperties: true });
export type FixtureEvent = Static<typeof FixtureEventSchema>;
export interface Snapshot {
  label: string;
  time: number;
  state?: RunRecord;
  files: Record<string, string>;
  eventsLog: string;
}
export interface Evidence {
  root: string;
  cwd: string;
  slug: string;
  snapshots: Snapshot[];
  hostRunning?: boolean;
  state?: RunRecord;
  events: FixtureEvent[];
  terminal: string;
  exitCode: number | null;
  surface: "installed-print" | "installed-tui";
}
export type CrashWhen = "write" | "pool" | "tool" | ((event: FixtureEvent, events: readonly FixtureEvent[], state: RunRecord | undefined) => boolean);
export type RecoveryChoiceName = "adopt" | "retry" | "discard" | "stop" | "recreate-tool" | "reproposal" | "continue";
export interface RunOptions {
  persistedSession?: boolean;
  tui?: boolean; timeout?: number; nonGit?: boolean; nativePlanMode?: boolean; extraArgs?: string[];
  resume?: Evidence;
  whileRunning?: (evidence: Evidence) => Promise<void>;
  beforeResumeEdits?: Array<{ path: string; content: string }>;
  disabledEval?: boolean;
  disabledAgent?: string;
  missingJudgeModel?: boolean;
  /** first-fail: the repository check fails once, then passes; a trusted retry proves the same run re-verifies. */
  policyVerification?: "pass" | "fail" | "first-fail";
  cancelAfterWrite?: boolean;
  /** Send the public cancel command at the first matching observation (same matchers as crashWhen). */
  cancelWhen?: CrashWhen;
  steerAfterWrite?: string;
  crashWhen?: CrashWhen;
  /** One trusted recovery choice, or the ordered choices for successive recovery prompts. */
  recoveryChoice?: RecoveryChoiceName | RecoveryChoiceName[];
  recoveryLimits?: Limits;
  /** Trusted answer for each uncertain parent callback after choosing continue. */
  callbackDisposition?: "success" | "failed";
  continueAfterBoundary?: boolean;
  settleMs?: number;
  managedInstallation?: ManagedInstallation;
}
function fixtureEvents(root: string): FixtureEvent[] {
  const path = join(root, "provider.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").slice(0, -1).filter(Boolean).map(line => {
    const value: unknown = JSON.parse(line); assertSchema(FixtureEventSchema, value, "fixture event"); return value;
  });
}
export async function runScenario(scenario: Scenario, options: RunOptions = {}): Promise<Evidence> {
  assert.ok(!options.resume || scenario.id === options.resume.slug, "Resume must retain the original scenario slug");
  assert.ok(!(options.cancelAfterWrite && options.steerAfterWrite) && !(options.cancelWhen && (options.cancelAfterWrite || options.steerAfterWrite)), "Use separate hosts for cancellation and steering");
  assert.ok(!options.beforeResumeEdits?.length || options.resume && !options.resume.hostRunning, "External resume edits require a stopped fixture");
  const tui = options.tui || !!(options.resume || options.cancelAfterWrite || options.cancelWhen || options.steerAfterWrite || options.crashWhen || options.whileRunning);
  const root = mkdtempSync(join(tmpdir(), `supership-acceptance-${scenario.id}-`));
  const cwd = options.resume?.cwd ?? join(root, "repo"), home = join(root, "home"), agentDir = join(home, ".omp", "agent");
  const slug = options.resume?.slug ?? scenario.id, statePath = join(cwd, ".planning", slug, "state.json");
  const stateNow = (): RunRecord | undefined => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
  const snapshots: Snapshot[] = [];
  const snapshot = (label: string) => {
    const files: Record<string, string> = {};
    const visit = (path: string) => {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) files[path] = "symlink:" + readlinkSync(path);
      else if (info.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); }
      else if (info.isFile()) files[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    };
    visit(cwd);
    const state = stateNow();
    for (const worktree of state?.worktrees ?? []) if (!worktree.path.startsWith(cwd + "/") && existsSync(worktree.path)) visit(worktree.path);
    const logPath = join(cwd, ".planning", slug, "events.jsonl");
    const value = { label, time: Date.now(), state, files, eventsLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : "" };
    snapshots.push(value); writeFileSync(join(root, "snapshot-" + label + ".json"), JSON.stringify(value, null, 2)); return value;
  };
  if (options.resume) {
    assert.ok(existsSync(cwd), "The original fixture checkout must survive host exit");
    const before = snapshot("before-resume"), previous = options.resume.snapshots.at(-1);
    assert.ok(previous, "Resume requires evidence from the stopped host");
    if (!options.resume.hostRunning) assert.deepEqual(before.files, previous.files, "Fixture bytes changed between host exit and resume");
    for (const edit of options.beforeResumeEdits ?? []) {
      assertSchema(RelativePathSchema, edit.path, "external fixture edit path");
      assert.ok(!/^(?:\.git|\.omp)(?:\/|$)/.test(edit.path), "External edits cannot change Git internals or OMP settings");
      assert.ok(!edit.path.startsWith(".planning/") || edit.path.startsWith(`.planning/${slug}/evidence/`), "External edits may corrupt captured evidence, never product state or tool sources");
      const path = join(cwd, edit.path), parent = realpathSync(dirname(path));
      assert.ok(parent === cwd || parent.startsWith(cwd + "/"), "External edits must stay in the fixture checkout");
      const target = lstatSync(path, { throwIfNoEntry: false });
      assert.ok(!target || target.isFile(), "External edits cannot follow symlinks or replace directories");
      const beforeHash = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
      writeFileSync(path, edit.content);
      appendFileSync(join(root, "external-edits.jsonl"), JSON.stringify({ time: Date.now(), path, beforeHash, afterHash: createHash("sha256").update(edit.content).digest("hex") }) + "\n");
    }
    if (options.beforeResumeEdits?.length) snapshot("after-external-edits");
  } else { mkdirSync(cwd); mkdirSync(join(cwd, ".omp")); }
  mkdirSync(agentDir, { recursive: true });
  shareNativeCache(home);
  const protectedPaths = [join(process.env.HOME!, ".omp", "agent", "config.yml"), join(process.env.HOME!, ".omp", "agent", "models.yml")];
  const protectedHashes = protectedPaths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
  writeFileSync(join(agentDir, "config.yml"), "extensions: []\n");
  if (!options.resume) {
    writeFileSync(join(cwd, ".gitignore"), ".planning/\n.omp/\n");
    writeFileSync(join(cwd, "baseline.txt"), "user baseline\n");
  }
  writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario));
  const source = process.env.SUPERSHIP_ACCEPTANCE_SOURCE ?? resolve(import.meta.dir, "../../..");
  const extension = join(source, "src", "extension.ts"), provider = join(import.meta.dir, "provider.ts");
  assert.ok(existsSync(extension), `The real Supership extension is required: ${extension}`);
  const launcher = join(root, "deny-network");
  const env = {
    PATH: `${dirname(process.env.SUPERSHIP_ACCEPTANCE_OMP ?? Bun.which("omp") ?? "/usr/bin/omp")}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    PI_CODING_AGENT_DIR: agentDir, TMPDIR: root, LC_ALL: "C", TERM: tui ? "xterm-256color" : "dumb", CI: "1", PI_NO_TITLE: "1", OTEL_SDK_DISABLED: "true",
    ACCEPTANCE_ROOT: root, ACCEPTANCE_CWD: cwd,
  };
  const run = (argv: string[]) => {
    const result = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: "utf8", timeout: options.timeout ?? 120000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(root, "last-command.json"), JSON.stringify({ argv, status: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.ifError(result.error); assert.equal(result.status, 0, `Evidence: ${root}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve(import.meta.dir, "../../support/deny-network.c")]);
  if (!options.resume && !options.nonGit) {
    run(["git", "init", "-q", "-b", "main"]);
    run(["git", "add", "--", ".gitignore", "baseline.txt"]);
    run(["git", "-c", "user.name=Offline Fixture", "-c", "user.email=offline@invalid", "commit", "-qm", "fixture baseline"]);
    run(["git", "config", "user.name", "Offline Fixture"]);
    run(["git", "config", "user.email", "offline@invalid"]);
    if (scenario.push) { run(["git", "init", "--bare", "-q", join(root, "remote.git")]); run(["git", "remote", "add", "origin", join(root, "remote.git")]); }
    if (scenario.command === "superreview") {
      writeFileSync(join(cwd, "baseline.txt"), "user baseline\nreview target\n");
      // A publishing review must commit only the repair; an uncommitted user hunk in the same file is an ownership ambiguity that pauses before staging (covered by the non-publishing superreview rows).
      if (scenario.push && !scenario.dirtyBaseline) { run(["git", "add", "--", "baseline.txt"]); run(["git", "commit", "-qm", "user review target"]); }
    }
  }
  if (!options.resume) writeFileSync(join(cwd, "destructive-target.txt"), "protected fixture bytes\n");
  const bases: Record<string, string> = { scout: "scout", architect: "supership-architect", critic: "supership-critic", judge: "supership-judge", "judge-secondary": "supership-judge", correctness: "reviewer", simplicity: "reviewer", builder: "task", fallback: "reviewer", ...(scenario.securityRisk ? { security: "security-reviewer" } : {}) };
  if (!options.resume) writeFileSync(join(cwd, ".omp", "supership.json"), JSON.stringify({
    schemaVersion: 1, seats: Object.entries(bases).map(([seatId, agentName]) => ({ seatId, agentName, model: `openai-codex/acceptance-${options.missingJudgeModel && seatId === "judge-secondary" ? "unavailable" : seatId === "judge-secondary" ? "alternate" : seatId === "fallback" ? "fallback" : "worker"}` })),
    namedFallbackSeats: [{ seatId: "architect", fallbackSeatIds: ["fallback"] }, { seatId: "builder", fallbackSeatIds: ["fallback"] }],
    limits: scenario.limits ?? {}, requiredLenses: [], verificationChecks: options.policyVerification ? [{ id: "policy-fixture", description: "Run the repository-required fixture check", scenario: { kind: "command", cwd, command: ["bun", "-e", options.policyVerification === "fail" ? 'throw new Error("Repository fixture check failed")' : options.policyVerification === "first-fail" ? 'if(!(await Bun.file(".planning/first-fail.marker").exists())){await Bun.write(".planning/first-fail.marker","");throw new Error("First verification attempt fails")}' : 'if(await Bun.file("baseline.txt").text()!=="user baseline\\n") throw new Error("Baseline differs")'] }, scopePaths: ["baseline.txt"], required: true, source: [] }] : scenario.command === "superreview" ? [{ id: "review-repair", description: "Verify the repaired review target preserves its user prefix", scenario: { kind: "command", cwd, command: ["bun", "-e", 'if(await Bun.file("baseline.txt").text()!=="user baseline\\nreview target repaired\\n") throw new Error("Review repair differs")'] }, scopePaths: ["baseline.txt"], required: true, source: [] }] : [], phaseGates: [], pathRouting: [], instructionRefs: [],
  }));
  if (options.managedInstallation) {
    assert.ok(!options.resume, "Managed migration runs once per fixture host");
    prepareManagedInstallation({ kind: options.managedInstallation, root, repositoryRoot: cwd, packageRoot: source, agentDir, run, launcher });
    if (run(["git", "status", "--porcelain"]).trim()) { run(["git", "add", "-A"]); run(["git", "commit", "-qm", "fixture repository policy files"]); }
  }
  const config = join(root, "offline.yml");
  writeFileSync(config, `startup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\ncompaction:\n  enabled: false\ntitle:\n  refreshOnReplan: false\nprewalk:\n  enabled: false\nretry:\n  enabled: false\neval:\n  py: false\n  js: ${options.disabledEval ? "false" : "true"}\n  workpool:\n    freshAgents: true\nbrowser:\n  enabled: false\ncomputer:\n  enabled: false\ntask:\n  disabledAgents: ${JSON.stringify(options.disabledAgent ? [options.disabledAgent] : [])}\n  maxConcurrency: ${scenario.ompConcurrency ?? 2}\n  isolation:\n    enabled: true\n    apply: false\nisolation:\n  backend: rcopy\nproviders:\n  openai-codex:\n    codeMode: on\nextensions:\n  - ${JSON.stringify(provider)}\n${options.managedInstallation ? "" : `  - ${JSON.stringify(extension)}\n  - ${JSON.stringify(source)}\n`}`);
  const installed = process.env.SUPERSHIP_ACCEPTANCE_OMP ?? Bun.which("omp");
  assert.ok(installed, "Installed OMP is required for acceptance");
  const version = run([launcher, installed, "--version"]).trim();
  // Record the executing patch version; product preflight enforces the supported range.
  const command = options.resume ? `/${scenario.command} --resume ${slug}` : `/${scenario.command} --slug ${slug}${scenario.topology ? ` --topology ${scenario.topology}` : ""}${scenario.reviewRounds ? ` --review-rounds ${scenario.reviewRounds}` : ""}${scenario.concurrency ? ` --concurrency ${scenario.concurrency}` : ""}${scenario.push ? " --push" : ""} Execute offline acceptance ${scenario.id}${scenario.deliveryProof ? " " + 'quote" slash\\ newline\n tab\t 雪🙂\u0001'.repeat(80) : ""}`;
  const args = [launcher, installed, "--config", config, "--no-title", ...options.persistedSession ? [] : ["--no-session"], "--no-lsp", "--no-skills", "--no-rules", "--model", "openai-codex/acceptance-parent", ...options.extraArgs ?? []];
  let terminal: string, exitCode: number | null = 0;
  let timedOut = false, observationError: unknown;
  if (!tui) terminal = run([...args, "-p", "/acceptance-inspect", command]);
  else {
    const escaped = args.map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");
    // A tall PTY keeps every approval preview (plan JSON, tool source, publication target) on one screen, so the recorded prompt is what a user sees before the trusted key.
    const child = spawn("/usr/bin/script", ["-q", "-f", "-e", "-c", "stty rows 160 cols 200 2>/dev/null; exec " + escaped, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout.on("data", chunk => chunks.push(chunk.toString()));
    child.stderr.on("data", chunk => chunks.push(chunk.toString()));
    let exited = false;
    const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", code => { exited = true; resolve(code); }); });
    const deadline = Date.now() + (options.timeout ?? 120000);
    let sentExit = false, sentCommand = false, sentInterview = false, sentLimits = false, sentMode = false, sentInspect = false;
    let intervened = false, observedLive = false, sentStatus = false, sentContinue = false, cursor = 0, lastControl = 0, inputOffset = 0;
    const decisions = new Set<string>(), recoverySelections = new Set<string>();
    let pendingActionId: string | undefined, actionOffset = 0, lastTerminalLength = 0;
    const send = (text: string, reason: string) => {
      inputOffset = chunks.join("").length; child.stdin.write(text);
      appendFileSync(join(root, "tui-inputs.jsonl"), JSON.stringify({ time: Date.now(), text, reason }) + "\n");
    };
    const stopHost = (events: FixtureEvent[], reason: string) => {
      const sessionPath = join(root, "parent-session.txt");
      const session = existsSync(sessionPath) ? readFileSync(sessionPath, "utf8") : undefined;
      const parent = events.find(event => event.event === "session-start" && event.sessionId === session);
      assert.ok(parent && parent.pid !== process.pid, "Crash must target the installed OMP host");
      appendFileSync(join(root, "host-controls.jsonl"), JSON.stringify({ time: Date.now(), pid: parent.pid, signal: "SIGKILL", reason }) + "\n");
      process.kill(parent.pid, "SIGKILL");
    };
    terminal = "";
    try {
      while (!exited && Date.now() < deadline) {
        await Bun.sleep(25);
        terminal = chunks.join("");
        const previousTerminalLength = lastTerminalLength; lastTerminalLength = terminal.length;
        writeFileSync(join(root, "terminal.txt"), terminal);
        const screen = terminal.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        const tail = screen.slice(-12000), responseScreen = terminal.slice(inputOffset).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        writeFileSync(join(root, "terminal-readable.txt"), screen.replaceAll("\r", "\n"));
        const events = fixtureEvents(root), current = stateNow();
        const fresh = events.slice(cursor); cursor = events.length;
        if (!sentCommand && /LSP Servers|run bash|acceptance-parent/.test(tail)) {
          if (!sentInspect) { await Bun.sleep(700); send("/acceptance-inspect\r", "Confirm actual TUI command readiness"); sentInspect = true; continue; }
          if (!events.some(event => event.event === "registration")) continue;
          if (options.nativePlanMode && !sentMode) { send("/plan\r", "Enable actual native PlanMode"); sentMode = true; continue; }
          if (options.nativePlanMode && !/Plan mode enabled|Plan >/.test(tail)) continue;
          send(command + "\r", options.resume ? "Resume original run through public slash command" : "Start actual slash command"); sentCommand = true; lastControl = Date.now(); continue;
        }
        if (intervened && options.steerAfterWrite) {
          const instruction = current?.instructions.find(instruction => instruction.summary === options.steerAfterWrite);
          if (instruction && !snapshots.some(snapshot => snapshot.label === "instruction-recorded")) snapshot("instruction-recorded");
          if (instruction?.status === "applied" && !snapshots.some(snapshot => snapshot.label === "instruction-applied")) snapshot("instruction-applied");
        }
        const write = fresh.find(event => event.event === "tool-result" && event.name === "write" && !event.error);
        if (write && options.whileRunning && !observedLive) {
          observedLive = true; snapshot("live-host");
          try { await options.whileRunning({ root, cwd, slug, snapshots: [...snapshots], hostRunning: true, state: stateNow(), events, terminal, exitCode: null, surface: "installed-tui" }); }
          catch (error) { observationError = error; }
        }
        const matches = (when: CrashWhen | undefined, event: FixtureEvent) => {
          if (typeof when === "function") return when(event, events, current);
          if (when === "write") return event === write;
          if (when === "pool") return event.event === "provider" && !!event.packet && !!current?.pools.some(pool => pool.status === "running" && pool.items.some(item => item.work.id === event.packet?.work.id));
          if (when === "tool") return event === write && !!current?.toolInvocations.some(invocation => invocation.outcome === "running") && current.tools.some(tool => tool.registration === "registered");
          return false;
        };
        const crash = fresh.find(event => matches(options.crashWhen, event));
        if (!intervened && crash) { snapshot("before-crash"); intervened = true; stopHost(events, "Crash at observed " + crash.event + ":" + (crash.name ?? crash.packet?.work.id ?? "")); break; }
        const cancel = options.cancelWhen && fresh.find(event => matches(options.cancelWhen, event));
        if (!intervened && (write && (options.cancelAfterWrite || options.steerAfterWrite) || cancel)) {
          snapshot("before-intervention"); intervened = true;
          const steer = !!options.steerAfterWrite && !cancel;
          send(steer ? options.steerAfterWrite! + "\r" : "/" + scenario.command + " cancel\r", steer ? "Steer after native write, before delayed result" : cancel ? "Cancel at observed " + cancel.event + ":" + (cancel.packet?.work.id ?? cancel.name ?? "") : "Cancel after native write, before delayed result");
          lastControl = Date.now(); continue;
        }
        if (!sentInterview && /Supership: goal, exclusions/.test(tail)) { send("\u0015" + "Execute offline acceptance " + scenario.id + "\r", "Answer actual goal interview"); sentInterview = true; }
        if (!sentLimits && /Optional limits/.test(tail)) { send("\u0015{}\r", "Keep user-configurable limits unlimited"); sentLimits = true; }
        const pending = current?.actions.find(action => action.status === "claimed" && action.input.kind === "collect_input");
        if (pending?.input.kind === "collect_input" && !decisions.has(pending.id)) {
          if (pendingActionId !== pending.id) { pendingActionId = pending.id; actionOffset = previousTerminalLength; }
          const actionScreen = terminal.slice(actionOffset).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
          const request = pending.input.request;
          const wantedChoice = Array.isArray(options.recoveryChoice) ? options.recoveryChoice[Math.min(recoverySelections.size - (recoverySelections.has(pending.id) ? 1 : 0), options.recoveryChoice.length - 1)] : options.recoveryChoice;
          if (options.recoveryLimits && recoverySelections.has(pending.id) && actionScreen.includes("New exact limits.") && !decisions.has(pending.id + ":limits")) {
            send("\u0015" + JSON.stringify(options.recoveryLimits) + "\r", "Enter exact new limits through actual recovery TUI"); decisions.add(pending.id + ":limits"); continue;
          }
          if (wantedChoice === "adopt" && recoverySelections.has(pending.id) && /Paste the inspected worker JSON result for (\S+)\./.test(actionScreen) && !decisions.has(pending.id + ":adopt")) {
            // The trusted user pastes the inspected report; the fixture types the report for the retained bytes it can read.
            const workId = /Paste the inspected worker JSON result for (\S+)\./.exec(actionScreen)![1]!;
            const work = current!.work.find(work => work.id === workId && current!.recovery?.affectedWork.some(ref => ref.id === work.id && ref.revision === work.revision));
            assert.ok(work, "The adoption prompt must name affected work: " + workId);
            const report = { schemaVersion: 1, workId: work.id, workRevision: work.revision, attemptId: work.attempt.id, kind: "build", outcome: "changed", summary: "Adopted the retained interrupted write after inspection", changes: work.expectedPaths.map(path => ({ path, description: "Retained bytes inspected in the checkout" })), verificationClaims: [], evidence: [current!.repository.baselineRef], proposedTools: [] };
            send("\u0015" + JSON.stringify(report) + "\r", "Paste the inspected worker report for explicit adoption of " + workId); decisions.add(pending.id + ":adopt"); continue;
          }
          if ((wantedChoice === "recreate-tool" || wantedChoice === "reproposal") && recoverySelections.has(pending.id) && actionScreen.includes("Paste fresh literal tool proposals") && !decisions.has(pending.id + ":proposals")) {
            const latest = new Map<string, number>();
            for (const tool of current!.tools) latest.set(tool.name, Math.max(latest.get(tool.name) ?? 0, tool.version));
            const proposals = [...latest].map(([name, version]) => ({ ...dynamicProposal(wantedChoice === "recreate-tool" ? version : version + 1), name }));
            send("\u0015" + JSON.stringify(proposals) + "\r", "Paste fresh literal tool proposals for " + wantedChoice); decisions.add(pending.id + ":proposals"); continue;
          }
          if (options.callbackDisposition && wantedChoice === "continue" && recoverySelections.has(pending.id) && /Parent callback .* is uncertain/.test(actionScreen) && !decisions.has(pending.id + ":callback")) {
            appendFileSync(join(root, "tui-prompts.jsonl"), JSON.stringify({ time: Date.now(), actionId: pending.id, requestId: "callback-disposition", screen: actionScreen }) + "\n");
            send(options.callbackDisposition === "success" ? "\r" : "\u001b[B\r", "Decide the uncertain parent callback as " + options.callbackDisposition); decisions.add(pending.id + ":callback"); continue;
          }
          if (request.kind === "recovery" && !recoverySelections.has(pending.id) && request.choices.every(choice => actionScreen.includes(choice))) {
            snapshot(snapshots.some(snapshot => snapshot.label === "recovery-prompt") ? "recovery-prompt-" + recoverySelections.size : "recovery-prompt");
            if (!wantedChoice) {
              stopHost(events, "Close host with the actual recovery choice unanswered"); break;
            } else {
              const index = request.choices.findIndex(choice => choice.toLowerCase().split(/[ :]/)[0] === wantedChoice);
              assert.ok(index >= 0, "Requested recovery choice " + wantedChoice + " is absent from the actual TUI: " + request.choices.join(", "));
              send("\u001b[B".repeat(index) + "\r", "Select actual recovery choice " + wantedChoice); recoverySelections.add(pending.id);
            }
          } else if ((request.kind === "approval" && /Supership (?:tool|initial-plan|material-amendment|safety|push|fast-path|recovery)/.test(actionScreen) || request.kind === "recovery" && wantedChoice && recoverySelections.has(pending.id) && actionScreen.replace(/[\s│]/g, "").includes(`"kind":"${wantedChoice}"`)) && /Yes/.test(actionScreen) && /No/.test(actionScreen)) {
            const decline = /safety|push/.test(request.approvalKind ?? request.id) || scenario.initialSafety && request.id === "initial-plan";
            appendFileSync(join(root, "tui-prompts.jsonl"), JSON.stringify({ time: Date.now(), actionId: pending.id, requestId: request.id, screen: actionScreen }) + "\n");
            send(decline ? "\u001b[B\r" : "\r", "Respond to actual " + request.id + " confirmation"); decisions.add(pending.id);
          }
        }
        const latestParent = events.findLast(event => event.model === "acceptance-parent" && (event.event === "provider" || event.event === "provider-settled"));
        const settleMs = options.settleMs ?? (intervened ? (scenario.reportDelayMs ?? 0) + 500 : 300);
        const terminalContinue = sentContinue && current && ["completed", "cancelled"].includes(current.lifecycle) && Date.now() - lastControl >= settleMs;
        const parentStopped = latestParent?.event === "provider-settled" && latestParent.stopReason === "stop" && (latestParent.time >= lastControl || terminalContinue);
        if (parentStopped && Date.now() - latestParent.time >= settleMs && !sentExit) {
          if (current && !sentStatus) { send("/" + scenario.command + " status\r", "Inspect actual run status before host exit"); sentStatus = true; continue; }
          if (options.continueAfterBoundary && !sentContinue) { send("/" + scenario.command + " continue\r", "Continue through actual native control"); sentContinue = true; lastControl = Date.now(); continue; }
          send("\u0004", "Close actual host after provider settled"); sentExit = true;
        }
      }
      if (!exited && Date.now() >= deadline) {
        timedOut = true; snapshot("timeout"); stopHost(fixtureEvents(root), "Fixture deadline expired");
      }
      exitCode = await Promise.race([ended, Bun.sleep(5000).then(() => { throw new Error("Installed host did not exit: " + root); })]);
    } finally {
      if (!exited) child.kill("SIGTERM");
      terminal = chunks.join("");
      writeFileSync(join(root, "terminal.txt"), terminal);
    }
  }
  writeFileSync(join(root, "terminal.txt"), terminal);
  const state = stateNow(), events = fixtureEvents(root);
  snapshot("host-ended");
  assert.deepEqual(protectedPaths.map(path => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null), protectedHashes, "Real global settings changed");
  assert.ok(events.every(event => event.event !== "provider" || event.model?.startsWith("acceptance-")), `A nonfixture provider executed: ${root}`);
  const evidence = { root, cwd, slug, snapshots, state, events, terminal, exitCode, surface: tui ? "installed-tui" as const : "installed-print" as const };
  writeFileSync(join(root, "evidence.json"), JSON.stringify({ version, scenario, root, cwd, slug, statePath, resumeFrom: options.resume?.root, snapshots: snapshots.map(snapshot => snapshot.label), timedOut, surface: evidence.surface, exitCode, providerEvents: events.length, lifecycle: state?.lifecycle, phase: state?.phase, globalFilesUnchanged: true }, null, 2));
  assert.ok(!timedOut, "Installed OMP acceptance timed out: " + root);
  assert.ok(events.some(event => event.event === "registration" && event.commands?.includes(scenario.command)), `Actual /${scenario.command} command was not registered. Inspect ${root}/home/.omp/logs.`);
  assert.ifError(observationError);
  return evidence;
}

if (import.meta.main) {
  const scenario: Scenario = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
  const result = await runScenario(scenario, { tui: process.argv.includes("--tui") });
  console.log(JSON.stringify({ root: result.root, phase: result.state?.phase, lifecycle: result.state?.lifecycle, surface: result.surface }));
}
