---
title: Standalone review
order: 1
description: Standalone Always-ultra Review
---

# Standalone review

`/supership` reviews as the last stage of a full plan-build-review run. `/superreview` peels that review stage off into a standalone command you point at any local changes: a diff you wrote by hand, or the output of a previous supership run you want a second, harder pass on.

It runs the **exact same engine**, the shared `run_review_loop()`, seeded with a review-only state and no plan or build. There is no clarify and no approval gate.

```
/superreview [--base <ref>] [--slug <slug>] [free-text intent...]
```

## Always ultra

`/superreview` is always the `plato` and `aristotle` genius duel. There is no normal-tier or lite mode; that is `/supership`'s inline review. The seats are resolved live from config at review start (there is no plan to freeze them) and frozen into this run's state, and the run loud-fails if either seat is unset. It reuses the `plato` and `aristotle` keys, so there is no new config.

## Diff-target detection

The command decides what to review before authoring the cell, in this order.

1. It must be a git repo, or there is nothing to review.
2. If `--base <ref>` was given, review the range since that ref.
3. Otherwise, if the working tree is dirty (any uncommitted or untracked files), review the working tree. This is the "I just made changes" or "I just ran supership" case.
4. Otherwise (clean tree), review the current branch against its merge-base with the default branch. The default branch is the basename of `origin/HEAD` (falling back to `main`, then `master`, then `HEAD~1`).

Re-review always diffs the same fixed base, so fixes accumulate across rounds rather than shifting the target under you.

## Intent

The free-text argument is what the change is meant to do, plus any scope or non-goals (for example, "tightening the auth refactor; ignore vendored/"). Omit it and the reviewers infer intent from the diff plus recent commit messages. There is no plan to anchor scope, so reviewers lean toward defects in what changed.

## Dashboard and resume

`/superreview` writes a `.planning/review-<MMDD-HHMM>/plan.html` dashboard (override the slug with `--slug`), the same live UX as the pipeline: rounds, findings, and verdicts. It fixes on the shared tree (the full review, fix, and re-verify loop, not just a report). It is resumable via `/superreview resume`, which re-enters the loop against the original base, continues the round count from the file, and preserves fixes already applied.

Because it shares `run_review_loop()` with the pipeline, the frontend design lens and the `is_frontend` fix routing apply here too. See [Frontend and design](/guides/frontend-and-design).

## Local only

`/superreview` reviews the local working tree only. There is no PR or GitHub integration. For GitHub PR review, use the built-in `/code-review` or `/review`.
