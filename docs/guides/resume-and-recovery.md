---
title: Resume and recovery
order: 4
description: Resume and Budget Recovery
---

# Resume and recovery

Every command accepts `resume`. Because the dashboard file is the source of truth and every eval cell re-reads it, a run can pick up cold.

## Resume

Given a slug, resume uses that run. Otherwise it picks the newest `.planning/` dashboard whose status is not `done` or `failed`, then branches on the stored status.

- `awaiting_approval` re-enters the approval gate.
- `building` or `reviewing` re-runs Cell 2 as-is. It skips pieces already `done` and continues the review-round count from the file.
- `planning` or `clarifying` (rare, died mid-plan) restarts Cell 1 from the stored spec.

## Interrupted eval cells

An interrupted eval cell (a `KeyboardInterrupt`) does **not** kill the `agent()` jobs it spawned. They keep running in the background and usually finish, writing their result to the session artifacts (`<label>.md`, also retrievable with the eval `output("<job id>")` helper; check `/jobs`).

So recover, do not redo. Check the job first. If it is still running, wait or poll it. If it finished, fetch its result and continue the pipeline from that exact point. Respawning burns the money already spent and orphans a live genius job.

## Budget kills

omp caps each subagent at `task.softRequestBudget` requests. At the budget it may steer the child to wrap up (only if `task.softRequestBudgetNotice` is true), and at 1.5x it hard-aborts, sometimes in the exact instant the child is yielding `status="done"`. `run_build` salvages that case automatically via `salvage_yield`. If a piece still lands unresolved with this error:

1. The child's edits survive in the working tree. Run `git status` before assuming loss; its transcript holds its findings.
2. Re-dispatch as a **continuation** ("prior work is on disk at `<files>`; verify and finish, do not restart"), never a from-scratch redo.
3. For heavy pieces (debuggers routinely need 150-plus requests), raise `task.softRequestBudget` and enable `task.softRequestBudgetNotice` so children get the wrap-up warning instead of a silent kill.

> [!DANGER]
> **Never downgrade a genius to a generic worker.** Do not re-route planning, consult, or debug work to a generic worker as a "faster fallback." The task tool's `role=` field is a display persona, not an agent selector. A task item without an explicit `agent="planner"` runs on the generic task worker, silently swapping the genius brain for a cheap one. If the genius genuinely cannot run, stop and tell the user. Repeated interrupts are an environment problem to surface, not to code around with a weaker spawn path.
