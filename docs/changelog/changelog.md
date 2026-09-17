---
title: Changelog
order: 1
description: Merged Changes
---

# Changelog

This page lists merged pull requests, newest first, from repository history. A pull request proposes repository changes for review.

## Unreleased

### OMP 18.2.3 fixtures

Supership pins SDK 18.2.3 fixtures within the accepted `>=18.1.10 <18.3.0` range. OMP 18.2.3 resolves config-backed headers asynchronously and changes revived-subagent extension handling; Supership uses neither removed API, and the offline suite re-proves sessions, tasks, eval, and native yield on both hosts. Approval, grant, and exact-code checks remain unchanged.

### OMP 18.2 support

Supership accepts OMP `>=18.1.10 <18.3.0` with SDK 18.2.2 fixtures. Fixtures supply controlled test inputs. OMP 18.2 converts tool schemas from a clone, so the `CloneType` workaround now guards 18.1 hosts only. Tests no longer assume same-message tool calls run in order, and native isolation cleanup is asserted after session release, matching the 18.2 kept-alive lifecycle. Approval, grant, and exact-code checks remain unchanged.


### Dynamic tools on OMP 18.1.17

Supership uses `CloneType` at all five `api.registerTool` sites so OMP wire conversion cannot change its internal TypeBox validation schemas. Offline tests cover dynamic tool proposals, callback recovery, and tool recreation after kernel loss. Approval and grant checks remain unchanged.

The unlimited-concurrency acceptance assertion now enforces only explicit finite Supership and native OMP limits. It no longer assumes a default ceiling of three.

### Complete control-cell delivery

Supership delivers large control cells, managed blocks of code, in numbered pages that fit OMP's output limit. The agent reconstructs the original cell before execution. This removes the research blockage reported in [#8](https://github.com/mgpai22/supership/issues/8), including with `--no-session`. Exact-code checks and action approval requirements remain unchanged.

## OMP 18 upgrade: offline acceptance and global installation passed

The upgrade replaces the Markdown/Python driver with one TypeScript extension, a Crust CLI, and three provider-neutral personas. An extension adds behavior to OMP. A CLI is a command-line interface. A persona supplies reusable agent instructions. Provider-neutral roles do not require a specific model service.

Versioned state and events determine recovery. HTML remains read-only.

Ultra planning retains the three, five, and seven-call graphs, sequences of dependent planning calls. Review uses fresh lenses, specific review topics. Normal review uses one judge. Ultra review uses two independent judges.

Review rounds have no default limit. Stalls and judge disagreement pause work.

The event log retains child usage observations and coverage, the extent of recorded usage. Missing observation files cannot erase recorded usage. Known cost subtotals enforce caps while unknown totals remain explicit. Saturated counters, values that reach their numeric capacity, show lower bounds.

Review progress uses net file effects, the final difference after all edits. Workspace receipts record observed effects and establish ownership. Uncertain effects require a trusted user decision.

Before later actions, resume makes sure that verification artifact bytes still match the recorded evidence. Artifacts retain evidence that requirements pass. Repository requirements apply when their paths overlap plan paths.

The complete offline suite and typecheck passed with compiled OMP 18.1.11 and SDK 18.1.10 fixtures. Typecheck detects incompatible code types. SDK means software development kit. Fixtures supply controlled test inputs.

Native test homes share their binary cache, stored executable files for reuse. They no longer extract a copy per fixture.

Managed installation defaults to a dry-run inventory, a preview without changes. It preserves unrelated files. Repository-specific migrations require separate approval. Scripted proofs do not establish real-model judgment quality.

A real global OMP 18.1.11 session loaded all five commands from the new extension. A second installation preview proposed no changes.

## Merged history

- [#3](https://github.com/mgpai22/supership/pull/3) Route frontend work through the designer agent (2026-07-10)
- [#2](https://github.com/mgpai22/supership/pull/2) /superreview: standalone genius review and fix over local changes (2026-07-10)
- [#1](https://github.com/mgpai22/supership/pull/1) Ultra review: genius-tier adversarial review on ultra runs (2026-07-10)
