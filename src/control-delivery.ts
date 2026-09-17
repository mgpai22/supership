import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox/type";
import { canonicalJson } from "./contracts.ts";
import type { ControlCell } from "./omp.ts";

export const NextRequestSchema = Type.Union([
  Type.Object({}, { additionalProperties: false }),
  Type.Object({ cellId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }), page: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false }),
]);
export type NextRequest = Static<typeof NextRequestSchema>;
export interface IssuedControl { readonly cellId: string; readonly cell: ControlCell; readonly pages: readonly string[] }

export function nextExpression(request: NextRequest): string {
  return `display(await tool.supership_next(${canonicalJson(request)}));`;
}

// Native eval formats the bridge's text AND details as pretty JSON before its 8000-character limit.
// Reserve room for native labels and enforce UTF-8 too. Raw code length does not bound escaped display.
const DISPLAY_LIMIT = 7000;
function fitsDisplay(details: unknown): boolean {
  const display = JSON.stringify({ text: canonicalJson(details), details }, null, 2);
  return display.length <= DISPLAY_LIMIT && Buffer.byteLength(display, "utf8") <= DISPLAY_LIMIT;
}
export function controlResult(details: unknown) {
  if (!fitsDisplay(details)) throw new Error("Supership control response exceeds the display budget.");
  return { content: [{ type: "text" as const, text: canonicalJson(details) }], details };
}
function pageDetails(cellId: string, page: number, pages: number, code: string) {
  return { kind: "page" as const, cellId, page, pages, code, next: page + 1 < pages ? nextExpression({ cellId, page: page + 1 }) : null };
}
// A page boundary follows punctuation or whitespace, never an identifier, keyword, escape, or surrogate half:
// escapes span only [0-9A-Za-z\{}$_] and a backslash, so a boundary after any other unit cannot tear one.
function splitBefore(code: string, start: number, size: number): number {
  const end = start + size;
  if (end >= code.length) return size;
  for (let index = end - 1; index >= start; index--) {
    const unit = code.charCodeAt(index);
    if (unit >= 0x30 && unit <= 0x39) continue;
    if (unit >= 0x41 && unit <= 0x5a) continue;
    if (unit >= 0x61 && unit <= 0x7a) continue;
    if (unit === 0x5c || unit === 0x7b || unit === 0x7d || unit === 0x24 || unit === 0x5f) continue;
    if (unit >= 0xd800 && unit <= 0xdbff) continue;
    return index - start + 1;
  }
  // No safe unit in range: back off a trailing partial escape, if any, so even dense blobs keep escapes whole.
  const tail = code.slice(Math.max(start, end - 10), end);
  const partial = /\\(u\{[0-9a-fA-F]{0,6}|u[0-9a-fA-F]{0,3}|x[0-9a-fA-F]?)?$/.exec(tail);
  if (partial) {
    if (partial[1] === undefined) { const run = /\\+$/.exec(tail)![0].length; if (run % 2 === 1) return Math.max(1, size - 1); }
    else if (partial[0].length < size) return size - partial[0].length;
  }
  return size;
}
export function issueControl(cell: ControlCell): IssuedControl {
  const cellId = randomUUID(), pages: string[] = [];
  for (let start = 0; start < cell.code.length;) {
    let low = 0, high = Math.min(DISPLAY_LIMIT, cell.code.length - start);
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      // A page contains at least one code unit, so code.length is a conservative page-count width.
      if (fitsDisplay(pageDetails(cellId, pages.length, cell.code.length, cell.code.slice(start, start + size)))) low = size;
      else high = size - 1;
    }
    if (!low) throw new Error("Supership control page cannot fit the display budget.");
    const cut = splitBefore(cell.code, start, low);
    pages.push(cell.code.slice(start, start + cut)); start += cut;
  }
  return { cellId, cell, pages };
}
export function controlManifest(issued: IssuedControl) {
  return { kind: "cell" as const, cellId: issued.cellId, pages: issued.pages.length, next: nextExpression({ cellId: issued.cellId, page: 0 }) };
}
export function controlPage(issued: IssuedControl, page: number) {
  if (!Number.isSafeInteger(page) || page < 0 || page >= issued.pages.length) throw new Error("Supership control page is out of range.");
  return pageDetails(issued.cellId, page, issued.pages.length, issued.pages[page]!);
}
