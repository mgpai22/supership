---
title: Agents
order: 1
description: Three package personas and reused OMP workers.
---

# Agents

The package supplies exactly three personas, reusable agent instructions, under root `agents/`. Their model roles do not require a specific provider. A provider supplies model responses. The files contain no embedded task-specific output schema, the required result structure.

- `supership-architect` uses `@plan` for plans, revisions, synthesis, and design advice.
- `supership-critic` uses `@slow` for blind alternatives, critiques, and own-plan revisions.
- `supership-judge` uses `@slow` for independent evidence-based finding decisions.

OMP supplies `scout`, `reviewer`, `security-reviewer`, `task`, and `sonic`. Supership reuses their existing bodies with explicit per-invocation assignments and strict schemas. It does not install duplicate planner or task definitions.

## Seat resolution

A logical seat records its base agent, model assignment, source, and declared fallbacks, alternatives after failure. OMP resolves each exact agent name in this order:

1. Project agents take precedence.
2. User agents come next.
3. Extension-package agents follow.
4. Bundled agents come last.

Source mappings must identify explicit roots that discovery cannot otherwise find. The engine must not silently replace an unavailable specialist with a bundled definition.

Model selection uses OMP frontmatter, metadata at the start of an agent file. It also uses role aliases, `task.agentModelOverrides`, and explicit seat assignments within a run. An alias provides an alternative model name.

Package definitions contain no provider/model IDs. Overrides within one run do not change global configuration or sibling sessions.

## Output and permissions

The runtime provides a strict versioned schema for each task. Submit the final result with native top-level yield according to the shown tool schema. On OMP 18.1.10, an eval-bridged yield cannot finalize a child. Eval means code evaluation within a persistent session.

Free prose, Markdown outside declared fields, or fenced JSON cannot replace a valid result.

Personas cannot approve their own work, change engine state, or register worker-owned dynamic tools. They can propose tools for review by the orchestrator, the agent that coordinates work.

Granted callbacks, functions that another task invokes, operate in the parent kernel, the persistent JavaScript environment. This applies even when the worker uses a worktree, a separate repository working copy.

## Discovery and preserved legacy sources

OMP scans `<package-root>/agents/*.md`. The `omp` package manifest has an `extensions` field but no agent-path field. A manifest declares package resources. Root `agents/` therefore contains the only authored roster. No wildcard points at `omp/agents`.

The old `omp/agents`, `omp/commands`, `omp/templates`, and `omp/APPEND_SYSTEM.md` remain preserved source until approved migration. The package does not register them.

Existing installed copies can still take precedence over commands until approved migration removes their active ownership. Do not copy the legacy tree into a new installation.

A linked canonical checkout, the primary repository copy, can expose unchanged root `skills/ax` and `skills/grill` through OMP resource discovery. The package file list does not restrict a live symlink, a pointer to another filesystem location.

These optional skills do not add command owners or persona bodies. The installer does not copy them into shared user directories.
