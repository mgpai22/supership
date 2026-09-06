import assert from "node:assert/strict";
import type { Context } from "@oh-my-pi/pi-ai";

export interface ControlPacket {
  kind: "cell" | "page";
  cellId: string;
  pages: number;
  next: string | null;
  page?: number;
  code?: string;
}
interface ControlStatus { kind?: never; lifecycle: string; message?: string }

/** Read JSON only from the text the model receives, including native display's surrounding labels. */
export function visibleObjects(text: string): Array<{ value: Record<string, unknown>; text: string }> {
  const objects: Array<{ value: Record<string, unknown>; text: string }> = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
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
        const raw = text.slice(start, end + 1);
        try { objects.push({ value: JSON.parse(raw), text: raw }); } catch { /* Ordinary native prose is not JSON. */ }
        start = end;
        break;
      }
    }
  }
  return objects;
}

export function visibleNextPackets(context: Context) {
  return context.messages.flatMap(message => message.role !== "toolResult" || message.isError ? [] : message.content.flatMap(block => {
    if (block.type !== "text") return [];
    return visibleObjects(block.text).flatMap(({ value, text }) => {
      const candidate = value.details ?? value;
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const packet = candidate as ControlPacket | ControlStatus;
      return packet.kind === "cell" || packet.kind === "page" || "lifecycle" in packet && typeof packet.lifecycle === "string" ? [{ packet, text, toolCallId: message.toolCallId }] : [];
    });
  }));
}
export function visibleControls(context: Context) {
  return visibleNextPackets(context).flatMap(item => item.packet.kind === "cell" || item.packet.kind === "page" ? [{ ...item, packet: item.packet }] : []);
}

export function receivedControl(context: Context) {
  const visible = visibleNextPackets(context);
  const manifest = visible.findLast(item => item.packet.kind === "cell")?.packet;
  if (!manifest || manifest.kind !== "cell" || !visible.at(-1)?.packet.kind) return undefined;
  const parts: string[] = [];
  let next = manifest.next;
  for (const { packet } of visible) {
    if (packet.kind !== "page" || packet.cellId !== manifest.cellId) continue;
    assert.equal(packet.pages, manifest.pages);
    assert.equal(typeof packet.code, "string");
    // Repeated reads must return the same immutable page; they never change assembly order.
    if (packet.page! < parts.length) { assert.equal(parts[packet.page!], packet.code); continue; }
    assert.equal(packet.page, parts.length, "The provider must retrieve pages in order");
    parts.push(packet.code!); next = packet.next;
  }
  assert.ok(parts.length <= manifest.pages);
  if (parts.length === manifest.pages) assert.equal(next, null);
  return { cellId: manifest.cellId, next, code: parts.length === manifest.pages ? parts.join("") : undefined, pages: manifest.pages };
}

/** A preclaim denial permits a fresh read, never replay of the rejected program. */
export function controlFailure(context: Context, delivered: ReturnType<typeof receivedControl>) {
  const result = context.messages.findLast(message => message.role === "toolResult");
  if (!result?.isError) return undefined;
  const error = result.content.map(block => block.type === "text" ? block.text : "").join("\n");
  for (const message of context.messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.content) {
      if (call.type !== "toolCall" || call.id !== result.toolCallId) continue;
      const args = call.arguments;
      const canonical = call.name === "eval" && args.language === "js" && args.timeout === 0 && args.reset !== true && typeof args.code === "string";
      const stale = /^Extension [^\r\n]+ failed: stale-action: (?:Action was superseded by a later state revision|Action revision, owner or program\/input hash differs)$/.test(error) || error === "Use only the exact issued Supership control cell. Unknown, stale, changed, and duplicate cells are refused.";
      return { error, refresh: !!(delivered && canonical && (args.code === delivered.next || args.code === delivered.code && stale)) };
    }
  }
  return { error, refresh: false };
}
