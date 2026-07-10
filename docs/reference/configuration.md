---
title: Configuration
order: 2
description: modelRoles and Settings
---

# Configuration

supership relies on a set of `modelRoles` plus a few `task`, `compaction`, and `memory` keys. Apply them with `./install.sh --config`, or merge `config/config.snippet.yml` by hand.

## modelRoles

```type-table
# modelRoles
default | chain | (main agent) | Fallback chain for the main agent.
smol | chain | (scouts) | Cheap scouts: david-research, explore, librarian.
slow | chain | (reviewer tier) | The reviewer tier and the review judge.
plan | chain | (genius) | The genius chain for planner and deep-debugger.
task | chain | (workers) | Fallback chain for the mechanical task worker.
advisor | chain | | Advisor genius chain.
designer | chain | (pi/designer) | The designer agent's chain for frontend build, review, and fix.
plato | chain | (loud-fail if unset) | Ultra seat: chief architect and final consolidator.
aristotle | chain | (loud-fail if unset) | Ultra seat: challenger.
taskpool | pool | default pair | Load-balancing pool for task builders, fixers, and verifiers.
reviewers | diversity set | default pair | Reviewer models that alternate across the review lenses.
```

## task, compaction, memory

```type-table
# task / compaction / memory
task.maxRecursionDepth | number | 2 | Set to 3. Depth cap for subagent spawns; 3 keeps ad-hoc escalation's scouts alive.
task.softRequestBudget | number | 90 | Set to 250. Requests before wrap-up; hard-abort at 1.5x.
task.softRequestBudgetNotice | boolean | false | Set to true, so children get a wrap-up warning instead of a silent kill.
compaction.strategy | string | | Use snapcompact (needs omp >= 16.2.8); older builds should use shake.
memory.backend | string | | local captures consolidated Lessons into per-repo memory.
```

The installer's `--config` applies `modelRoles`, `task.maxRecursionDepth`, `task.softRequestBudget`, and `task.softRequestBudgetNotice`. The `compaction` and `memory` keys are not auto-applied; merge them from the snippet if you want them.

## Chain versus pool versus diversity set

These three read differently.

- **A role is a fallback chain.** Entries are tried in order and the first resolvable model wins. There is no rotation. `default`, `smol`, `slow`, `plan`, `task`, `advisor`, `designer`, `plato`, and `aristotle` are all chains.
- **`taskpool` is a pool.** The pipeline round-robins and health-checks each entry per provider to load-balance across subscriptions. Entries are single model patterns; weight one by repeating it; `[]` disables pooling; omitting the key uses the default. See [Load balancing](/guides/load-balancing).
- **`reviewers` is a diversity set.** Entries alternate across the review lenses (model index `i % len`) so different lenses get different eyes. An entry may itself be a comma-joined chain, but the list as a whole is not a fallback chain.

> [!WARNING]
> Chains ship as YAML lists and require omp >= 16.3.7. On older builds, flatten each list to one comma-separated string. The semantics are identical. See [Installation](/getting-started/installation).
