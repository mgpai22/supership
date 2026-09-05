---
title: Review
order: 4
description: Fresh review rounds and explicit decisions.
---

# Review

Normal review uses risk-selected reviewers and one judge. Ultra review uses the same reviewer lenses, specific review topics, and two independent judges. `/superreview` uses the ultra review path.

## Review round

1. Start fresh reviewers for the mandatory correctness and simplicity lenses, plus risk-selected and repository-required lenses.
2. Require evidence, impact, and a fix target for every finding.
3. Start fresh judges. Preserve accepted, rejected, deferred, and duplicate verdicts with reasons.
4. Fix accepted findings within the approved scope and ownership boundaries.
5. Re-review the changed code. Attach applicable verification evidence.

WorkPool, a scheduler for repeated independent tasks, permits reuse only within one lens and one round. Prior findings enter a new round as explicit evidence. They do not enter as hidden conversation history. Neither confidence thresholds nor a worker assertion can hide an unresolved accepted finding.

## When review pauses

Review rounds are unlimited by default. An optional round cap pauses work and requests a decision. It does not mean success. Token, cost, and time limits also pause work that can later resume. Tokens are units of model input and output.

Two rounds with repeated finding fingerprints and no relevant code progress trigger a stall pause. A fingerprint identifies the same finding across rounds.

The OMP TUI preserves the findings and offers reviewer changes, an explicit reasoned override, or stop. TUI means terminal user interface.

Unless the user later authorizes a different disagreement policy, ultra judge disagreement pauses work in every mode. Both arguments remain visible. The engine does not invent a tie-breaker model.

## Completion

Accepted unresolved findings cannot disappear behind a completed status. Required reviews, fixes, and plan checks must reach their explicit outcome. The engine makes sure that the combined result meets the requirements. Evidence from an older code version does not prove the final version.
