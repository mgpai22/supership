---
title: Architecture
order: 3
description: Eval Cells and State Model
---

# Architecture

## Eval cells

The main agent authors and runs the pipeline as `eval` cells (`language: "py"`) on omp's `workflowz` engine. Three primitives drive everything:

- `agent(prompt, agent=..., model=..., schema=..., label=...)` spawns a named subagent and returns its structured result.
- `parallel([...])` runs a list of thunks concurrently and returns their results in order.
- `completion(prompt, model=..., schema=...)` runs a single model completion (used for the review judge).

Control flow is ordinary Python. The main agent authors this at depth 0 rather than delegating to a nested orchestrator.

## SHARED HELPERS

Every cell is the assignment lines plus the SHARED HELPERS block plus that cell's body. The helpers block holds:

- **State I/O.** `save_state(S)` renders the dashboard from canonical JSON, `load_state()` parses it back, `plog(S, phase, msg)` appends a progress-log entry and saves, and `ensure_gitignore()` keeps `.planning/` out of git by default.
- **`read_model_roles()`.** Reads `modelRoles` from omp config inside a cell body. Fail-open. Any error returns `{}` so callers fall back to their own defaults.
- **Schemas.** `PLAN_SCHEMA`, `FINDINGS_SCHEMA`, `JUDGE_SCHEMA`, `BUILD_SCHEMA`, `VERIFY_SCHEMA`, and `UREVIEW_SCHEMA` (the ultra synthesis output, which reuses the findings and judge sub-schemas verbatim so the two review paths stay interchangeable).
- **`is_frontend(path)`.** The mechanical frontend glob used for review and fix routing. See [Frontend and design](/guides/frontend-and-design).
- **`review_diff_hint(base)`.** What reviewers are told to inspect (the working tree by default, a committed range when a base is given).
- **`run_review_loop(...)`.** The whole review engine (see below).

The load-balancing pool helpers (`pool_healthy`, `pool_model`, `pool_alt`) live in Cell 2's POOL block, not in the shared helpers. `run_review_loop` reaches for them lazily from the calling cell's globals at call time, which is why `/superreview` pastes both the helpers and the POOL block.

## Shared review engine

`run_review_loop()` is the single review-fix-reverify loop, factored out so `/supership` Cell 2 and the standalone `/superreview` drive the **identical** code. Fix it once, and both improve. Ultra versus normal is chosen inside the loop by whether `S["meta"]["ultra"]` is set; the two paths differ only in the front half and share the entire back half. See [Review](/pipeline/review) and [Ultra review](/ultra/review).

## State model

The canonical state `S` is a single JSON object embedded in the dashboard.

```type-table
# S
meta | object | | task, slug, mode, created, updated, status, plus ultra (topology + seats) and base when present.
spec | string | | The CLARIFIED SPEC (or the raw task in auto mode). This is the run's TASK.
plan | object | | The plan (mode, overlap, pieces, review_lenses, notes), with per-piece status and summary.
approval | object | | state (pending / approved / auto), at, notes.
progress_log | array | | Timestamped phase and message entries.
review_rounds | array | | Per round: found, kept, confirmed, verdicts.
findings | array | | Confirmed findings across rounds.
unresolved | array | | Pieces surfaced as unresolved, each with a reason.
lessons | string | | The consolidated Lessons writeup.
ponytail_debt | array | | Harvested // ponytail: markers with ceiling and upgrade path.
```

Every write is code-driven from the pipeline, so the artifact cannot drift from reality, and each cell re-reads the file so the run is resume-safe.

## Recursion depth

The main agent is depth 0, each `agent()` child adds 1, and a spawner may call `agent()` only while its depth is below `task.maxRecursionDepth` (the eval hard cap is 3). Authoring at depth 0 keeps consultants at depth 1 with room for their own scouts at depth 2. The full escalation chain (`task` to `deep-debugger` to its scouts) needs `maxRecursionDepth >= 3`; the default of 2 blocks the innermost spawn.
