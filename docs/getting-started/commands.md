---
title: Commands
order: 3
description: Five command names use one engine.
---

# Commands

| Command | Behavior |
|---|---|
| `/supership <task>` | The interactive workflow interviews, researches, plans, builds, reviews, fixes, and establishes whether requirements pass. |
| `/shipit <task>` | Same execution without the interview or ordinary plan/amendment approval gates. |
| `/ultraship [topology] <task>` | Interactive flow with two planning seats and two review judges. |
| `/ultrashipit [topology] <task>` | Autonomous ultra flow with the same review and safety requirements. |
| `/superreview [--base <ref>] [--slug <slug>] [intent]` | Local-diff review/fix, always ultra, without a normal planning/build interview. |
| `<command> resume [slug]` | The engine reconciles recorded and observed work before it resumes through trusted OMP controls. |

An ultra topology is the order of planning calls. It is `crossreview`, `duel`, or `debate`. The default is `duel`. A first word that is not a topology remains part of the task.

## Autonomous does not mean unapproved effects

Interactive users approve plans and material amendments through the OMP TUI, a terminal user interface. Autonomous runs record ordinary plan and amendment decisions without those approval steps.

Both modes pause for these conditions:

- Judges disagree.
- Work stalls.
- Work reaches a limit.
- Ownership is unsafe.
- Recovery remains unresolved.

Destructive, public, credential, and production actions retain OMP approvals in every mode. Commit and push are opt-in. Push needs a final confirmation that shows the remote, branch, and exact commits.

Supership refuses startup in OMP Plan Mode and supports Code Mode. One OMP session can own one active run. Separate sessions can own separate runs in the same repository, subject to locks and write-conflict checks.

## Resume

Resume reads `state.json` and `events.jsonl`. It reconciles active owners and observed results before new work. A process-local handle, a reference valid within one process, does not prove completion. Neither does the HTML dashboard.

If recovery is ambiguous, the user must decide through the TUI. Old HTML-only runs remain readable but cannot resume.

## Optional invocation flags

`--base`, `--slug`, `--branch`, `--commit`, `--push`, and `--topology` select scope and output choices. `--resume [slug]` also requests resume.

For an explicit model assignment within one run, use `--seat seat=model`. For limits, use `--concurrency`, `--tokens`, `--cost`, `--wall-ms`, or `--review-rounds`. No flag bypasses a required safety or recovery decision.
