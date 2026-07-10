---
title: Overview
order: 1
description: The two genius seats, chain resolution, plan-time freezing, and loud-fail.
---

# Ultra mode

The base pipeline plans with a single genius. The ultra variants (`/ultraship`, `/ultrashipit`) run the **exact same pipeline** but replace that one planner with two genius seats that debate the plan before anything builds, then hand the agreed plan to the unchanged execute-and-consolidate machinery. Ultra reviews genius-tier too.

## The two seats

Both are model-role seats you configure in `modelRoles`.

- **`plato`** is the chief architect and final consolidator. It always owns THE plan.
- **`aristotle`** is the challenger. It red-teams and never rubber-stamps. It's better to use a different model for this.

## Why the pipeline resolves the chains itself

omp's `pi/<role>` alias resolver is hard-gated to built-in role names (verified through omp 16.3.15). A custom role like `pi/plato` passes through unresolved, and omp then *silently* spawns an undefined-model session, discarding the error.

So the pipeline does not rely on the alias. Cell 1 reads `modelRoles` from config itself, normalizes each chain to a comma-joined fallback string, and passes it via `model=`. A call-site `model=` overrides the planner agent's own frontmatter chain, so the geniuses you configured are the ones that run.

## Plan-time freezing

The two resolved chains are frozen into the run state at plan time, stored in `meta.ultra` alongside the topology. Editing `modelRoles` mid-run does not retarget an in-flight or resumed run. The review stage reads the seats from that frozen state, not live config, so a resumed run keeps its ultra identity and reviews with the same brains that planned. Plan-time identity is deliberate.

## Loud-fail

Ultra refuses to degrade to a single genius. Cell 1 asserts that both `plato` and `aristotle` are configured and non-empty. If either is unset, the run fails loud rather than quietly planning with one seat.

## Fresh-eyes consult

In an ultra run, a `design` escalation from a stuck builder is re-adjudicated by the challenger (`aristotle`), not the plan's author. The model that red-teamed the plan is best placed to reopen it. `bug` escalations still go to `deep-debugger`.

## Where to go next

- [Planning topologies](/ultra/planning-topologies) covers crossreview, duel, and debate.
- [Ultra review](/ultra/review) covers the genius review duel.
