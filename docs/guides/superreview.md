---
title: Standalone review
order: 1
description: Local review and fixes with two independent judges.
---

# Standalone review

`/superreview` uses the shared review/fix engine against local changes. It always uses ultra review with risk-selected reviewers and two independent judges. It skips the normal plan/build interview. It retains safety approvals, disagreement pauses, and recovery decisions.

```text
/superreview [--base <ref>] [--slug <slug>] [free-text intent]
/superreview resume [slug]
```

## Scope

An explicit `--base` determines the review scope. Otherwise, dirty tracked, staged, and untracked changes form the review target. Dirty tracked files contain uncommitted changes. Staged changes belong to the next proposed commit. Untracked files have no Git record.

On a clean checkout, the engine makes sure that it can establish the default-branch merge base. The merge base is the shared ancestor with that branch. The engine uses it as the review target.

If the repository has no meaningful base, the run reports an empty or ambiguous scope. Examples include a first commit or missing refs, names that identify Git objects. The engine does not fabricate `HEAD~1`. Review rounds retain the chosen scope so fixes do not shift the target.

The free-text intent explains the required behavior and exclusions. Review-only records which existing changes it can fix. Those changes remain user-owned for staging and publication. Permission to repair a defect does not authorize commits of all pre-existing content.

## Findings and recovery

The run records review rounds, both judge decisions, findings, fixes, and verification in versioned state and events. Verification establishes whether requirements pass. `plan.html` shows these records read-only.

Resume reconciles owners and effects before new work. Reconciliation compares recorded and observed work.

This command reviews local changes only. It does not fetch pull requests, open pull requests, or publish review comments. See [Review](/docs/pipeline/review) for stalls, round limits, and completion rules.
