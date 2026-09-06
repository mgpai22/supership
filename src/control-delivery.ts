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
    pages.push(cell.code.slice(start, start + low)); start += low;
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
