---
title: Planning
order: 2
description: Planner Modes and Plan Schema
---

# Planning

## Modes

The `planner` agent is a genius architect with three modes. The pipeline picks the mode by what it asks for.

- **CLARIFY.** Explore the task via cheap subagents, then return a dependency-ordered list of clarifying questions, each with a recommended answer the planner derived from the code. It answers from the code whatever the code can answer and only asks what it genuinely cannot. This produces questions, not a plan.
- **PLAN.** The default. Return a concrete execution plan matching the schema below.
- **CONSULT.** An implementer is stuck on a design question mid-build. The planner is handed the plan, the piece, what was tried, and the precise question, and it adjudicates. It clarifies intent, adjusts the piece, or descopes it, and returns actionable guidance, not a new plan.

The planner never greps or browses itself. It offloads all fact-finding to cheap subagents (`david-research` for external docs and web, `scout` for the local codebase, `librarian` for library and API source) and reasons over their summaries.

## Plan schema

PLAN mode returns an object matching `PLAN_SCHEMA`.

```type-table
# Plan
mode | "sequential" \| "parallel" | (required) | sequential = one implementer does all pieces in order; parallel = pieces run concurrently.
overlap | boolean | (required) | Parallel only. true if pieces may edit the SAME files (isolated worktrees plus serial synthesis); false if they touch disjoint files.
pieces | Piece[] | (required) | Ordered, self-contained units of work. At least one, even for sequential plans.
review_lenses | string[] | (required) | Review focuses to fan out, e.g. correctness, security, edge-cases, design.
notes | string | (required) | Sequencing constraints plus synthesis and verification guidance.
```

Each piece is a small object.

```type-table
# Piece
id | string | (required) | Stable short id, e.g. p1.
description | string | (required) | Complete standalone instruction for this piece's implementer.
agent | "task" \| "deep-debugger" \| "designer" | (required) | Which agent builds the piece.
```

## Per-piece agent

The planner tags each piece with the agent that should build it. This is the build-time routing decision, a semantic call the planner makes.

- **task** for mechanical work: backend, API, data, build config.
- **designer** when the piece's primary deliverable is user-facing UI: building frontend from scratch, modifying it, or improving it (components, styling, layout, UX flows, client-side interactivity). The planner prefers splitting a half-UI, half-backend piece into a `designer` piece plus a `task` piece when both are substantial, otherwise it tags by the dominant surface. See [Frontend and design](/guides/frontend-and-design).
- **deep-debugger** only when the piece is expected to need hard diagnosis before any implementation.

## Approval gate

Interactive runs pause here. Auto runs skip straight to execution.

The main agent opens the dashboard, presents the plan in chat (shape, pieces, lenses, notes), and iterates with you. You can give feedback (which re-runs the planner with your feedback folded in, or patches pieces directly), or you can edit the JSON in the dashboard file yourself and say "re-read" to have the run reload your edits.

Nothing builds until you approve. On approval the run records the approval state, stamps the time, sets the status to `building`, and only then starts Cell 2.
