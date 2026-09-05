---
title: Configuration
order: 2
description: OMP model configuration and repository policy.
---

# Configuration

Keep OMP configuration separate from Supership repository policy. `config/` contains examples. OMP does not load this directory automatically. The `.omp/` development model assignments in this repository are not product defaults.

## OMP models

`config/config.snippet.yml` shows logical `task.agentModelOverrides` for the three package personas, reusable agent instructions. Merge only the configuration you choose into the intended OMP configuration layer. Never replace an existing user configuration wholesale.

The architect defaults to `@plan`. The critic and judge default to `@slow`. Configure those roles or explicit models from your available catalog.

A `modelRoles` string/list expresses ordered resolution, the sequence for model selection. It does not distribute requests or prove that a provider request succeeds. A provider supplies model responses. Custom aliases, alternative model names, must resolve. Runtime fallback, an alternative after failure, needs an explicit declared policy.

`config/modelRoles.json` is an empty, provider-neutral role map. It no longer carries subscriptions, fixed model IDs, a task pool, or reviewer rotation. The installer does not apply it to global configuration.

## Repository policy

The extension reads `.omp/supership.json` as a strict versioned `PolicyOverlay`. An overlay adds repository rules to the workflow. `config/supership.example.json` is a neutral example. It does not replace required repository rules.

| Field | Meaning |
|---|---|
| `schemaVersion` | Supported policy contract version. Unknown versions fail before effects. |
| `seats` | A seat assigns an agent and model through `seatId`, `agentName`, optional `model` and `sourcePath`. |
| `namedFallbackSeats` | Explicit fallback seat IDs for each seat. |
| `limits` | Optional `concurrency`, `tokens`, `cost: {amount, currency}`, `wallMs`, and `reviewRounds`. |
| `requiredLenses` | A lens selects a review topic. This field adds mandatory topics. |
| `verificationChecks` | Repository commands/scenarios and their path scope. |
| `requiredVerification` | Requirements contain an ID, description, path scope, instructions, and source references. For each applicable ID and scope, the plan supplies executable steps to make sure that the requirement passes. Empty scope applies to every plan. Nonempty scope applies when it overlaps the plan paths. |
| `phaseGates` | Required approval, consultation, verification, dependency, or restriction rules. |
| `pathRouting` | Named path-to-seat rules with reasons and evidence. |
| `instructionRefs` | Evidence references to applicable repository instructions. |

Policy overlays do not install command copies or grant broader shell permissions. Migration preserves these repository requirements:

- Owner routing assigns work to the required agent.
- Contract-before-consumer dependencies place interface changes before their callers.
- Specialist consultations retain required expert input.
- Required lenses retain mandatory review topics.
- Path checks retain requirements for specific files.
- Commit consent retains user approval.
- Secret exclusions keep credentials outside output.
- Migration rules preserve installation constraints.
- Independent local commands retain their ownership.

Structured verification scenarios include executable `operations`, not only descriptive `steps`. Verification establishes whether requirements pass. Operations can issue commands or control a browser. Browser actions include open, click, fill, text assertion, screenshot, and close.

A manual requirement belongs in `requiredVerification` until the plan supplies executable steps to make sure that it passes. Prose alone cannot pass verification.

## Invocation choices

For an explicit model assignment within one run, use `--seat seat=model`. The extension also accepts `--concurrency`, `--tokens`, `--cost`, `--wall-ms`, and `--review-rounds`. It records the resolved choices with the run.

No new finite token, cost, time, or round cap applies by default. Tokens are units of model input and output. Live OMP concurrency, the number of simultaneous tasks, remains the upper bound.

Interactive planning asks about unspecified limits. Autonomous runs use configured defaults. Limits pause work instead of declaring success. Unknown pricing stays unknown. Already active requests can exceed a measured budget.

OMP `task.maxConcurrency: 0` means unlimited. Supership records that ceiling as `null`, not zero. An explicit finite run concurrency limit still applies.

Cost limits use USD. If prices or child observations are incomplete, the recorded priced subtotal is a lower bound. Supership pauses when that known subtotal reaches the cost limit. Unknown cost does not become free.

Token counts include observed child messages. Missing or partial observations remain visible as incomplete coverage. These counters do not establish final invoice totals.

If combined counters reach their numeric limits, the dashboard marks them as saturated lower bounds, minimum values beyond counter capacity. Individual usage sources remain recorded. A saturated cost overshoot is an observed minimum. It is not an exact invoice amount.

The workflow does not enable persistent memory writes, change `prewalk` configuration, or raise global concurrency. It does not weaken OMP approvals in autonomous mode.
