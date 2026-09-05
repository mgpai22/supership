import { test } from "bun:test";
import assert from "node:assert/strict";
import { assertSchema, RunRecordSchema, type RunRecord } from "../src/contracts.ts";
import { renderDashboard, renderMarkdown } from "../src/dashboard.ts";

const digest = "a".repeat(64);
const now = 1_788_480_000_000;
const code = { head: "fixture-head", indexTree: "fixture-index", worktreeDigest: digest, scopeDigest: digest, parentEffectDigest: digest };
const available = { id: "baseline", kind: "artifact" as const, uri: "artifact://baseline", mediaType: "text/plain", summary: "Baseline captured", availability: "available" as const, digest };
const missing = { ...available, id: "missing-reproduction", uri: "artifact://expired", summary: "Reproduction artifact expired", availability: "unavailable" as const };

function fixture(): RunRecord {
  const assignment = {
    id: "build-ui", revision: 1, kind: "build" as const, dependencies: [], seatId: "builder", expectedPaths: ["src/view.ts"],
    expectedOutputs: ["Read-only status view"], verificationCheckIds: ["check-view"], mutation: "repository" as const,
    isolation: { kind: "worktree" as const, base: code }, toolGrants: [{ name: "inspect-parent", version: 1, approvalId: "approval-tool" }],
    outputSchema: { name: "build" as const, version: 1 as const }, instructions: "Render the current state without controls.", evidence: [available],
  };
  const state: RunRecord = {
    schemaVersion: 1, runId: "run-dashboard-fixture", slug: "dashboard-fixture", owner: { sessionId: "fixture-session", epoch: 2, leaseId: "fixture-lease" },
    repository: { root: "/fixture/repo", gitDir: "/fixture/repo/.git", commonDir: "/fixture/repo/.git", initialHead: "fixture-head", baselineRef: available, baselineDigest: digest },
    invocation: { command: "ultraship", mode: "interactive", topology: "duel", intent: "Read-only dashboard fixture", commitRequested: false, pushRequested: false },
    policy: { schemaVersion: 1, seats: [], namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], phaseGates: [], pathRouting: [], instructionRefs: [] },
    phase: "review", lifecycle: "paused", planRevision: 1, eventSequence: 12, lastEventHash: digest, createdAt: now - 60_000, updatedAt: now,
    seats: [{ seatId: "builder", baseAgent: "task", alias: "fixture-builder", resolvedModel: "fixture/model", fallbackSeatIds: [], bindingGeneration: 1,
      source: { agentName: "task", kind: "bundled", path: "fixture/task.md", contentHash: digest, bodyHash: digest, metadataHash: digest } }],
    limits: { concurrency: 2, tokens: 10_000, cost: { amount: 4, currency: "USD" }, wallMs: 300_000, reviewRounds: 3 },
    usage: { tokens: 12_000, cost: { amount: null, pricedSubtotal: 0, currency: "USD", unpricedModels: ["fixture/model"] }, startedAt: now - 60_000, observedAt: now,
      activeOwners: 1, ompConcurrencyCeiling: 4, overshoot: { tokens: 2_000, cost: null, wallMs: 0 } },
    usageSources: [{ id: "fixture-display", complete: true, tokens: 12_000, costAmount: null, model: "fixture/model", observedAt: now }],
    usageCoverage: [],
    plan: { schemaVersion: 1, revision: 1, title: "A read-only run dashboard", objective: "Show decisions without granting approvals.",
      scope: { included: ["Generated HTML"], excluded: ["Approval endpoints"], paths: ["src/view.ts"], effects: ["Repository writes"], publicContracts: ["Read-only rendering"], dependencies: [] },
      evidence: [available], items: [assignment], risks: [{ id: "html-injection", kind: "security", description: "Model text must stay inert.", paths: ["src/view.ts"], requiredLenses: ["security"], verificationCheckIds: ["check-view"], evidence: [available] }],
      requiredLenses: ["correctness", "simplicity", "security"], verificationChecks: [{ id: "check-view", description: "Open the generated view", scenario: { kind: "structured", name: "Dashboard smoke", steps: ["Load file", "Inspect read-only state"], operations: [{ kind: "browser-open", name: "dashboard", url: "file:///fixture/repo/plan.html" }, { kind: "browser-assert-text", name: "dashboard", text: "Read-only dashboard" }, { kind: "browser-screenshot", name: "dashboard" }, { kind: "browser-close", name: "dashboard" }] }, scopePaths: ["src/view.ts"], required: true, source: [available] }], commitGroups: [], toolProposals: [] },
    work: [{ schemaVersion: 1, ...assignment, status: "awaiting-recovery", attempt: { id: "attempt-one", number: 1, validationStage: "initial", seatId: "builder" }, runtimeOwners: [] }],
    actions: [], tools: [{ schemaVersion: 1, name: "inspect-parent", description: "Read parent metadata", purpose: "Show callback access", sourceRef: { ...available, id: "tool-source" }, sourceHash: digest,
      parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }, schemaHash: digest, initialization: [],
      effects: { kind: "read-only", paths: [], description: "Read parent state" }, intendedUsers: ["builder"], recreation: "recreatable", version: 1,
      grants: [{ workId: "build-ui", workRevision: 1, seatId: "builder" }], approvalId: "approval-tool", approvalScopeHash: digest,
      parent: { cwd: "/fixture/repo", sessionId: "fixture-session", ownerEpoch: 2 }, kernelGeneration: 1, registration: "unavailable", evidence: [available] }],
    approvals: [{ id: "approval-tool", kind: "tool", decision: "approve", authority: "omp-tui", scopeHash: digest, planRevision: 1,
      toolVersions: [{ name: "inspect-parent", version: 1 }], ownerEpoch: 2, createdAt: now - 30_000, rationale: "Approved only for this work item.", evidence: [available] }],
    findings: [{ schemaVersion: 1, id: "finding-html", fingerprint: digest, lens: "security", location: { path: "src/view.ts", startLine: 12 }, condition: "Untrusted content reaches the view",
      claim: "The view must preserve literal text.", impact: "Script execution could change the page.", severity: "high", evidence: [missing],
      fixTarget: { path: "src/view.ts", description: "Escape every data field" }, verdicts: [{ judgeId: "judge-a", round: 1, verdict: "accepted", reason: "Reproduction required", evidence: [missing] }] }],
    reviewRounds: [{ round: 1, startedAt: now - 20_000, completedAt: now - 10_000, codeIdentity: code, lenses: ["security"], reviewerOwners: [], judgeOwners: [], priorEvidencePacket: available,
      unresolvedFingerprints: [digest], relevantCodeDigest: digest, verdictEvidence: [missing] }],
    verification: [{ schemaVersion: 1, id: "verification-one", checkId: "check-view", scenario: { kind: "command", command: ["bun", "run", "smoke"], cwd: "/fixture/repo" }, codeIdentity: code,
      scopePaths: ["src/view.ts"], startedAt: now - 10_000, endedAt: now - 9_000, outcome: "unavailable", evidence: [missing], verifier: { kind: "runtime", id: "fixture-check" }, actionId: "verify-action" }],
    instructions: [], evidence: [available], kernelGeneration: 2, inputReceipts: [], receiptDigests: [], patches: [], pools: [], toolInvocations: [], worktrees: [], gitOutcomes: [],
    recovery: { scope: "items", intent: "resume", primaryReason: "Kernel generation changed", triggers: ["tool-unavailable", "unpriced-model"], affectedWork: [{ id: "build-ui", revision: 1 }],
      unresolvedOwners: [], resumePhase: "review", requiredChoices: ["Recreate the approved tool in OMP"], evidence: [missing] },
  };
  assertSchema(RunRecordSchema, state);
  return state;
}

async function inspect(markup: string) {
  const unsafe: string[] = [];
  const refresh: string[] = [];
  const text: string[] = [];
  const forbidden = new Set(["script", "iframe", "object", "embed", "img", "svg", "math", "form", "input", "button", "a", "link", "base", "audio", "video"]);
  await new HTMLRewriter().on("*", { element(element) {
    if (forbidden.has(element.tagName)) unsafe.push(element.tagName);
    for (const [name] of element.attributes) if (/^on|^(?:href|src|srcdoc|action|formaction)$/i.test(name)) unsafe.push(name);
    if (element.tagName === "meta" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh") refresh.push(element.getAttribute("content")!);
  } }).on("body", { text(chunk) { text.push(chunk.text); } }).transform(new Response(markup)).text();
  return { unsafe, refresh, text: text.join("") };
}

test("HTML parser sees model markup and tool schemas only as text, without active elements or URLs", async () => {
  const state = fixture();
  const payload = '</h1><script>globalThis.dashboardCompromised = true</script><img src=x onerror="alert(1)"><svg onload="alert(2)">';
  state.plan!.title = payload;
  state.plan!.objective = '<!-- --><iframe srcdoc="<script>alert(3)</script>"></iframe>';
  state.work[0]!.instructions = payload;
  state.seats[0]!.resolvedModel = payload;
  state.approvals[0]!.rationale = payload;
  state.findings[0]!.claim = payload;
  state.tools[0]!.parameters = { type: "object", properties: { [payload]: { type: "string", description: "</pre><script>alert(4)</script>" } } };
  state.tools[0]!.sourceRef = { ...available, uri: "javascript:alert(5)", summary: payload };
  state.plan!.toolProposals = [{ schemaVersion: 1, name: "pending-proposal", purpose: "Pending proposal sentinel", description: payload,
    sourceRef: state.tools[0]!.sourceRef, sourceHash: digest, schemaHash: digest, parameters: { description: payload }, initialization: [],
    effects: { kind: "unknown", paths: [], description: payload }, intendedUsers: ["builder"], recreation: "requires-reproposal" }];
  assertSchema(RunRecordSchema, state);
  const before = JSON.stringify(state);
  const rendered = renderDashboard(state, [{ code: "diagnostic", message: payload, severity: "error", evidence: [missing] }]);
  const parsed = await inspect(rendered);
  assert.deepEqual(parsed.unsafe, []);
  assert.ok(parsed.text.includes("globalThis.dashboardCompromised"));
  assert.ok(parsed.text.includes("Pending proposal sentinel"));
  assert.ok(rendered.includes("&lt;script&gt;globalThis.dashboardCompromised"));
  assert.equal(JSON.stringify(state), before, "Rendering must not mutate persisted state");
});

test("only active and cancelling lifecycle states refresh the same file", async () => {
  const state = fixture();
  for (const lifecycle of ["active", "cancelling", "paused", "blocked", "cancelled", "completed"] as const) {
    state.lifecycle = lifecycle;
    const result = await inspect(renderDashboard(state));
    if (lifecycle === "active" || lifecycle === "cancelling") {
      assert.equal(result.refresh.length, 1);
      assert.match(result.refresh[0]!, /^\d+$/, "Refresh must not redirect to a data-supplied URL");
    } else assert.deepEqual(result.refresh, []);
  }
});

test("unknown pricing never becomes zero; absent caps differ from explicit zero caps", async () => {
  const state = fixture();
  state.limits = { tokens: 0, cost: { amount: 0, currency: "USD" }, wallMs: 0 };
  state.usage.cost = { amount: 0, pricedSubtotal: 0, currency: "USD", unpricedModels: ["unpriced-fixture"] };
  const values: string[] = [];
  await new HTMLRewriter().on("#limits dd", { element() { values.push(""); }, text(chunk) { values[values.length - 1] += chunk.text; } })
    .transform(new Response(renderDashboard(state))).text();
  assert.ok(values.some(value => /unknown/i.test(value) && value.includes("USD")));
  assert.ok(values.some(value => value === "0 USD"), "An explicit zero cost cap must remain visible");
  assert.ok(values.some(value => value.includes("unpriced-fixture")));
  assert.ok(values.some(value => /unlimited/i.test(value)), "An omitted review cap must remain unlimited");
  assert.ok(values.some(value => value.includes("cap 0")), "An explicit zero cap must not inherit the unlimited default");
});

test("saturated token and cost aggregates are shown as lower bounds", async () => {
  const state = fixture();
  state.usage.tokens = Number.MAX_SAFE_INTEGER; state.usage.overshoot.tokens = Number.MAX_SAFE_INTEGER - state.limits.tokens!;
  state.usage.cost = { amount: null, pricedSubtotal: Number.MAX_VALUE, currency: "USD", unpricedModels: ["fixture/model"] };
  const render = async () => {
    const values: string[] = [];
    await new HTMLRewriter().on("#limits dd", { element() { values.push(""); }, text(chunk) { values[values.length - 1] += chunk.text; } }).transform(new Response(renderDashboard(state))).text();
    return values;
  };
  const unpriced = await render();
  assert.ok(unpriced.some(value => value.startsWith(`at least ${Number.MAX_SAFE_INTEGER} (aggregate saturated) observed`) && value.includes(`overshoot ${Number.MAX_SAFE_INTEGER - 10_000}`)), unpriced.join("\n"));
  assert.ok(unpriced.some(value => value.startsWith("Unknown (USD)") && value.includes(`at least ${Number.MAX_VALUE} (aggregate saturated)`)), unpriced.join("\n"));
  state.usage.cost = { amount: Number.MAX_VALUE, pricedSubtotal: Number.MAX_VALUE, currency: "USD", unpricedModels: [] }; state.usage.overshoot.cost = Number.MAX_VALUE;
  const priced = await render();
  assert.ok(priced.some(value => value === `at least ${Number.MAX_VALUE} (aggregate saturated) USD`), priced.join("\n"));
  assert.ok(priced.some(value => value === `${Number.MAX_VALUE} USD observed minimum`), "A saturated priced overshoot is an observed minimum, not an exact figure");
});

test("Markdown export selects summaries, redacts apparent secrets, and preserves unresolved evidence without active markup", async () => {
  const state = fixture();
  const secrets = ["fake-secret-value", "fake-bearer-value", "fake-user-password", "fake query token", "fake-cookie-session", `sk-${"x".repeat(24)}`, `ghp_${"y".repeat(24)}`, "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "fake-private-material"];
  state.plan!.objective = `Plan summary\napi_key="${secrets[0]}"\nAuthorization: Bearer ${secrets[1]}\nhttps://user:${secrets[2]}@example.invalid\nhttps://example.invalid?token="${secrets[3]}"\nCookie: sid=${secrets[4]}; other=also-private\n${secrets.slice(5, 9).join("\n")}\n-----BEGIN PRIVATE KEY-----\n${secrets[9]}\n-----END PRIVATE KEY-----`;
  state.plan!.objective += '\nVerification command: "--token" "fake-command-token" --password fake-command-password';
  state.approvals[0]!.rationale = "Decision summary";
  state.findings[0]!.claim = "Finding summary";
  state.verification[0]!.scenario = { kind: "structured", name: "Verification summary", steps: ["A deterministic check"], operations: [{ kind: "command", command: ["bun", "run", "smoke"], cwd: "/fixture/repo" }] };
  state.instructions = [{ id: "user-instruction", receivedAt: now, textRef: { ...available, uri: "history://never-fetch-full-transcript", summary: "Instruction reference" }, summary: "Instruction summary", affectedWork: [], classification: "ordinary", status: "applied", evidence: [] }];
  const markup = '</pre>\r\n<script>alert(1)</script>\n\n```\n<img src=x onerror=alert(2)>\n```\n[approve](javascript:alert(3))\n\u2028<form action=/approve>';
  state.plan!.title = markup;
  state.tools[0]!.parameters = { description: "FULL-TOOL-SOURCE-SENTINEL" };
  state.work[0]!.result = { schemaVersion: 1, kind: "research", workId: "build-ui", workRevision: 1, attemptId: "attempt-one", answers: [{ question: "Transcript?", answer: "FULL-TRANSCRIPT-SENTINEL", citations: [] }], gaps: [], proposedPaths: [] };
  const exported = renderMarkdown(state);
  for (const secret of [...secrets, "also-private", "fake-command-token", "fake-command-password"]) assert.ok(!exported.includes(secret), "Apparent credential leaked from the export");
  for (const text of ["Plan summary", "Decision summary", "Finding summary", "Verification summary", "Instruction summary", missing.id, "unavailable"])
    assert.ok(exported.includes(text), `Export dropped ${text}`);
  assert.ok(!exported.includes("FULL-TRANSCRIPT-SENTINEL"));
  assert.ok(!exported.includes("FULL-TOOL-SOURCE-SENTINEL"));
  const rendered = Bun.markdown.html(exported);
  assert.deepEqual((await inspect(rendered)).unsafe, []);
  assert.ok(rendered.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});
