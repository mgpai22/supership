import assert from "node:assert/strict";
import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Call once for a fresh fixture HOME, before starting OMP or importing its SDK. */
export function shareNativeCache(home: string): void {
  // Keep the acceptance cache path; only native binaries are shared, never HOME state.
  const natives = join(tmpdir(), "supership-acceptance-natives");
  mkdirSync(natives, { recursive: true, mode: 0o700 });
  const cache = lstatSync(natives);
  assert.ok(cache.isDirectory() && cache.uid === process.getuid!() && (cache.mode & 0o022) === 0,
    `Native fixture cache must be an owned directory without group/other writes: ${natives}`);
  mkdirSync(join(home, ".omp"), { recursive: true });
  symlinkSync(natives, join(home, ".omp", "natives"));
}
