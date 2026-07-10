---
title: Consolidate
order: 5
description: Final dashboard state, Lessons, ponytail-debt harvest, and per-repo memory.
---

# Consolidate

The last stage closes out the run. Cell 2 sets the run status to `done`, saves the dashboard (which stops its live refresh), and prints a summary: the plan shape, each piece's status, the review rounds, the unresolved list, and whether the run ended clean.

A run counts as **clean** when the last review round confirmed nothing and there are no unresolved pieces. A round whose findings were all refuted also breaks clean.

## Lessons

After Cell 2 returns, the main agent writes a `## Lessons` section for you: recurring mistakes, dead-ends, and gotchas seen across planning, building, and review.

## Debt Harvest (powered by [ponytail skill](https://github.com/DietrichGebert/ponytail))

The build prompts encourage marking deliberate shortcuts with a `// ponytail:` comment naming the ceiling and the upgrade path. Consolidation harvests them by grepping the diff and the touched files for `ponytail:` markers, then lists each one with its ceiling and upgrade path under a `## Ponytail debt` heading.

## Patching the artifact

Both writeups are patched back into the dashboard with a small eval so the artifact is complete and self-contained.

```py
S = load_state()
S["lessons"] = """..."""
S["ponytail_debt"] = ["file:line (marker text)", ...]
save_state(S)
```

The main agent then points you at `.planning/<slug>/plan.html` for the final render.

## Per-repo memory

With `memory.backend: local`, omp captures the consolidated lessons into per-repo memory, so they carry into future sessions in the same repo. The dashboard is the artifact for this run; memory is what carries the learning forward.
