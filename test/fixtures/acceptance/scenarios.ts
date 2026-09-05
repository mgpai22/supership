import { canonicalJson, type InstructionRecord, type Limits, type PlanRecord, type PolicyOverlay, type ToolProposal, type WorkAssignment, type WorkContext } from "../../../src/contracts.ts";
import { pathsOverlap } from "../../../src/engine.ts";

export const commands = ["supership", "shipit", "ultraship", "ultrashipit", "superreview"] as const;
export type Command = typeof commands[number];
export interface BuildStep {
  id: string;
  path: string;
  content: string;
  initialContent?: string;
  dependencies?: string[];
  isolated?: boolean;
  delayMs?: number;
  tool?: string;
  before?: { path: string; content: string };
}
export interface Scenario {
  id: string;
  command: Command;
  topology?: "normal" | "crossreview" | "duel" | "debate";
  builds: BuildStep[];
  findings?: string[][];
  fixChanges?: boolean;
  disagree?: boolean;
  invalid?: { work: string; stages: number };
  amendment?: "ordinary" | "material" | "safety";
  reviewRounds?: number;
  concurrency?: number;
  ompConcurrency?: number;
  push?: boolean;
  /** Keep the superreview user hunk uncommitted even when publishing, so the repair overlaps user-owned bytes. */
  dirtyBaseline?: boolean;
  noChange?: boolean;
  stopAfter?: string;
  dynamic?: boolean;
  reportDelayMs?: number;
  /** The single proposed callback also writes an undeclared parent path, so its invocation settles as uncertain and needs a trusted disposition. */
  uncertainCallback?: boolean;
  /** Planning outputs wait this long before yielding so spawn latency cannot hide serialized blind seats. */
  planningDelayMs?: number;
  /** Keep an actual reviewer response open long enough to cancel its native WorkPool. */
  reviewDelayMs?: number;
  initialSafety?: boolean;
  fastPath?: boolean;
  securityRisk?: boolean;
  limits?: Limits;
  reportUsage?: "priced" | "unpriced";
  recursiveProposal?: boolean;
}
export interface Packet {
  assignment: WorkAssignment;
  work: { id: string; revision: number; attemptId: string };
  parentAccess?: string;
  logicalId?: string;
  workspace?: { marker: string; path: string; grantName: string; manifestDigest: string; workId: string; workRevision: number; attemptId: string };
}

// Parse only a complete assignment JSON value, never prose as structured output.
export function packetFrom(text: string): Packet | undefined {
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

export function planFor(scenario: Scenario, packet: Packet, cwd: string, base: Extract<WorkContext, { kind: "review" }>["codeIdentity"], prior?: PlanRecord): PlanRecord {
  const { requiredPlanRevision: revision, sharedPacket } = JSON.parse(packet.assignment.instructions) as { requiredPlanRevision: number; sharedPacket: { policy: PolicyOverlay; instructions: InstructionRecord[] } };
  const paths = [...new Set(["baseline.txt", ...scenario.builds.map(step => step.path), ...(scenario.dynamic ? ["parent-effect.txt"] : []), ...(scenario.initialSafety ? ["destructive-target.txt"] : [])])];
  const checks = (scenario.builds.length ? scenario.builds : [{ id: "baseline", path: "baseline.txt", content: scenario.fixChanges ? "user baseline\nreview target repaired\n" : "user baseline\n" }]).map(step => ({
    id: `check-${step.id}`, description: `Read the integrated ${step.path} bytes`,
    scenario: { kind: "command" as const, cwd, command: ["bun", "-e", `const text=await Bun.file(${JSON.stringify(step.path)}).text(); if(text!==${JSON.stringify(step.content)}) throw new Error("Integrated fixture bytes differ")`] },
    scopePaths: [step.path], required: true, source: [],
  }));
  return {
    schemaVersion: 1, revision, title: `Offline ${scenario.id}`, objective: "Execute the declared offline product acceptance scenario",
    scope: { included: [scenario.id, "in-scope repair"], excluded: ["network", "real publication"], paths, effects: ["write fixture files", "repair fixture files", ...(scenario.initialSafety ? ["delete destructive-target.txt"] : [])], dependencies: [], publicContracts: [] },
    evidence: packet.assignment.evidence,
    items: revisedItems(scenario, prior, revision, sharedPacket.instructions, base),
    risks: scenario.securityRisk ? [{ id: "fixture-security", kind: "security", description: "Review fixture security boundary", paths: ["baseline.txt"], requiredLenses: ["security"], verificationCheckIds: [], evidence: [] }] : [], requiredLenses: [...new Set(["correctness", "simplicity", ...sharedPacket.policy.requiredLenses])], verificationChecks: [...checks, ...sharedPacket.policy.verificationChecks.filter(check => !check.scopePaths.length || check.scopePaths.some(scope => paths.some(path => pathsOverlap(scope, path))))],
    commitGroups: scenario.builds.map(step => ({ id: `group-${step.id}`, title: `test: write ${step.path}`, workIds: [step.id], paths: [step.path], dependencies: (step.dependencies ?? []).map(id => `group-${id}`) })),
    toolProposals: [], ...(scenario.fastPath ? { fastPath: { workerId: scenario.builds[0]!.id, reason: "One independent fixture change needs one builder" } } : {}), ...(scenario.builds.length ? {} : { noChangeReason: "The fixture requests inspection without a code change." }),
  };
}

// A replan advances only steered items and items whose declared work changed (transitively through dependencies).
// Unchanged items are returned verbatim from the prior plan, so their revision and live work survive; a moved worktree base alone is not a change.
function revisedItems(scenario: Scenario, prior: PlanRecord | undefined, revision: number, instructions: InstructionRecord[], base: Extract<WorkContext, { kind: "review" }>["codeIdentity"]): PlanRecord["items"] {
  const steering: Record<string, string[]> = {};
  for (const instruction of instructions) for (const ref of instruction.affectedWork) (steering[ref.id] ??= []).push(instruction.summary);
  const declared: PlanRecord["items"] = scenario.builds.map(step => ({
    id: step.id, revision, kind: "build" as const, dependencies: (step.dependencies ?? []).map(id => ({ id, revision })),
    seatId: "builder", expectedPaths: [step.path], expectedOutputs: [step.content], verificationCheckIds: [`check-${step.id}`],
    mutation: "repository" as const, isolation: step.isolated ? { kind: "worktree" as const, base } : { kind: "active-checkout" as const },
    toolGrants: [], outputSchema: { name: "build" as const, version: 1 }, instructions: "ACCEPTANCE_BUILD " + JSON.stringify(step) + (steering[step.id] ?? []).map(summary => `\nApply the user instruction: ${summary}`).join(""), evidence: [],
  }));
  const previousOf = (id: string) => prior?.items.find(item => item.id === id);
  const changed = new Set(declared.filter(item => {
    const previous = previousOf(item.id);
    return !previous || steering[item.id] || canonicalJson({ ...item, revision: 0, dependencies: item.dependencies.map(ref => ref.id), isolation: previous.isolation }) !== canonicalJson({ ...previous, revision: 0, dependencies: previous.dependencies.map(ref => ref.id) });
  }).map(item => item.id));
  for (let expanded = true; expanded;) { expanded = false; for (const item of declared) if (!changed.has(item.id) && item.dependencies.some(ref => changed.has(ref.id))) { changed.add(item.id); expanded = true; } }
  return declared.map(item => changed.has(item.id) ? { ...item, dependencies: item.dependencies.map(ref => changed.has(ref.id) ? ref : { id: ref.id, revision: previousOf(ref.id)!.revision }) } : previousOf(item.id)!);
}

export const topologyScenarios: Scenario[] = ["normal", "crossreview", "duel", "debate"].map(topology => ({ id: `topology-${topology}`, command: topology === "normal" ? "shipit" : "ultrashipit", topology: topology as Scenario["topology"], builds: [], noChange: true, planningDelayMs: 1500 }));
export const commandScenarios: Scenario[] = commands.map(command => ({ id: `row-${command}`, command, builds: command === "superreview" ? [] : [{ id: "initial", path: "result.txt", content: "repaired result\n", initialContent: "initial result\n" }], findings: [["repair"], []], fixChanges: true }));
export const reviewScenarios: Scenario[] = [
  { id: "unlimited-convergence", command: "shipit", builds: [], findings: [["first"], ["second"], ["third"], []] },
  { id: "two-round-stall", command: "shipit", builds: [], findings: [["same"], ["same"]] },
  { id: "stall-and-cap", command: "shipit", builds: [], findings: [["same"], ["same"]], reviewRounds: 2 },
  { id: "review-round-cap", command: "shipit", builds: [], findings: [["same"]], reviewRounds: 1 },
  { id: "relevant-progress-resets-stall", command: "shipit", builds: [], findings: [["same"], ["same"], ["same"]], fixChanges: true },
  { id: "changed-set-resets-stall", command: "shipit", builds: [], findings: [["old"], ["new"], ["new"]] },
  { id: "judge-disagreement", command: "ultrashipit", builds: [], findings: [["disputed"]], disagree: true },
];
export const mixedScenario: Scenario = {
  id: "mixed-scheduler", command: "shipit", concurrency: 2, ompConcurrency: 3, findings: [["mixed-repair"], []], fixChanges: true,
  builds: [
    { id: "independent-a", path: "a.txt", content: "a\n", isolated: true, delayMs: 180 },
    { id: "overlap-a", path: "a.txt", content: "a\n", isolated: true, delayMs: 180 },
    { id: "independent-b", path: "b.txt", content: "b\n", isolated: true, delayMs: 180 },
    { id: "independent-c", path: "c.txt", content: "c\n", isolated: true, delayMs: 180 },
    { id: "dependent", path: "a.txt", content: "a\n", dependencies: ["independent-a"], before: { path: "a.txt", content: "a\n" } },
  ],
};


/** `undeclaredPath` makes the callback also write a parent path outside its declared effects through raw parent-kernel I/O reached around the policy-only source check (the bridge refuses undeclared paths; raw I/O is the documented non-sandbox limit), so its invocation settles as uncertain. */
export function dynamicProposal(version: number, undeclaredPath?: string): ToolProposal {
  const undeclared = undeclaredPath ? ` await globalThis["B"+"un"].write(${JSON.stringify(undeclaredPath)}, "undeclared\\n");` : "";
  return {
    schemaVersion: 1, name: "acceptance_mosaic", description: "Compute a fixture value and write its parent record",
    purpose: "Prove an arbitrary proposed function with separately attributed parent effects",
    source: `async function(args) { const value=args.value*${version === 1 ? 2 : 3}+7; const result=await tool.write({path:"parent-effect.txt",content:String(value)+"\\n"}); if(result.hasError || result.isError || result.details?.isError) throw new Error("Parent record write failed");${undeclared} return value; }`,
    parameters: { type: "object", properties: { value: { type: "number" }, ...(version >= 3 ? { label: { type: "string" } } : {}) }, required: ["value", ...(version >= 3 ? ["label"] : [])], additionalProperties: false },
    initialization: [], effects: { kind: "parent-access", paths: ["parent-effect.txt"], description: "Write a single parent checkout fixture record through the OMP write bridge" },
    intendedUsers: ["builder"], recreation: "recreatable",
  };
}
export const dynamicScenarios: Scenario[] = ["shipit", "supership"].map(command => ({
  id: `dynamic-${command}`, command: command as Command, dynamic: true,
  builds: [
    { id: "granted-a", path: "child-a.txt", content: "a\n", isolated: true, tool: "acceptance_mosaic" },
    { id: "granted-b", path: "child-b.txt", content: "b\n", isolated: true, tool: "acceptance_mosaic" },
    { id: "ungranted", path: "ungranted.txt", content: "ungranted\n", isolated: true },
  ],
}));

export function amendedPlan(plan: PlanRecord, kind: NonNullable<Scenario["amendment"]>, cwd: string): PlanRecord {
  const next = structuredClone(plan);
  next.revision++;
  next.title += " revised";
  if (kind === "ordinary") {
    if (next.items[0]) { next.items[0].revision++; next.items[0].instructions += "\nUse the existing approved execution details."; }
    return next;
  }
  if (kind === "safety") { next.scope.effects.push("delete destructive-target.txt"); return next; }
  next.scope.paths.push("added.txt"); next.scope.dependencies.push("new-fixture-dependency");
  if (!next.items.length) next.items.push({ id: "review-evidence", revision: next.revision, kind: "research", seatId: "scout", dependencies: [], expectedPaths: ["baseline.txt"], expectedOutputs: ["cited baseline"], verificationCheckIds: [], mutation: "read-only", isolation: { kind: "active-checkout" }, toolGrants: [], outputSchema: { name: "research", version: 1 }, instructions: "Inspect baseline.txt through the native read tool", evidence: [] });
  const initial = next.items[0]!;
  next.items.push({ ...structuredClone(initial), id: "added", kind: "build", seatId: "builder", mutation: "repository", outputSchema: { name: "build", version: 1 }, revision: next.revision, dependencies: [{ id: initial.id, revision: initial.revision }], expectedPaths: ["added.txt"], expectedOutputs: ["added\n"], verificationCheckIds: ["check-added"], instructions: "ACCEPTANCE_BUILD " + JSON.stringify({ id: "added", path: "added.txt", content: "added\n" }) });
  next.verificationChecks.push({ id: "check-added", description: "Read actual added output", scenario: { kind: "command", cwd, command: ["bun", "-e", 'if(await Bun.file("added.txt").text()!=="added\\n") throw new Error("Missing added output")'] }, scopePaths: ["added.txt"], required: true, source: [] });
  next.commitGroups.push({ id: "group-added", title: "test: add declared dependency output", workIds: ["added"], paths: ["added.txt"], dependencies: next.commitGroups[0] ? [next.commitGroups[0].id] : [] });
  return next;
}

export const amendmentScenarios: Scenario[] = commands.flatMap(command => (["ordinary", "material", "safety"] as const).map(amendment => ({
  id: `${command}-${amendment}`, command, amendment, builds: command === "superreview" ? [] : [{ id: "initial", path: "result.txt", content: "initial result\n" }], ...(command === "superreview" ? { findings: [["repair"], []], fixChanges: true } : {}),
})));