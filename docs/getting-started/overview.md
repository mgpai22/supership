---
title: Overview
order: 1
description: Supership Pipeline and Commands
---

# Overview

supership is a slash-command workflow kit for [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi). It turns a non-trivial coding task into a deterministic, resumable, multi-agent run that you can watch in a live HTML dashboard.

The main agent does not hand orchestration to a nested "manager" agent. Instead it authors and runs `eval` cells (Python on omp's `workflowz` engine, using `agent()`, `parallel()`, and `completion()`) that drive the pipeline in real code with real control flow.

## Pipeline

Every run moves through five stages.

1. **Clarify.** A genius planner builds a dependency-ordered question tree, then the main agent grills you one question at a time until you are aligned. Interactive runs only.
2. **Plan.** The planner returns a structured plan (pieces, execution shape, review lenses) rendered to a `.planning/<slug>/plan.html` dashboard.
3. **Build.** Workers implement each piece, sequentially or in parallel, escalating to the architect or a debugger when stuck.
4. **Review.** Diverse reviewers fan out per lens, a judge keeps the real findings, a verifier refutes the weak ones, fixers apply the rest, and the loop re-reviews until a clean round.
5. **Consolidate.** Final dashboard state, a `## Lessons` writeup, and a debt harvest. omp's per-repo memory carries the lessons forward.

State lives in the dashboard, not in agent memory. The embedded JSON is canonical and every write is code-driven, so the artifact cannot drift and any interrupted run is resumable.

## The command family

- `/supership <task>` runs the full interactive pipeline with a clarify interview and an approval gate.
- `/shipit <task>` runs the same pipeline autonomously, with no interview and no gate.
- `/ultraship` and `/ultrashipit` replace the single planner with two genius seats that debate the plan, and review genius-tier too.
- `/superreview` runs the review-and-fix loop standalone over your current local changes.
- `resume` re-enters any interrupted run where it left off.

See [Commands](/getting-started/commands) for the full table.

```cards
# Installation
Requirements, sharp edges, and the installer.
/getting-started/installation

# How it works
The five stages, the dashboard, and eval cells.
/pipeline/how-it-works

# Ultra mode
Two genius seats debate the plan and the review.
/ultra/overview

# Standalone review
Run the review-and-fix loop over local changes.
/guides/superreview
```
