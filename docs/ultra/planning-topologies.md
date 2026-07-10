---
title: Planning topologies
order: 2
description: Crossreview, Duel, and Debate
---

# Planning topologies

The ultra planner has three topologies, selected by the first word of the command arguments. The default is `duel`. If the first word is not a topology name, it is treated as part of the task.

| Topology | Genius calls | Flow | Use when |
|---|---|---|---|
| `crossreview` | 3 | plato plans, aristotle red-teams it, plato revises its own plan | cheapest sanity check on a single strong plan |
| `duel` | 5 | both plan blind in parallel, each red-teams the rival's plan, plato synthesizes | you want two genuinely independent takes reconciled |
| `debate` | 7 | duel through the critiques, then one revision round (each revises its own plan given the rival plus the critique it received), plato synthesizes | highest-stakes plans worth a full argue-and-refine |

## crossreview (3 calls)

The cheapest topology. `plato` produces a plan, `aristotle` red-teams it, and `plato` revises its own plan to address every valid critique point. One strong author, one challenge, one revision.

## duel (5 calls)

`plato` and `aristotle` plan **blind** in parallel, neither seeing the other's work. Then each red-teams the rival's plan in parallel (`plato` critiques aristotle's plan and vice versa). Finally `plato` synthesizes THE plan from both plans and both critiques. This is the default.

## debate (7 calls)

Everything duel does through the cross-critiques, then exactly one revision round. Each genius revises its **own** plan given the rival's plan and the critique it received, stealing the rival's best ideas. Then `plato` synthesizes from the two revised plans plus both critiques. The revision round is hard-capped at one; there are no convergence loops.

## Synthesis

Every topology ends with `plato` as the sole owner of the final plan. Synthesis is never a committee merge. `plato` adopts the strongest elements, discards the rest, and records in the plan `notes` exactly what it took from the aristotle plan or critique and what it rejected and why.

> [!NOTE]
> The topology controls the **planning** shape only. Ultra review is always a fixed duel regardless of the planning topology. See [Ultra review](/ultra/review).
