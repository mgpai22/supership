---
title: Planning
order: 2
description: Evidence, dependencies, paths, and approval.
---

# Planning

Scouts, agents that collect evidence, prepare one cited research packet before planning. Both ultra seats receive that packet. A seat assigns an agent and model. Additional reads fill specific evidence gaps instead of repeating broad research.

The normal architect produces a plan. Ultra uses the selected [three, five, or seven-call graph](/docs/ultra/planning-topologies). The critic can produce an independent plan as well as a critique.

## Plan contract

The runtime supplies a versioned strict schema, the required data structure. A plan describes these items:

- The goal defines the required outcome.
- Dependencies define work that must finish first.
- Expected write paths identify files that can change.
- Outputs define the deliverables.
- Risks identify possible failures.
- Required review lenses define review topics.
- Verification checks establish whether requirements pass.
- Commit groups define related changes for separate commits.

Every dependency must resolve. The dependency graph must contain no cycles, chains that lead back to their starting item.

Correctness and simplicity reviews are mandatory. Security, data, performance, and UI reviews follow the identified risks. Repository policy can require more lenses, specialist consultation, dependencies, and path-specific checks.

The engine rejects overlapping concurrent writes. Dependent or overlapping edits proceed sequentially in the active checkout, the working repository copy.

Independent builders use separate working copies when needed. Before integration, the combination of changes, the engine establishes ownership.

## Limits and small tasks

Interactive planning asks about unspecified concurrency, token, cost, wall-time, and review-round limits. Concurrency is the number of simultaneous tasks. Tokens are units of model input and output. Wall-time is elapsed clock time.

The engine recommends values from the task. Without a credible estimate, it recommends unlimited values. Autonomous runs use configured defaults.

The default adds no finite token, cost, time, or review-round cap. Live OMP concurrency is always the ceiling. An explicit lower run ceiling can reduce it.

A trivial task can use a recorded single-worker path. Interactive mode requires approval for that reduction. The plan still needs applicable verification and recorded evidence.

## Approval and steering

Interactive users approve or edit plans through trusted OMP TUI controls. TUI means terminal user interface. HTML never accepts edits or approvals. Autonomous runs record ordinary plan decisions automatically.

New user instructions enter the event history immediately. The engine supersedes overlapping work, rejects stale results, and replans at a safe boundary. Unrelated workers can continue. Material amendments follow the approval rules of the selected mode. Safety approvals remain in force.
