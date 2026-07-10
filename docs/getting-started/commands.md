---
title: Commands
order: 3
description: Every command and its one-line behavior.
---

# Commands

| Command | Behavior |
|---|---|
| `/supership <task>` | Interactive. Clarify interview, plan, approval gate, build, review loop, consolidate. |
| `/shipit <task>` | Autonomous. The same pipeline with no interview and no gate, run end to end. |
| `/ultraship [topo] <task>` | Interactive, dual-genius. Two genius seats (`plato` + `aristotle`) debate the plan and review genius-tier. |
| `/ultrashipit [topo] <task>` | Autonomous dual-genius. Same two-planner front end, no interview, no gate. |
| `/superreview [--base <ref>] [intent]` | Standalone genius review-and-fix loop over your current local changes. |
| `<command> resume [slug]` | Re-enter an interrupted run of that command where it left off. |

## Interactive versus auto

The difference between `/supership` and `/shipit` is exactly two things. `/supership` runs the clarify interview and pauses at an approval gate so you refine the plan before anything builds. `/shipit` skips both, treats your raw request as the spec, and runs to completion. Everything after the gate (build, review, consolidate) is identical code. The ultra pair maps the same way, `/ultraship` interactive and `/ultrashipit` autonomous.

The optional topology word (`crossreview`, `duel`, or `debate`) is the first argument to the ultra commands. If the first word is not one of those, the topology defaults to `duel` and the whole argument string is the task. See [Planning topologies](/ultra/planning-topologies).

## Resume

Every command accepts `resume`. Given a slug it uses that run; otherwise it picks the newest `.planning/` dashboard whose status is not `done` or `failed` and re-enters at the right stage based on the stored status. Resume skips pieces already built and continues the review-round count from the file, so it recovers rather than redoes. See [Resume and recovery](/guides/resume-and-recovery).
