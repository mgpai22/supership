---
title: Execution
order: 3
description: Build Waves and Escalation
---

# Execution

Cell 2 executes the plan. The wave shape comes from the plan's `mode` and `overlap`. Execution is resume-safe and only touches pieces whose status is not already `done`.

## Build waves

**Sequential.** When the plan is `sequential` (or only one piece is left to do), one worker builds the pieces in order on the shared working tree, no isolation.

**Disjoint parallel.** When the plan is `parallel` with `overlap=false`, the pieces touch disjoint files, so they run concurrently on the shared tree directly. There is no race because no two pieces edit the same files.

**Overlapping parallel.** When the plan is `parallel` with `overlap=true`, the pieces may edit the same files. Each builds in an isolated git worktree in patch mode (`merge=false`, `apply=false`, `handle=true`) so its edits stay in the worktree and never apply concurrently. The pipeline collects each piece's patch, then a serial **Synthesize** step applies and reconciles the patches in order, resolving conflicts, and builds or lints to confirm it compiles.

> [!NOTE]
> If isolation is unavailable (not a git repo, or omp's isolation mode is off) or an isolated build raises, that piece falls back to a sequential build on the shared tree, where the full stuck contract still applies.

Dashboard writes happen at the driver level, between and after waves, never from inside a `parallel()` thunk. Concurrent writes would race and drop sibling updates.

## Stuck contract

A builder that hits a wall does not thrash and does not spawn a debugger itself. It stops, leaves its work in place, and returns `status="stuck"` with a `kind` (`bug` or `design`), what it `tried` (including the exact error), and the precise `question` to escalate.

## Escalation

The pipeline reads the stuck signal and consults the right specialist, at depth 1 so the consultant keeps its own scouts.

- **kind = design** goes to the architect, the `planner` in CONSULT mode. On an ultra run this is re-adjudicated by the challenger (`aristotle`) instead, since the model that red-teamed the plan is best placed to reopen it.
- **kind = bug** goes to `deep-debugger` for root-cause diagnosis.

## Guided retry

After a consult, the builder is re-dispatched **once** with the guidance folded into its prompt (labeled `build:<id>:retry`). If it comes back done, the piece is done. If it is still stuck, the piece is surfaced as unresolved in the dashboard rather than looping forever.

## salvage_yield

omp hard-aborts a subagent at 1.5x `task.softRequestBudget`. That abort can land after the child finished its work but before its final yield was recorded, which would misfile a finished piece as an error.

Before writing a piece off, `run_build` calls `salvage_yield`, which reads the child's transcript, finds the final `yield` tool call, and recovers its result. If that recovered result says `status="done"`, the piece is marked done (tagged as salvaged) rather than lost. Raising `task.softRequestBudget` is what actually prevents the kill. See [Resume and recovery](/guides/resume-and-recovery).

> [!TIP]
> When a piece dies to a subscription limit rather than a budget kill, the build also flips to the other pool provider and re-dispatches the piece once there. See [Load balancing](/guides/load-balancing).
