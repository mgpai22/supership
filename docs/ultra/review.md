---
title: Ultra review
order: 3
description: The Genius Review Duel
---

# Ultra review

Ultra runs review genius-tier too. Each review round is a fixed duel of the same two seats read from the frozen run state.

## The duel

1. **Blind review.** `plato` and `aristotle` each review the diff blind, in parallel. This is one holistic pass covering **all** lenses at once. The lenses become a rubric rather than a per-lens genius fan-out, which would blow up cost. The persona stays `deep-reviewer` (for the clean call-site schema); only the model is the genius chain.
2. **Cross red-team.** Each seat red-teams the *rival's* findings against the actual code, adversarially, with concrete evidence.
3. **Synthesis.** `plato` synthesizes the final kept set as sole owner, plus a verdict per lens. It keeps only findings that survived the cross-red-team with evidence and drops nits, dupes, and false positives.

## Subsuming the verifier

In the normal loop, a per-finding refute-verifier gates the fixers. In an ultra round there is no separate verify pass. The cross-red-team already tried to knock each finding down, so the synthesis output *is* the confirmed set. Kept equals confirmed with no task-tier verify spawns.

The synthesis output still passes through the same numeric gate (`priority <= 1`, `confidence >= 0.6`) as the normal path.

## A fixed shape

Ultra review is always a duel, regardless of the planning topology. Crossreview and debate do not map to review. You do not "revise a review"; you re-review after fixes, which the outer round loop already does. Cost is bounded to roughly five genius calls per round, with an early exit on a clean round and a cap at `MAX_ROUNDS`.

## Shared back half

Ultra swaps only the front half of `run_review_loop`. The reviewer fan-out plus the judge are replaced by the genius duel of `ultra_review_round()`. Everything after "here are the confirmed findings" is the **identical code** the normal loop runs: the numeric gate, the fixers, the round loop, `MAX_ROUNDS`, the budget gate, clean detection, and the `found` / `kept` / `confirmed` dashboard records. Normal `/supership` runs are byte-for-byte unaffected.

> [!INFO]
> Ultra review rides the same `ULTRA` flag as ultra planning. There is no new config and no new command. You cannot get ultra review on a normally-planned run, which is an accepted non-goal. The one exception is [`/superreview`](/guides/superreview), which is always ultra.
