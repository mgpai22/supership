---
title: Review
order: 4
description: The Review Loop Engine
---

# Review

Review is the shared `run_review_loop()` engine. The pipeline and the standalone `/superreview` command both drive this exact function, so an improvement to the review engine lands in both at once. The loop mutates the run state and the working tree, and the caller consolidates afterward.

## Lenses

The loop reviews per lens. It starts from the plan's `review_lenses` (default `correctness`, `security`, `edge-cases`, `design`), then always appends a standing **over-engineering** lens (the ponytail rubric). If frontend changed, it also appends a **design** lens. See [Frontend and design](/guides/frontend-and-design).

## Round by round

Each round runs this sequence. Everything after the reviewers is shared between the normal path and the [ultra path](/ultra/review).

1. **Reviewers fan out per lens.** Each lens gets a `deep-reviewer` running a model drawn from the `modelRoles.reviewers` diversity set (entries alternate across lenses so different lenses get different eyes). The `design` lens goes to the `designer` agent instead. `deep-reviewer` carries no native output schema, so the call-site findings schema applies cleanly, which sidesteps an intermittent schema violation with omp's bundled reviewer (oh-my-pi #3926).
2. **The judge keeps the real findings.** A `completion(model="slow")` judge rules on each finding and drops nits, dupes, and false positives, then emits a per-lens verdict (`clean` or `issues_remain`).
3. **The numeric gate.** Only actionable, high-confidence defects pass: `priority <= 1` and `confidence >= 0.6`. The count that survives this gate is recorded as `kept`.
4. **The refute-verifier gates the fixers.** The judge rules on the finding *text*, never the code, so a plausible-but-wrong finding can survive. To close that gap, each kept finding is handed to a per-finding verifier (`task` agent) that tries to *disprove* it against the actual code. A finding is dropped unless it comes back confirmed with concrete evidence (`file:line` plus why it is a real defect). The gate is **fail-open**. A verifier that errors keeps its finding, so infra noise never silently drops a real bug. The `verify_findings` knob (default on) disables it. The count that survives verification is recorded as `confirmed`.
5. **Fixers apply the confirmed findings.** Findings are grouped by file and fixed in parallel across distinct files. A fix on a frontend file routes to the `designer`; everything else goes through the task pool.
6. **Re-review.** Fixes land on the shared tree so they accumulate, and the next round re-reviews them.

## Exit conditions

Each round records `found` (raw reviewer findings), `kept` (after the numeric gate), `confirmed` (after verification), and the per-lens verdicts, all in the dashboard.

The loop exits when any of these is true.

- A round finds nothing, or a round confirms nothing (everything was refuted). Both count as clean.
- The round count hits `MAX_ROUNDS` (default 3) with findings still open.
- The remaining budget drops below the reserve floor (checked at the top of each round).

An all-refuted round counting as clean is deliberate. It means the reviewers raised only things the verifier could not stand up against the real code.
