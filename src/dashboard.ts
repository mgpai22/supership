import type { CapturedToolProposal, Diagnostic, EvidenceRef, RunRecord, Scenario } from "./contracts.ts";
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function redact(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(^|\n)([ \t]*(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, "$1$2[REDACTED]")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_.=-]+/gi, "$1[REDACTED]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:^|\s)["']?--(?:[\w.-]*[_-])?(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|password|passwd|token|private[_-]?key)["']?(?:\s+|=))(?:(?:"[^"\r\n]*")|(?:'[^'\r\n]*')|[^\s,;&<>]+)/gi, "$1[REDACTED]")
    .replace(/((?:["']?\b(?:[\w.-]*[_-])?(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|password|passwd|token|authorization|cookie|set-cookie)\b["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&<>]+)/gi, "$1[REDACTED]");
}

function html(value: string | number): string {
  return redact(String(value)).replace(/[&<>"']/g, char => entities[char]!);
}

function timestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `${value} ms since epoch (outside calendar range)` : date.toISOString();
}

function scenario(value: Scenario): string {
  return value.kind === "command" ? `${value.command.map(arg => JSON.stringify(arg)).join(" ")}\nDirectory: ${value.cwd}` : `${value.name}\n${value.steps.join("\n")}`;
}

function evidenceRefs(state: RunRecord, diagnostics: Diagnostic[] = []): EvidenceRef[] {
  const refs = new Map<string, EvidenceRef>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.uri === "string" && typeof record.summary === "string" && typeof record.id === "string"
      && ["artifact", "history", "file"].includes(String(record.kind))
      && ["available", "unavailable", "unverified"].includes(String(record.availability))) {
      const ref = record as EvidenceRef;
      refs.set(JSON.stringify([ref.id, ref.uri, ref.digest, ref.availability, ref.summary]), ref);
      return;
    }
    // Schema documents describe data. They are not evidence records.
    for (const [key, child] of Object.entries(record)) if (key !== "parameters") visit(child);
  };
  visit(state);
  visit(diagnostics);
  return [...refs.values()];
}

function evidenceText(ref: EvidenceRef): string {
  return `${ref.id}: ${ref.availability}\n${ref.summary}\n${ref.kind}: ${ref.uri}\nDigest: ${ref.digest ?? "not recorded"}`;
}

function list(values: string[]): string {
  return values.length ? `<ul>${values.map(value => `<li>${html(value)}</li>`).join("")}</ul>` : '<p class="empty">None recorded.</p>';
}

function fields(values: [string, string | number][]): string {
  return `<dl>${values.map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join("")}</dl>`;
}

function section(id: string, title: string, content: string): string {
  return `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${title}</h2>${content}</section>`;
}

function cards(values: string[]): string {
  return values.length ? `<div class="grid">${values.map(value => `<article class="card">${value}</article>`).join("")}</div>` : '<p class="empty">None recorded.</p>';
}

function proposalDetails(tool: CapturedToolProposal): string {
  return fields([
    ["Purpose", tool.purpose], ["Description", tool.description], ["Effects", `${tool.effects.kind}: ${tool.effects.description}\n${tool.effects.paths.join("\n")}`],
    ["Intended users", tool.intendedUsers.join(", ")], ["Source hash", tool.sourceHash], ["Schema hash", tool.schemaHash],
    ["Source reference", evidenceText(tool.sourceRef)], ["Recreation", tool.recreation],
    ["Initialization", tool.initialization.map(input => `${input.name}: ${input.ref.id} (${input.ref.availability})`).join("\n") || "None"],
  ]) + `<details><summary>Parameter schema (inert data)</summary><pre>${html(JSON.stringify(tool.parameters, null, 2))}</pre></details>`;
}

function blockers(state: RunRecord, diagnostics: Diagnostic[]): string[] {
  return [
    ...(state.recovery ? [state.recovery.primaryReason, ...state.recovery.triggers,
      ...state.recovery.requiredChoices.map(choice => `Choice required in OMP: ${choice}`),
      ...state.recovery.unresolvedOwners.map(owner => `Unresolved owner ${owner.id}: ${owner.status}`)] : []),
    ...(state.runtime?.unknownOwners.map(owner => `Unconfirmed runtime owner ${owner.id}: ${owner.status}`) ?? []),
    ...state.actions.flatMap(action => action.status === "uncertain" ? [`Uncertain action ${action.id}: ${action.input.kind}`]
      : action.input.kind === "collect_input" && ["issued", "claimed", "running"].includes(action.status) ? [`Awaiting ${action.input.request.kind} in OMP: ${action.input.request.prompt}`] : []),
    ...diagnostics.filter(diagnostic => diagnostic.severity !== "info").map(diagnostic => `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`),
  ];
}

/** Pure presentation of persisted state. No file reads, source evaluation, or approval controls. */
export function renderDashboard(state: RunRecord, diagnostics: Diagnostic[] = []): string {
  const active = state.lifecycle === "active" || state.lifecycle === "cancelling";
  const refs = evidenceRefs(state, diagnostics);
  const plan = state.plan;
  const proposals = [...(plan?.toolProposals ?? []), ...state.work.flatMap(item => item.result?.kind === "build" ? item.result.proposedTools : [])];
  const { usage, limits } = state;
  const ompCeiling = state.runtime ? state.runtime.ompCeiling : usage.ompConcurrencyCeiling;
  const effectiveCeiling = Math.min(limits.concurrency ?? Infinity, ompCeiling ?? Infinity);
  const incompleteSources = [...state.usageSources.filter(source => !source.complete).map(source => source.id), ...state.usageCoverage.filter(coverage => coverage.status !== "complete").map(coverage => `${coverage.id}: ${coverage.reason}`)];
  const unknownPrice = usage.cost.amount === null || usage.cost.unpricedModels.length > 0, saturatedCost = usage.cost.pricedSubtotal === Number.MAX_VALUE;
  // A saturated aggregate is a lower bound: the engine caps totals at the representable maximum while every source stays canonical.
  const atLeast = (value: number, bound: number) => value === bound ? `at least ${value} (aggregate saturated)` : `${value}`;
  const cost = unknownPrice ? `Unknown (${usage.cost.currency}); recorded priced subtotal: ${atLeast(usage.cost.pricedSubtotal, Number.MAX_VALUE)}` : `${atLeast(usage.cost.amount!, Number.MAX_VALUE)} ${usage.cost.currency}`;
  const output = [
    section("blockers", "Blockers and recovery", list(blockers(state, diagnostics))),
    section("limits", "Usage and limits", fields([
      ["Active runtime owners", state.runtime?.activeOwners.length ?? usage.activeOwners],
      ["Concurrency ceiling", `${Number.isFinite(effectiveCeiling) ? effectiveCeiling : "unlimited"} effective; OMP ${ompCeiling ?? "unlimited"}; run ${limits.concurrency ?? "inherits OMP"}`],
      ["Tokens", `${atLeast(usage.tokens, Number.MAX_SAFE_INTEGER)} observed${incompleteSources.length && usage.tokens !== Number.MAX_SAFE_INTEGER ? " (lower bound)" : ""}; cap ${limits.tokens ?? "unlimited"}; overshoot ${usage.overshoot.tokens}`],
      ["Cost", cost], ["Unpriced models", usage.cost.unpricedModels.join(", ") || "None recorded"],
      ["Cost cap", limits.cost ? `${limits.cost.amount} ${limits.cost.currency}` : "Unlimited"],
      ["Cost overshoot", usage.overshoot.cost === null ? "Unknown" : `${usage.overshoot.cost} ${usage.cost.currency}${unknownPrice || saturatedCost ? " observed minimum" : ""}`],
      ["Elapsed time", `${Math.max(0, usage.observedAt - usage.startedAt)} ms; cap ${limits.wallMs === undefined ? "unlimited" : `${limits.wallMs} ms`}; overshoot ${usage.overshoot.wallMs} ms`],
      ["Review rounds", `${state.reviewRounds.length}; cap ${limits.reviewRounds ?? "unlimited"}`],
      ["Incomplete usage sources", incompleteSources.join("\n") || "None recorded"],
      ["Usage observed", timestamp(usage.observedAt)],
    ]) + '<p class="dim">Limits apply at observable boundaries. Provider calls can overshoot; these are not hard billing ceilings.</p>'),
    section("plan", "Plan", plan ? `<h3>${html(plan.title)}</h3><p class="text">${html(plan.objective)}</p>${fields([
      ["Included", plan.scope.included.join("\n")], ["Excluded", plan.scope.excluded.join("\n")], ["Paths", plan.scope.paths.join("\n")],
      ["Effects", plan.scope.effects.join("\n")], ["Public contracts", plan.scope.publicContracts.join("\n")], ["Dependencies", plan.scope.dependencies.join("\n")],
      ["Required lenses", plan.requiredLenses.join(", ")],
    ])}${plan.fastPath ? `<p class="text">Single-worker fast path: ${html(plan.fastPath.reason)}</p>` : ""}${plan.noChangeReason ? `<p class="text">No change: ${html(plan.noChangeReason)}</p>` : ""}
    <h3>Planned work</h3>${list(plan.items.map(item => `${item.id} r${item.revision}: ${item.instructions}\nSeat: ${item.seatId}; paths: ${item.expectedPaths.join(", ")}`))}
    <h3>Risks</h3>${list(plan.risks.map(risk => `${risk.id} (${risk.kind}): ${risk.description}`))}` : '<p class="empty">No plan recorded.</p>'),
    section("work", "Work", cards(state.work.map(item => `<h3>${html(item.id)} <span class="pill">${html(item.status)}</span></h3>${fields([
      ["Kind / revision", `${item.kind} / ${item.revision}`], ["Seat / attempt", `${item.attempt.seatId} / ${item.attempt.number} (${item.attempt.validationStage})`],
      ["Dependencies", item.dependencies.map(dependency => `${dependency.id} r${dependency.revision}`).join(", ") || "None"],
      ["Paths", item.expectedPaths.join("\n")], ["Mutation", item.mutation],
      ["Isolation", item.isolation.kind === "worktree" && (item.mutation !== "read-only" || item.toolGrants.length) ? "worktree isolation with parent access" : item.isolation.kind],
      ["Code checkout", item.isolation.kind === "active-checkout" ? state.repository.root : state.worktrees.find(tree => tree.work.id === item.id && tree.work.revision === item.revision && tree.work.attemptId === item.attempt.id)?.path ?? "Not yet recorded"],
      ["Proposed-tool grants", item.toolGrants.map(grant => `${grant.name}@${grant.version}; approval ${grant.approvalId}`).join("\n") || "None"],
      ["Runtime owners", item.runtimeOwners.map(owner => `${owner.id}: ${owner.status}`).join("\n") || "None recorded"],
    ])}<p class="text">${html(item.instructions)}</p>${item.result && "summary" in item.result ? `<p class="text">${html(item.result.summary)}</p>` : ""}`))),
    section("seats", "Resolved seats", cards(state.seats.map(seat => fields([
      ["Seat", seat.seatId], ["Agent", seat.baseAgent], ["Alias", seat.alias], ["Model", seat.resolvedModel],
      ["Requested model", seat.requestedModel ?? "Inherited"], ["Fallback seats", seat.fallbackSeatIds.join(", ") || "None"],
    ])))),
    section("review", "Review rounds", cards(state.reviewRounds.map(round => fields([
      ["Round", round.round], ["Started", timestamp(round.startedAt)], ["Completed", round.completedAt === undefined ? "Not recorded" : timestamp(round.completedAt)],
      ["Lenses", round.lenses.join(", ")], ["Reviewers", round.reviewerOwners.map(owner => `${owner.id}: ${owner.status}`).join("\n")],
      ["Judges", round.judgeOwners.map(owner => `${owner.id}: ${owner.status}`).join("\n")],
      ["Unresolved fingerprints", round.unresolvedFingerprints.join("\n") || "None recorded"], ["Reviewed code", round.relevantCodeDigest],
    ])))),
    section("findings", "Findings and verdicts", cards(state.findings.map(finding => `<h3>${html(finding.id)} <span class="pill">${html(finding.severity)}</span></h3>${fields([
      ["Location", `${finding.location.path}${finding.location.startLine === undefined ? "" : `:${finding.location.startLine}`}`],
      ["Lens", finding.lens], ["Fingerprint", finding.fingerprint], ["Condition", finding.condition], ["Claim", finding.claim],
      ["Impact", finding.impact], ["Fix target", `${finding.fixTarget.path}: ${finding.fixTarget.description}`],
      ["Resolution", finding.resolution ? `${finding.resolution.kind}: ${finding.resolution.reason}` : "Unresolved"],
    ])}${list(finding.verdicts.map(verdict => `${verdict.judgeId}, round ${verdict.round}: ${verdict.verdict}. ${verdict.reason}${verdict.duplicateOf ? ` Duplicate of ${verdict.duplicateOf}.` : ""}`))}`))),
    section("verification", "Verification", `<h3>Planned checks</h3>${list(plan?.verificationChecks.map(check => `${check.id}${check.required ? " (required)" : " (optional)"}: ${check.description}\n${scenario(check.scenario)}`) ?? [])}${cards(state.verification.map(check => `<h3>${html(check.checkId)} <span class="pill">${html(check.outcome)}</span></h3><pre>${html(scenario(check.scenario))}</pre>${fields([
      ["Started", timestamp(check.startedAt)], ["Ended", timestamp(check.endedAt)], ["Exit code", check.exitCode ?? "Not recorded"],
      ["Verifier", `${check.verifier.kind}: ${check.verifier.id}`], ["Code identity", JSON.stringify(check.codeIdentity)],
      ["Evidence", check.evidence.map(ref => `${ref.id}: ${ref.availability}`).join("\n") || "No evidence recorded"],
    ])}`))}`),
    section("approvals", "Approvals and decisions", cards(state.approvals.map(approval => fields([
      ["Approval", approval.id], ["Kind / decision", `${approval.kind} / ${approval.decision}`], ["Authority", approval.authority],
      ["Scope hash", approval.scopeHash], ["Plan revision", approval.planRevision], ["Owner epoch", approval.ownerEpoch],
      ["Tool versions", approval.toolVersions.map(tool => `${tool.name}@${tool.version}`).join(", ") || "None"],
      ["Recorded", timestamp(approval.createdAt)], ["Rationale", approval.rationale],
    ]))) + list(state.instructions.map(instruction => `${timestamp(instruction.receivedAt)}: ${instruction.classification}, ${instruction.status}: ${instruction.summary}`))),
    section("tools", "Run-scoped tools", '<p class="banner">Granted callbacks run in the parent kernel. Worktree isolation with parent access is not a sandbox. Parent writes are separate from the child patch.</p>' + cards(state.tools.map(tool => `<h3>${html(tool.name)}@${html(tool.version)} <span class="pill">${html(tool.registration)}</span></h3>${fields([
      ["Grants", tool.grants.map(grant => {
        const work = state.work.find(item => item.id === grant.workId && item.revision === grant.workRevision);
        const access = work?.isolation.kind === "worktree" ? "worktree isolation with parent access" : "parent-kernel access";
        return `${grant.workId} r${grant.workRevision}; seat ${grant.seatId}; ${access}`;
      }).join("\n") || "None"],
      ["Approval / scope", `${tool.approvalId ?? "Not recorded"} / ${tool.approvalScopeHash}`],
      ["Parent", `${tool.parent.cwd}\n${tool.parent.sessionId}; epoch ${tool.parent.ownerEpoch}`], ["Kernel generation", tool.kernelGeneration],
    ])}${proposalDetails(tool)}`)) + `<h3>Recorded proposals (not registration or approval)</h3>${cards(proposals.map(tool => `<h3>${html(tool.name)}</h3>${proposalDetails(tool)}`))}`),
    section("evidence", "Evidence availability", '<p class="dim">Recorded availability only. References are inert text; this dashboard does not fetch artifacts, history, or source.</p>' + cards(refs.map(ref => `<pre>${html(evidenceText(ref))}</pre>`))),
    section("conclusion", "Conclusion and local lessons", state.conclusion ? `<p class="text">${html(state.conclusion.summary)}</p>${fields([
      ["Kind", state.conclusion.kind], ["Completed", timestamp(state.conclusion.completedAt)],
      ["Deferred findings", state.conclusion.unresolvedDeferredFindingIds.join(", ") || "None"],
    ])}${list(state.conclusion.lessons)}` : '<p class="empty">No conclusion recorded.</p>'),
  ].join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
${active ? '<meta http-equiv="refresh" content="10">' : ""}
<title>Supership: ${html(state.runId)}</title>
<style>
:root{color-scheme:dark;--bg:#0f1115;--panel:#171a21;--line:#343b49;--fg:#e6e9ef;--dim:#adb6c5;--accent:#94b5ff}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,sans-serif}main{max-width:1080px;margin:auto}h1{font-size:24px;margin:0}h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:30px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}h3{font-size:15px;margin:0 0 8px}.dim,.empty,dt{color:var(--dim)}.text,li,dd{white-space:pre-wrap;overflow-wrap:anywhere}.banner{border:1px solid #80672e;background:#2a2210;color:#fde293;border-radius:10px;padding:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px}.card{min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.pill{display:inline-block;padding:2px 9px;border:1px solid var(--line);border-radius:99px;font-size:12px;color:var(--accent)}dl{display:grid;grid-template-columns:minmax(110px,1fr) minmax(0,3fr);gap:6px 12px;margin:10px 0}dt,dd{margin:0}pre{font:12px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}summary{cursor:pointer}summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}ul{padding-left:22px}header .pill{margin:8px 8px 0 0}@media(max-width:520px){body{padding:14px}dl{grid-template-columns:1fr}dd{margin-bottom:8px}}
h1,h3{overflow-wrap:anywhere}
</style></head><body><main><header><h1>${html(plan?.title ?? state.invocation.intent)}</h1>
<p class="dim">Read-only dashboard. Use OMP for approvals, edits, and recovery. ${active ? "Reloads every 10 seconds while work remains active." : "Automatic refresh is off."}</p>
<span class="pill">${html(state.phase)}</span><span class="pill">${html(state.lifecycle)}</span><span class="pill">${html(state.invocation.mode)}</span><span class="pill">${html(state.invocation.topology)}</span>
${fields([["Run ID", state.runId], ["Slug", state.slug], ["Command", state.invocation.command], ["Owner", `${state.owner.sessionId}; epoch ${state.owner.epoch}`], ["Plan revision", state.planRevision], ["Event sequence", state.eventSequence], ["Created", timestamp(state.createdAt)], ["Last update", timestamp(state.updatedAt)]])}
</header>${output}</main></body></html>`;
}

// Indented blocks keep model Markdown, HTML, and backtick fences inert in Markdown viewers.
function block(value: string): string {
  return `${redact(value).replace(/\r\n?|\u2028|\u2029/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").split("\n").map(line => `    ${line}`).join("\n")}\n\n`;
}

/** On-demand text only. The store chooses the destination; sharing is a separate action. */
export function renderMarkdown(state: RunRecord): string {
  const parts = ["# Supership run export\n\n", "Apparent secrets are redacted. Review before sharing. Full transcripts and tool source are not included. Evidence availability is recorded, not rechecked.\n\n",
    block(`Run: ${state.runId}\nPhase: ${state.phase}\nLifecycle: ${state.lifecycle}\nMode: ${state.invocation.mode}\nTopology: ${state.invocation.topology}\nPlan revision: ${state.planRevision}\nLast update: ${timestamp(state.updatedAt)}`), "## Plan\n\n"];
  const plan = state.plan;
  if (plan) {
    parts.push(block(`${plan.title}\n${plan.objective}`));
    for (const [name, values] of Object.entries(plan.scope)) parts.push(block(`${name}:\n${values.join("\n")}`));
    if (plan.fastPath) parts.push(block(`Single-worker fast path: ${plan.fastPath.reason}`));
    if (plan.noChangeReason) parts.push(block(`No change: ${plan.noChangeReason}`));
    for (const item of plan.items) parts.push(block(`${item.id} r${item.revision}: ${item.instructions}\nSeat: ${item.seatId}\nPaths: ${item.expectedPaths.join(", ")}\nExpected outputs: ${item.expectedOutputs.join("\n")}`));
    for (const risk of plan.risks) parts.push(block(`Risk ${risk.id} (${risk.kind}): ${risk.description}`));
  } else parts.push("No plan recorded.\n\n");
  parts.push("## Decisions\n\n");
  for (const approval of state.approvals) parts.push(block(`${approval.id}: ${approval.kind} / ${approval.decision}\nAuthority: ${approval.authority}\nScope: ${approval.scopeHash}\nPlan revision: ${approval.planRevision}\n${timestamp(approval.createdAt)}\n${approval.rationale}`));
  for (const instruction of state.instructions) parts.push(block(`${instruction.classification}, ${instruction.status}: ${instruction.summary}`));
  parts.push("## Findings\n\n");
  for (const finding of state.findings) {
    parts.push(block(`${finding.id} (${finding.severity}, ${finding.lens})\n${finding.location.path}${finding.location.startLine === undefined ? "" : `:${finding.location.startLine}`}\nCondition: ${finding.condition}\nClaim: ${finding.claim}\nImpact: ${finding.impact}\nFix target: ${finding.fixTarget.path}: ${finding.fixTarget.description}\nResolution: ${finding.resolution ? `${finding.resolution.kind}: ${finding.resolution.reason}` : "unresolved"}`));
    for (const verdict of finding.verdicts) parts.push(block(`${verdict.judgeId}, round ${verdict.round}: ${verdict.verdict}\n${verdict.reason}${verdict.duplicateOf ? `\nDuplicate of: ${verdict.duplicateOf}` : ""}`));
  }
  parts.push("## Verification\n\n");
  for (const check of plan?.verificationChecks ?? []) parts.push(block(`Planned ${check.id}${check.required ? " (required)" : " (optional)"}: ${check.description}\n${scenario(check.scenario)}`));
  for (const check of state.verification) parts.push(block(`${check.checkId}: ${check.outcome}\n${scenario(check.scenario)}\n${timestamp(check.startedAt)} to ${timestamp(check.endedAt)}\nExit code: ${check.exitCode ?? "not recorded"}\nCode identity: ${JSON.stringify(check.codeIdentity)}\nEvidence: ${check.evidence.map(ref => `${ref.id}: ${ref.availability}`).join(", ") || "none recorded"}`));
  parts.push("## Blockers and unresolved evidence\n\n");
  for (const reason of blockers(state, [])) parts.push(block(reason));
  for (const check of plan?.verificationChecks ?? []) if (!state.verification.some(result => result.checkId === check.id)) parts.push(block(`${check.id}: no verification result recorded`));
  for (const check of state.verification) if (!check.evidence.length) parts.push(block(`${check.checkId}: no evidence recorded`));
  const refs = evidenceRefs(state);
  const unresolved = refs.filter(ref => ref.availability !== "available");
  for (const ref of unresolved) parts.push(block(evidenceText(ref)));
  if (!refs.length) parts.push("No evidence references recorded.\n\n");
  else if (!unresolved.length) parts.push("No unavailable or unverified references recorded. Availability has not been rechecked.\n\n");
  parts.push("## Evidence references\n\n");
  for (const ref of refs.filter(ref => ref.availability === "available")) parts.push(block(evidenceText(ref)));
  if (state.conclusion) parts.push("## Conclusion and local lessons\n\n", block(`${state.conclusion.kind}: ${state.conclusion.summary}\nDeferred findings: ${state.conclusion.unresolvedDeferredFindingIds.join(", ") || "none"}\n${state.conclusion.lessons.join("\n")}`));
  return parts.join("");
}
