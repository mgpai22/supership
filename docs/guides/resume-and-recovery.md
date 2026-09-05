---
title: Resume and recovery
order: 4
description: Reconcile owners and effects before retry.
---

# Resume and recovery

Resume reads versioned `state.json` and `events.jsonl`. These files record state and events. It does not evaluate old HTML or parse legacy embedded state. It does not trust a saved process-local handle, a reference valid within one process. Unknown versions fail before side effects, changes outside the calculation itself.

## Interrupted work

An interrupted eval, code evaluation within a persistent session, can leave child work alive. Before another spawn, reconcile live owners, action receipts, OMP artifacts/history, and results. Reconciliation compares recorded and observed work. Receipts record action results. Artifacts retain work evidence.

Duplicate receipts and late results must match the action and current plan revision before acceptance.

Read-only work can retry after the engine establishes that no live owner or valid result remains. Builders require inspection of patches and worktrees, separate repository working copies. The user then chooses adopt/retry/discard through the trusted TUI, a terminal user interface. An invalid result does not prove that no file changed.

WorkPool, a scheduler for repeated independent tasks, reconstructs pending logical items after reconciliation of live workers. A pool handle is not durable state, a record that survives process loss.

Without cancellation evidence, the run remains visibly cancelling or blocked. A cancellation request alone is not an acknowledgment.

## Lost JavaScript kernel

Kernel loss invalidates dynamic-tool registrations and grants. The kernel is the persistent JavaScript environment. Grants authorize recipients to call a tool. Affected work pauses. The main agent must recreate or re-propose tools under the applicable approval policy with a new registration generation.

Resume never evaluates stored source automatically. Source, schema, or grant changes create a new tool version. A schema defines the required data structure. Captured state that cannot be serialized into stored data requires re-proposal.

For recovery, the engine treats tools with unknown effects as tools that change state. An agent label of read-only does not change this rule.

## Limits and conflicts

Token, cost, wall-time, and optional review-round caps pause work that can later resume. Tokens are units of model input and output. Wall-time is elapsed clock time. Unknown pricing stays unknown.

At observable boundaries, Supership makes sure that recorded cost and tokens remain below their limits. Active provider requests can therefore exceed the limit. A provider supplies model responses. The TUI reports the observed excess rather than a hard billing limit.

The engine accepts non-overlapping external edits. Overlapping edits pause work before integration, the combination of worker changes. User instructions supersede overlapping work. The engine rejects stale results while unrelated work can continue safely.

After two rounds without progress and with repeated finding fingerprints, the TUI offers reviewer changes, an explicit reasoned override, or stop. A fingerprint identifies the same finding across rounds. Two-judge disagreement also pauses autonomous runs.

## Interrupted installation migration

Use `bun src/cli.ts migrate --recover /path/to/journal.json` to preview the original migration plan. This does not apply changes.

After review, add `--apply --confirm <original-plan-sha256>` with each required `--confirm-file` token. CAUTION: Recovery changes installation files. It retains the original manifest, the file that declares ownership and operations. It refuses conflicting later edits.

To preview rollback, use `migrate --rollback /path/to/journal.json`. Rollback restores the prior installation state. It requires its fresh preview checksum, a value that identifies preview content. The original forward checksum cannot authorize rollback. Default rollback refuses later edits and post-effect mismatches.

After review, use `--apply --confirm <rollback-preview-sha256>`. CAUTION: This command restores the listed files and can discard later edits that the diff shows. A diff shows changes between file versions.

For each changed target, supply its exact `--confirm-file <token>` from the fresh preview. The diff shows current and restoration bytes. It uses base64 for binary content.

A changed registry preview includes all records and configuration. Keep it private.

No token bypasses missing or corrupt backups, unsafe paths, or changes after preview. Partial rollback requires another fresh preview.

See [Installation](../getting-started/installation.md#rollback-and-retention) for per-file recovery and the trusted `--manifest` boundary. Workflow recovery is separate from installation migration recovery.

## Retention and cleanup

Cancellation preserves state, events, patches, diagnostics, artifacts, and worktrees. Cleanup is a separate confirmed operation that lists exact paths. It never operates as a side effect of cancellation.

Old `plan.html` files remain readable historical records. To continue that intent, start a new run. The upgrade has no legacy-run importer.
