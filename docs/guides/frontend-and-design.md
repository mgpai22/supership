---
title: Frontend and design
order: 2
description: UI assignments and verification against the actual interface.
---

# Frontend and design

A plan names the UI work, expected paths, repository conventions, and required checks. UI means user interface.

The package reuses OMP workers and available user-configured specialists. It does not install a duplicate designer persona, reusable agent instructions, or fix a model provider. A provider supplies model responses.

Substantial UI and backend work can use separate items after their dependencies finish, if their write paths do not overlap. Backend work changes server behavior. Shared or dependent edits proceed sequentially.

A specialist must resolve before the phase. If that specialist fails, the engine does not silently substitute a weaker seat, an assignment of an agent and model.

UI risk activates the UI review lens, a specific review topic, alongside mandatory correctness and simplicity. Review covers applicable behavior, layout, keyboard access, accessible names, and failure states. Accessible names identify controls for assistive tools. Ultra retains those reviewers and adds two independent judges.

## Verification

Exercise the actual browser, TUI, or CLI that changed. TUI means terminal user interface. CLI means command-line interface. Record the scenario, outcome, relevant screenshot or artifact, and code version. An artifact retains work evidence.

A compilation result does not prove that a user can complete the flow. Compilation translates source code into executable form.

Use the existing repository design system. Operate the repository scripts to make sure that the requirements pass. Do not add a web framework, documentation framework, or generic test stack to provide a workflow dashboard. If the runtime cannot exercise the interface, record that limitation. Do not claim visual verification.

The Supership HTML dashboard is read-only. It has no approval buttons or editable authoritative state. It does not automatically evaluate stored code. Trusted OMP TUI controls handle all decisions that change state.
