import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { createRun, openWriter, StoreError, transact } from "../../src/store.ts";
import { startInput } from "../core-fixtures.ts";

const [mode, root, slug] = process.argv.slice(2);
const runPath = join(root, ".planning", slug);
if (mode === "contend") {
  try { await openWriter(runPath, { sessionId: "contender", purpose: "resume" }); process.exit(10); }
  catch (error) { if (error instanceof StoreError && error.code === "writer-busy") process.exit(0); throw error; }
}
const writer = await openWriter(runPath, { sessionId: "session", purpose: "start" });
const input = startInput(root, slug, writer.leaseId);
const created = await createRun(writer, input, input.start.preflight);
if (created.kind !== "committed") throw new Error("Fixture run did not start");
if (mode === "crash-after-flush") {
  await chmod(runPath, 0o500);
  try {
    await transact(writer, { kind: "record-source-usage", sources: [{ id: "fixture", complete: true, tokens: 17, costAmount: null, model: "fixture/model", observedAt: 0 }] }, { now: Date.now(), inputId: "flushed-before-crash", ownerSessionId: "session", ownerEpoch: 0 });
    throw new Error("Read-only directory unexpectedly allowed a snapshot");
  } catch (error) {
    if (!(error instanceof StoreError) || !error.committed) throw error;
    console.log("committed-without-snapshot");
  }
} else console.log("lease-held");
// A real SIGKILL from the parent must close stdin of the separate flock helper.
await new Promise(() => setInterval(() => undefined, 1000));
