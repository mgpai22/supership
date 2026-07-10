---
title: Agents
order: 1
description: The Agent Roster
---

# Agents

The kit ships a roster of global agents. The pipeline spawns them by name via `agent(...)`. Each agent's model comes from its own frontmatter chain, except where the pipeline overrides it with a call-site `model=` (the reviewers and the ultra seats).

| Agent | Model | Purpose |
|---|---|---|
| `planner` | genius chain | Architect. Three modes: CLARIFY (question tree), PLAN (structured plan), CONSULT (adjudicate a stuck builder's design question). Investigates only via cheap subagents; never implements. |
| `task` | `pi/task` (the task pool) | Mechanical worker. Does the actual implementation, offloads research to scouts, and returns a `stuck` signal instead of thrashing. |
| `deep-debugger` | genius chain | Root-cause diagnostician. Read-only; returns the cause plus the exact fix and how to verify. Does not implement. |
| `deep-reviewer` | genius tier, varied per call | Clean reviewer with no native output schema, so call-site schemas apply cleanly. The pipeline overrides its model per lens (reviewers diversity set) and per ultra seat. |
| `designer` | `pi/designer` | UI/UX specialist. Builds, modifies, and improves frontend pieces, reviews the `design` lens, and fixes frontend findings. Design-system-first and accessibility-aware. |
| `david-research` | `pi/smol` | Cheap external research scout (web, docs, repos, APIs). Keeps internet context out of the parent. |
| `review-orchestrator` | genius chain | Legacy manual review-loop orchestrator. Superseded by the in-pipeline `run_review_loop()`; kept for standalone, non-eval use. |

The exact model strings live in the `modelRoles` config and in each agent's frontmatter chain, and both are tunable. See [Configuration](/reference/configuration).

## Bundled omp scouts

The planner and the genius agents also spawn omp's own bundled scouts, which are not part of this kit: `explore` (read-only local codebase scout) and `librarian` (library and API source). Both run on the cheap `smol` role. These keep fact-finding off the expensive genius reasoning.

> [!NOTE]
> Agent selection is an invariant, not a preference. Plan and consult go to `planner`, hard diagnosis to `deep-debugger`, review to `deep-reviewer`, always via an explicit `agent=`. A `role=` string alone never substitutes for `agent=`. See [Resume and recovery](/guides/resume-and-recovery) for why this matters.
