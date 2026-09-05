#!/usr/bin/env bun
import { assertSchema, RunRecordSchema } from "../src/contracts.ts";
import { renderDashboard } from "../src/dashboard.ts";

// A static fixture, never an executable or resumable Supership run.
const state: unknown = await Bun.file(new URL("../examples/demo-state.json", import.meta.url)).json();
assertSchema(RunRecordSchema, state, "dashboard example");
process.stdout.write(renderDashboard(state));
