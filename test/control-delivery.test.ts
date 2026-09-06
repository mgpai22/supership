import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "./fixtures/acceptance/runner.ts";
import { controlFailure, receivedControl, visibleObjects } from "./support/control-messages.ts";
import type { Context } from "@oh-my-pi/pi-ai";
import { assertSchema, canonicalJson, type ActionRecord, type RunRecord } from "../src/contracts.ts";
import { issueControl, controlPage, controlManifest, controlResult, NextRequestSchema } from "../src/control-delivery.ts";
import type { ControlCell } from "../src/omp.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Observation {
  event: string; toolCallId?: string; code?: string; action?: ActionRecord; state?: RunRecord; error?: boolean;
  content?: Array<{ type: string; text?: string }>;
}
const text = (event: Observation) => event.content?.map(block => block.text ?? "").join("\n") ?? "";

for (const persistedSession of [false, true]) test(`large control display retrieval ${persistedSession ? "persisted session" : "no session"}`, async () => {
  const evidence = await runScenario({ id: `delivery-${persistedSession ? "session" : "ephemeral"}`, command: "shipit", builds: [], deliveryProof: true }, { persistedSession, timeout: 180000 });
  const events: Observation[] = readFileSync(join(evidence.root, "provider.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const bootstrap = events.find(event => event.event === "model-result" && event.toolCallId === "delivery-bootstrap");
  assert.ok(bootstrap, `The native model must receive bootstrap text: ${evidence.root}`);
  assert.doesNotMatch(text(bootstrap), /\[…\d+ch elided…\]/, `Native bootstrap must not lose code to display truncation: ${evidence.root}`);
  const reconstructed = events.find(event => event.event === "delivery-reconstructed");
  const reportPath = join(evidence.root, "control-delivery-evidence.json");
  writeFileSync(reportPath, JSON.stringify({ root: evidence.root, persistedSession, reconstructed: !!reconstructed }, null, 2));
  assert.ok(reconstructed?.code && reconstructed.action, `The model-visible transport must reconstruct the original cell: ${evidence.root}`);
  assert.ok(reconstructed.code.length > 8000, "The regression must exceed the actual native display limit");
  assert.equal(hash(reconstructed.code), reconstructed.action.programHash);
  assert.ok(reconstructed.code.includes("雪🙂") && reconstructed.code.includes("\\\\"), "The generated code must carry escaped Unicode input and its expanded schema");
  const visible = events.filter(event => event.event === "model-result");
  const packets = visible.flatMap(event => visibleObjects(text(event)).filter(({ value }) => {
    const details = value.details;
    return details !== null && typeof details === "object" && "kind" in details && (details.kind === "cell" || details.kind === "page");
  }));
  assert.ok(packets.length > 2, "The native formatter must deliver multiple complete JSON pages");
  for (const packet of packets) {
    assert.ok(packet.text.length <= 7000, `Native pretty JSON exceeds the character budget: ${packet.text.length}`);
    assert.ok(Buffer.byteLength(packet.text, "utf8") <= 7000, "Native pretty JSON exceeds the UTF-8 budget");
  }
  const before = visible.find(event => event.toolCallId === "delivery-bootstrap")!.state!;
  for (const event of visible.filter(event => event.toolCallId?.startsWith("delivery-page-") || event.toolCallId === "delivery-repeat-page")) {
    assert.deepEqual(event.state, before, `Read-only retrieval changed state: ${event.toolCallId}`);
  }
  for (const id of ["modified", "unrelated", "timeout", "expression", "invalid-page", "extra-field", "unknown-id", "out-of-range", "forged-approval", "pending-page", "duplicate", "stale-page"]) {
    const result = visible.find(event => event.toolCallId === `delivery-${id}`);
    assert.ok(result?.error, `The model must receive the ${id} rejection`);
    assert.match(text(result), /refused|refuse|exact|issued|invalid|validation|schema|stale|range|claim|Error/i, `The ${id} request did not report a rejection: ${text(result)}`);
    if (!["pending-page", "duplicate", "stale-page"].includes(id)) assert.deepEqual(result.state, before, `The rejected ${id} request changed authority`);
  }
  const exact = visible.find(event => event.toolCallId === "delivery-exact");
  assert.ok(exact && !exact.error, "The model must receive a successful result for the reconstructed original");
  const runtimeResult = evidence.events.find(event => event.event === "tool-result" && event.toolCallId === "delivery-exact");
  assert.ok(runtimeResult && !runtimeResult.error);
  const nativeDetails = runtimeResult.details;
  assert.ok(nativeDetails && typeof nativeDetails === "object" && "cells" in nativeDetails && Array.isArray(nativeDetails.cells));
  assert.deepEqual(nativeDetails.cells.map(cell => cell.status), ["complete"], "The real native eval must finish, not merely claim its action");
  const complete = events.find(event => event.event === "delivery-complete")?.state;
  assert.ok(complete, `The native provider must reach its observed boundary: ${evidence.root}`);
  assert.equal(complete.recovery, undefined, "An unrelated page result must not pause a claimed control execution");
  const action = complete.actions.find(action => action.id === reconstructed.action!.id)!;
  assert.notEqual(action.status, "issued", "The reconstructed original must execute");
  assert.ok(action.receiptIds.some(id => id.includes(":created:")), "The original spawn must produce its actual creation receipt");
  const owners = complete.work.flatMap(work => work.runtimeOwners).filter(owner => owner.actionId === action.id);
  assert.equal(owners.length, action.recipients.length, "Each issued recipient must acquire exactly one native runtime owner");
  assert.equal(complete.actions.length, before.actions.length, "Retrieval and attacks must not issue any other action");
  assert.deepEqual(complete.approvals, before.approvals);
  assert.deepEqual(complete.owner, before.owner);
  const calls = evidence.events.filter(event => event.event === "tool-call" && event.name === "task");
  assert.equal(calls.length, 1, "The original native action must spawn exactly once");
  const sessions = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sessions(join(path, entry.name)) : entry.name.endsWith(".jsonl") ? [join(path, entry.name)] : []);
  const parentSessionId = readFileSync(join(evidence.root, "parent-session.txt"), "utf8");
  const sessionFiles = sessions(join(evidence.root, "home", ".omp")).filter(path => path.includes("/sessions/"));
  const parentSession = sessionFiles.find(path => readFileSync(path, "utf8").includes(parentSessionId));
  assert.equal(!!parentSession, persistedSession, "The row must exercise real persisted-session selection");
  writeFileSync(reportPath, JSON.stringify({ root: evidence.root, persistedSession, parentSession, codeChars: reconstructed.code.length, programHash: action.programHash, visiblePackets: packets.length, maxVisibleChars: Math.max(...packets.map(packet => packet.text.length)), maxVisibleBytes: Math.max(...packets.map(packet => Buffer.byteLength(packet.text))), status: action.status, result: "passed" }, null, 2));
  console.log(reportPath);
}, 240000);

test("cancelled issued control cannot be retrieved or executed through the native TUI", async () => {
  const evidence = await runScenario({ id: "delivery-cancel", command: "shipit", builds: [], deliveryCancellation: true }, { cancelWhen: event => event.event === "delivery-cancel-ready", timeout: 120000 });
  const events: Observation[] = readFileSync(join(evidence.root, "provider.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const ready = events.find(event => event.event === "delivery-cancel-ready"), complete = events.find(event => event.event === "delivery-cancel-complete");
  assert.ok(ready?.action && ready.state && complete?.state, `The native TUI must cancel an unclaimed issued cell: ${evidence.root}`);
  const action = complete.state.actions.find(action => action.id === ready.action!.id)!;
  assert.equal(action.status, "superseded");
  assert.equal(action.claimedAt, undefined);
  assert.equal(complete.state.lifecycle, "cancelled");
  assert.ok(complete.state.eventSequence > ready.state.eventSequence);
  const denied = events.filter(event => event.event === "model-result" && event.toolCallId?.startsWith("delivery-cancel-stale-"));
  assert.equal(denied.length, 2);
  for (const result of denied) {
    assert.ok(result.error);
    assert.match(text(result), /stale|issued/);
    assert.deepEqual(result.state, complete.state, "Stale retrieval or execution must not advance the cancelled state");
  }
  assert.deepEqual(complete.state.owner, ready.state.owner);
  assert.deepEqual(complete.state.approvals, ready.state.approvals);
  assert.equal(evidence.events.filter(event => event.event === "tool-call" && event.name === "task").length, 0);
  console.log(evidence.root);
}, 180000);

test("ordered pages bound the entire escaped bridge envelope and preserve every code unit", () => {
  const code = "normal code;\n".repeat(1200) + '"\\\n\r\t\u0000雪🙂\ud800x\udc00'.repeat(1500);
  const cell: ControlCell = { language: "js", timeout: 0, code, inputHash: "a".repeat(64), programHash: hash(code), actionId: "a-1", runId: "fixture", ownerEpoch: 0, expectedStateRevision: 1, recipients: [] };
  const issued = issueControl(cell);
  const manifest = controlManifest(issued);
  assert.ok(issued.pages.length > 1);
  const packets = [manifest, ...issued.pages.map((_code, page) => controlPage(issued, page))];
  const reconstructed: string[] = [];
  for (const details of packets) {
    const result = controlResult(details);
    const bridge = { text: result.content.map(block => block.text).join("\n"), details: result.details };
    const displayed = JSON.stringify(bridge, null, 2);
    assert.ok(displayed.length <= 7000 && Buffer.byteLength(displayed) <= 7000, "Both native display limits must include escaped text and details");
    if (details.kind === "page") {
      const decoded = JSON.parse(displayed);
      assert.equal(JSON.parse(decoded.text).code, decoded.details.code);
      reconstructed.push(decoded.details.code);
      if (details.next !== null) {
        const request = JSON.parse(/^display\(await tool\.supership_next\(([^]*)\)\);$/.exec(details.next)![1]!);
        assertSchema(NextRequestSchema, request);
        assert.deepEqual(request, { cellId: issued.cellId, page: details.page + 1 });
      } else assert.equal(details.page, issued.pages.length - 1);
    }
  }
  assert.equal(reconstructed.join(""), code);
  assert.equal(hash(reconstructed.join("")), cell.programHash);
  assert.notEqual(issueControl(cell).cellId, issued.cellId, "A different issuance cannot reuse an old cursor");
  for (const page of [-1, 0.5, issued.pages.length, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => controlPage(issued, page), /range/);
  for (const request of [null, [], false, { page: 0 }, { cellId: issued.cellId }, { cellId: issued.cellId, page: "0" }, { cellId: issued.cellId, page: 0, approve: true }]) assert.throws(() => assertSchema(NextRequestSchema, request));
  // Raw strings can look small while JSON escaping breaches the actual duplicated display limit.
  const expanded = { kind: "page", cellId: issued.cellId, page: 0, pages: 2, code: "\u0000".repeat(600), next: manifest.next };
  assert.ok(canonicalJson(expanded).length < 7000);
  assert.throws(() => controlResult(expanded), /display budget/);
});

test("the visible-message consumer refreshes only exact read or preclaim denials", () => {
  const code = "const granted = 1;";
  const cell: ControlCell = { language: "js", timeout: 0, code, inputHash: "a".repeat(64), programHash: hash(code), actionId: "a-1", runId: "fixture", ownerEpoch: 0, expectedStateRevision: 1, recipients: [] };
  const manifest = controlManifest(issueControl(cell));
  const delivered = { cellId: manifest.cellId, next: manifest.next, code, pages: manifest.pages };
  const stale = "Extension control failed: stale-action: Action was superseded by a later state revision";
  const refused = "Use only the exact issued Supership control cell. Unknown, stale, changed, and duplicate cells are refused.";
  const failed = (args: Record<string, unknown>, error: string, resultId = "issued", isError = true): Context => ({ messages: [
    { role: "assistant", content: [{ type: "toolCall", id: "issued", name: "eval", arguments: args }] },
    { role: "toolResult", toolCallId: resultId, toolName: "eval", content: [{ type: "text", text: error }], isError, timestamp: 0 },
  ] } as Context);
  const args = { language: "js", timeout: 0, code };
  assert.equal(controlFailure(failed({ ...args, code: delivered.next }, "This cursor is stale"), delivered)?.refresh, true);
  for (const error of [stale, refused]) {
    assert.equal(controlFailure(failed(args, error), delivered)?.refresh, true);
    assert.equal(controlFailure(failed({ ...args, code: code + "\n// changed" }, error), delivered)?.refresh, false);
    for (const invalid of [{ ...args, language: "py" }, { ...args, timeout: undefined }, { ...args, reset: true }]) assert.equal(controlFailure(failed(invalid, error), delivered)?.refresh, false);
  }
  assert.equal(controlFailure(failed(args, stale, "another-call"), delivered)?.refresh, false);
  assert.equal(controlFailure(failed(args, "Script execution failed after a write"), delivered)?.refresh, false);
  assert.equal(controlFailure(failed(args, "Script execution failed after a write: stale-action: output contained an old failure"), delivered)?.refresh, false);
  assert.equal(controlFailure(failed(args, "Script execution failed after a write: " + stale), delivered)?.refresh, false);
  assert.equal(controlFailure(failed(args, stale, "issued", false), delivered), undefined);

  const shown = (details: object) => ({ role: "toolResult" as const, toolCallId: "fetch", toolName: "eval", content: [{ type: "text" as const, text: JSON.stringify({ text: canonicalJson(details), details }) }], isError: false, timestamp: 0 });
  const context: Context = { messages: [shown(manifest)] };
  assert.equal(receivedControl(context)?.next, manifest.next);
  context.messages.push(shown({ lifecycle: "cancelled" }));
  assert.equal(receivedControl(context), undefined, "A new status must discard the incomplete older delivery");
});
