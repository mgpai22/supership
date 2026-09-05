---
title: Ultra review
order: 3
description: Risk-selected reviewers and two independent judges.
---

# Ultra review

Each ultra review round starts fresh reviewers for correctness and simplicity. It also includes risk-selected and repository-required lenses, specific review topics. It then starts two independent judge seats, agent and model assignments, against the same findings and evidence.

The judges preserve accepted, rejected, deferred, and duplicate verdicts with reasons. They inspect disputed evidence against code. They do not use the old fixed review duel, numerical confidence filter, or an implicit tie-breaker.

## Disagreement

Disagreement pauses the run and shows both arguments through trusted OMP TUI controls. TUI means terminal user interface.

This rule also applies to autonomous ultra runs and `/superreview` unless the user later authorizes a different disagreement policy.

Neither judge reads the other answer before it submits its own. Reviewers and judges start fresh each round. Prior findings enter as explicit evidence. WorkPool, a scheduler for repeated independent tasks, permits reuse only within one lens and one round.

## Fix and review

The engine fixes accepted findings and reviews the changes again. It makes sure that the combined result meets the requirements. Normal review rules for ownership, strict-schema correction, and recovery also apply. A schema defines the required data structure.

Rounds are unlimited by default. A configured cap pauses work instead of declaring success. Repeated fingerprints without relevant code progress across two rounds cause a stall pause. A fingerprint identifies the same finding across rounds. An accepted unresolved finding cannot disappear from the completion decision.
