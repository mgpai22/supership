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
| `task` | `@task` (the task pool) | Mechanical worker. Does the actual implementation, offloads research to scouts, and returns a `stuck` signal instead of thrashing. |
| `deep-debugger` | genius chain | Root-cause diagnostician. Read-only; returns the cause plus the exact fix and how to verify. Does not implement. |
| `deep-reviewer` | genius tier, varied per call | Clean reviewer with no native output schema, so call-site schemas apply cleanly. The pipeline overrides its model per lens (reviewers diversity set) and per ultra seat. |
| `designer` | `@designer` | UI/UX specialist. Builds, modifies, and improves frontend pieces, reviews the `design` lens, and fixes frontend findings. Design-system-first and accessibility-aware. |
| `david-research` | `@smol` | Cheap external research scout (web, docs, repos, APIs). Keeps internet context out of the parent. |
| `review-orchestrator` | genius chain | Legacy manual review-loop orchestrator. Superseded by the in-pipeline `run_review_loop()`; kept for standalone, non-eval use. |

The exact model strings live in the `modelRoles` config and in each agent's frontmatter chain, and both are tunable. See [Configuration](/reference/configuration).

## Project agents

A repo can vendor its own specialists in `.omp/agents/*.md`. The pipeline discovers them at plan time, adds them to the plan schema's agent choices, and lists each one with its description in the plan prompt, so the planner assigns pieces to them when the work falls squarely in their documented domain. Each runs with its own frontmatter model, skills, and spawn whitelist. Kit personas are excluded from discovery, and a repo without `.omp/agents` gets the base choices unchanged. Project agents do not join the task pool rotation.

## Bundled omp scouts

The planner and the genius agents also spawn omp's own bundled scouts, which are not part of this kit: `scout` (read-only local codebase scout; named `explore` before omp 17) and `librarian` (library and API source). Both run on the cheap `smol` role. These keep fact-finding off the expensive genius reasoning.

> [!NOTE]
> Agent selection is an invariant, not a preference. Plan and consult go to `planner`, hard diagnosis to `deep-debugger`, review to `deep-reviewer`, always via an explicit `agent=`. Persona text in the prompt never substitutes for `agent=` (omp ≥17 removed the task tool's old `role=` field outright). See [Resume and recovery](/guides/resume-and-recovery) for why this matters.
