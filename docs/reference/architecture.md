---
title: Architecture
order: 3
description: Public OMP APIs, durable state, and parent access.
---

# Architecture

One TypeScript extension owns the state machine, the rules for workflow states and transitions. All five command aliases call it. An alias is another name for the same operation.

The Crust CLI, a command-line interface, reuses core operations for installation, diagnostics, migration, export, and cleanup. It does not implement a second workflow engine.

## Supported boundary

The target is Linux, Git, and OMP `>=18.1.10 <18.2.0`. Supership makes sure that OMP provides the required features. Source evidence uses OMP `5efa48385dde0a0c20cfadf62e2d5b95f84aafd1`. Observations from operation must separately identify the installed binary, the executable program.

Native test homes share only their extracted binary cache, stored executable files for reuse. Configuration, providers, sessions, and evidence remain isolated. A provider supplies model responses. Evidence directories remain local after a run.

For compiled-host verification, put the intended OMP directory first on PATH. Set `SUPERSHIP_ACCEPTANCE_OMP` to its absolute path. Operate `bun test ./test` directly.

`bun run test` prepends local package executables and can select the SDK CLI instead. SDK means software development kit.

At startup, Supership reads the active host version through the public OMP import alias. A plugin-local SDK copy cannot replace that version. CLI doctor separately makes sure that its selected executable meets the requirements. It reports probe failures.

The extension does not fabricate a `ToolSession` or import private task/eval internals. Eval means code evaluation within a persistent session. The extension does not change upstream code. It does not launch an independent production OMP process as a substitute child. The main agent performs actions that require its own session.

Current JavaScript coordination uses awaited handles, `wait()`, and WorkPool. A handle refers to active work. WorkPool schedules repeated independent tasks.

Action identity and receipts, records of observed action results, cover eval-only lifecycle operations that do not emit ordinary tool hooks. Hooks notify extensions about tool events. Ordinary `await tool.*` calls retain OMP wrappers and approval requirements. A child submits its final result through native top-level yield. An eval-bridged yield cannot finalize it.

## State

`state.json` and `events.jsonl` retain versioned runs, owners, plans, actions, decisions, evidence, and recovery. Atomic snapshots provide complete state versions. Append-only events retain history without replacement. These records determine recovery. Logical work identity survives the loss of temporary handles and pool workers.

The event log holds metadata, hashes, summaries, and OMP references instead of complete sensitive transcripts. Metadata describes other data. Hashes identify content. Unknown versions and stale revisions fail before effects. Duplicate and late receipts require reconciliation, a comparison of recorded and observed work.

Observed usage sources and per-execution coverage also persist in the event log. Missing optional child-observation files do not erase recorded usage. New corrupt observations remain explicit gaps. They do not block unrelated accounting or control actions.

The engine generates `plan.html` as read-only HTML. It cannot approve, change, or resume work. Old HTML-only runs remain historical. The engine cannot import them as executable state.

A sanitized Markdown export, text with sensitive details removed, requires an explicit local operation. Publication requires separate permission.

## Dynamic tools

Any agent can propose a JavaScript tool for the current run. Only the main orchestrator, the agent that coordinates work, registers it through native `tool(fn, {name, description, parameters})`. The orchestrator grants access to task/agent/workpool recipients.

Any worker can propose raw JavaScript source and a schema, the required data structure, through its strict native output. The proposal includes purpose, initialization inputs, intended users, and effects.

The parent makes sure that the source meets the policy and captures it. Before storage, it replaces source with artifact references and source/schema hashes. Artifacts retain work evidence. This needs no separate worker-owned registry or extra model-driven capture action.

The engine records source/schema hashes, approval scope, recipients, and registration generation. Interactive users approve source/schema/grants in the TUI, a terminal user interface. Autonomous policy records its decision without changing OMP permissions.

Pre-plan proposals require TUI approval in both modes.

Source or schema changes and broader grants invalidate the old approval where required. Policy rejects obvious raw filesystem/network/process effects and apparent secrets. For external effects, use approved `await tool.*` calls.

Do not treat source review as a sandbox, a boundary that restricts code effects. CAUTION: Source inspection cannot prove arbitrary code safe. Even a bridged shell command can do arbitrary code.

A callback is a function that another task invokes. A callback granted to an isolated child operates in the parent kernel, the persistent JavaScript environment. Label it worktree isolation with parent access. A worktree is a separate working copy of a repository. Parent writes do not enter the captured child patch.

OMP 18.1.10 native `task` children also share the parent JavaScript eval session. Fresh message history does not isolate those globals, values shared within a JavaScript session.

Eval `agent()` children and WorkPool children use independent eval sessions. This distinction does not make approved parent callbacks a sandbox.

Builder callbacks use a controller-owned persistent checkout. For dependent edits, they use the approved active checkout. The controller captures those effects and records their owner separately from native task scratch changes. Native worktree cleanup does not remove the retained checkout.

Workspace call/return receipts record observed before/after identities. A builder claim that it changed code does not prove ownership. If effects are uncertain, a trusted user must decide their disposition before the workflow advances.

After kernel loss, affected grants become unavailable and work pauses. Under the applicable approval policy, recreate or re-propose the tools. Never automatically evaluate stored source.

If captured mutable objects cannot be recreated, re-propose the tool. For recovery, the engine treats tools with unknown effects as tools that change state.

## Package loading contract

The package registers one extension through `package.json`:

```json
{ "omp": { "extensions": ["./src/extension.ts"] } }
```

The three persona files, reusable agent instructions, live in root `agents/`. No manifest field lists agents. A manifest declares package resources. The package registers no Markdown command. The package file list and active discovery exclude the old `omp/` payload.

Pinned source references:

- `packages/coding-agent/src/extensibility/extensions/loader.ts:493-546`: directory extension roots read `omp.extensions` from `package.json`.
- `packages/coding-agent/src/extensibility/plugins/types.ts:27-48`: `omp`/`pi` manifest fields include extension paths, without agent paths.
- `packages/coding-agent/src/extensibility/plugins/loader.ts:147-170`: enabled packages read the `omp` or `pi` manifest.
- `packages/coding-agent/src/extensibility/plugins/loader.ts:423-481`: manifest extension entries resolve to extension files.
- `packages/coding-agent/src/task/discovery.ts:43-59,99-105`: discovery reads Markdown directly under each extension root in `agents/`, without nested directories.
- `packages/coding-agent/src/discovery/omp-extension-roots.ts:343-383`: enabled local/link packages supply resource roots.

These source findings establish loading conventions. They do not prove that actual installations use the new package.

## Verification limits

Supership uses scripted providers to make sure that requirements pass through real OMP sessions, tasks, eval, hooks, and native yield. The test harness isolates `HOME/config/auth`, disables ambient model features, and blocks external network access. No fictional mock/offline CLI flag substitutes for this boundary.

These scripts provide evidence for the software behavior that they exercise. They do not prove model judgment quality. The complete offline suite and typecheck passed with compiled OMP 18.1.11 and the pinned SDK 18.1.10 fixtures.

This evidence does not cover every patch in the supported range. 
