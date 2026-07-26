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
smol | chain | (scouts) | Cheap scouts: david-research, scout, librarian.
slow | chain | (genius anchor) | The genius tier. Anchored once (`&genius`) and shared by plan, advisor, and reviewers.
plan | chain | *genius | Alias of slow via YAML anchor; drives planner and deep-debugger (`@plan`/`@slow` in their frontmatter).
task | chain | (workers) | Fallback chain for the mechanical task worker.
vision | chain | | Image reads for text models and screenshot verification.
tiny | chain | (cheap anchor) | Session titles and classifiers. Anchored (`&tiny`) and shared by commit.
commit | chain | *tiny | Alias of tiny via YAML anchor; commit messages and changelogs.
advisor | chain | *genius | Advisor rides the genius anchor.
designer | chain | (@designer) | The designer agent's chain for frontend build, review, and fix.
plato | chain | (loud-fail if unset) | Ultra seat: chief architect and final consolidator.
aristotle | chain | (loud-fail if unset) | Ultra seat: challenger.
taskpool | pool | default trio | Load-balancing pool for task builders, fixers, and verifiers.
reviewers | diversity set | *genius | Reviewer models that alternate across the review lenses. An anchor to a concrete list is fine; it expands at parse time.
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

- **A role is a fallback chain.** Entries are tried in order and the first resolvable model wins. There is no rotation. `default`, `smol`, `slow`, `plan`, `task`, `vision`, `tiny`, `commit`, `advisor`, `designer`, `plato`, and `aristotle` are all chains.
- **`taskpool` is a pool.** The pipeline round-robins and health-checks each entry per provider to load-balance across subscriptions. Entries are single model patterns; weight one by repeating it; `[]` disables pooling; omitting the key uses the default. See [Load balancing](/guides/load-balancing).
- **`reviewers` is a diversity set.** Entries alternate across the review lenses (model index `i % len`) so different lenses get different eyes. An entry may itself be a comma-joined chain, but the list as a whole is not a fallback chain.

## Sharing a list across roles

Use plain YAML anchors, the way the snippet does: define the list once (`slow: &genius`) and reference it elsewhere (`plan: *genius`). Anchors expand when the file is parsed, so omp and this kit's raw config reads always see concrete lists.

Do **not** use `@role` strings as role values instead. A bare `@` is a YAML reserved character and breaks the whole config file (omp silently loads an empty config), and even quoted `"@role"` values expand only one level in several of omp's resolver paths, so alias-of-alias roles fail to resolve. Anchors sidestep both problems.

> [!WARNING]
> Chains ship as YAML lists and require omp >= 16.3.7. On older builds, flatten each list to one comma-separated string. The semantics are identical. See [Installation](/getting-started/installation).
