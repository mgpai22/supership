import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "support/native-cache.ts");

test("fixture homes share one private native cache across processes without sharing host state", async () => {
  const root = mkdtempSync(join(tmpdir(), "supership-native-cache-"));
  const homes = [join(root, "a"), join(root, "b")];
  const setup = `import { shareNativeCache } from ${JSON.stringify(helper)}; shareNativeCache(process.env.HOME);`;
  const prepare = async (home: string, temp = root) => {
    const child = Bun.spawn([process.execPath, "-e", setup], {
      env: { HOME: home, TMPDIR: temp }, stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { status, stderr };
  };
  try {
    const results = await Promise.all(homes.map(home => prepare(home)));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const cache = join(root, "supership-acceptance-natives");
    assert.equal(lstatSync(cache).mode & 0o777, 0o700);
    writeFileSync(join(cache, "binary"), "shared native bytes");
    for (const [index, home] of homes.entries()) {
      assert.equal(realpathSync(join(home, ".omp/natives")), cache);
      mkdirSync(join(home, ".omp/agent"));
      writeFileSync(join(home, ".omp/agent/config.yml"), `fixture: ${index}\n`);
      const physical = statSync(join(cache, "binary")), linked = statSync(join(home, ".omp/natives/binary"));
      assert.deepEqual([linked.dev, linked.ino], [physical.dev, physical.ino]);
    }
    assert.equal(readFileSync(join(homes[0]!, ".omp/agent/config.yml"), "utf8"), "fixture: 0\n");
    assert.equal(readFileSync(join(homes[1]!, ".omp/agent/config.yml"), "utf8"), "fixture: 1\n");
    rmSync(homes[0]!, { recursive: true });
    assert.equal(readFileSync(join(homes[1]!, ".omp/natives/binary"), "utf8"), "shared native bytes");

    // Reuse must never replace an occupied HOME cache or follow an untrusted shared target.
    const occupied = join(root, "occupied"); mkdirSync(join(occupied, ".omp/natives"), { recursive: true });
    writeFileSync(join(occupied, ".omp/natives/keep"), "preserve");
    assert.notEqual((await prepare(occupied)).status, 0);
    assert.equal(readFileSync(join(occupied, ".omp/natives/keep"), "utf8"), "preserve");
    const redirected = join(root, "redirected"); mkdirSync(redirected);
    symlinkSync(cache, join(redirected, "supership-acceptance-natives"));
    assert.notEqual((await prepare(join(root, "rejected-link"), redirected)).status, 0);
    assert.equal(existsSync(join(root, "rejected-link")), false);
    chmodSync(cache, 0o777);
    assert.notEqual((await prepare(join(root, "rejected-writable"))).status, 0);
    assert.equal(existsSync(join(root, "rejected-writable")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
