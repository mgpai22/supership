---
title: Overview
order: 1
description: The OMP 18 workflow and its safety boundaries.
---

# Overview

Supership adds a guided coding process to Oh My Pi (OMP).

The extension stores workflow state, the recorded progress and decisions. The main OMP agent does task and JavaScript eval actions in its session. Eval means code evaluation within a persistent session.

Offline verification passed with compiled and official npm OMP 18.1.17. See [Architecture](/docs/reference/architecture#verification-limits) for evidence and limits.

Offline scripts do not establish the quality of real-model judgments.

## Workflow

1. At startup, Supership makes sure that Linux, Git, OMP capabilities, Plan Mode, ownership, and required seats meet its requirements. A seat assigns an agent and model.
2. Interactive runs clarify scope and limits before plan approval through the OMP TUI, a terminal user interface.
3. Scouts, agents that collect evidence, supply research to one architect or two independent ultra planning seats.
4. Workers build dependency-ready items. The engine prevents concurrent overlapping writes.
5. Fresh reviewers and judges make sure that evidence supports each finding. Fixes repeat until review and verification meet the plan.
6. Optional commits and publication retain separate consent requirements. Conclusions and lessons remain run-local.

A justified no-change result is valid. Trivial work can use a recorded single-worker path. Interactive mode requires approval for that reduction. Autonomous mode chooses it without dropping verification, the process that establishes whether requirements pass.

## State and controls

The engine stores `state.json` and `events.jsonl` under `.planning/<slug>/`. It replaces state snapshots atomically, so readers receive a complete version. It only appends events to the log.

The generated `plan.html` is a read-only HTML page. Changes to HTML cannot approve plans or change state. Old HTML-only runs cannot resume.

Use [Commands](/docs/getting-started/commands), [Installation](/docs/getting-started/installation), and [Recovery](/docs/guides/resume-and-recovery) for operating details.

## Illustrative dashboard

`examples/demo-plan.html` shows a fixed paused test example. It includes unknown pricing, unavailable evidence, and recovery of parent tools. It is not a real run or acceptance proof.

The native `scripts/demo.ts` reads the versioned `examples/demo-state.json`. It makes sure that the data matches the required structure. The production renderer converts it to HTML on stdout, the standard output stream.

```sh
bun scripts/demo.ts
```

To refresh the stored example, redirect that output to `examples/demo-plan.html`. CAUTION: This command replaces the generated example. It never extracts executable code from Markdown.
