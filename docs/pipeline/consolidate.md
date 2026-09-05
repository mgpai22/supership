---
title: Consolidate
order: 5
description: Conclusions, owned output, and retained evidence.
---

# Consolidate

A completed run records the plan outcome, review decisions, verification evidence, and lessons for that run. Verification establishes whether requirements pass. A justified no-change result records why the task needs no output. It skips commits.

## Output ownership

Dirty tracked, staged, and untracked changes belong to the user baseline, the repository state before Supership work. Supership does not stage, overwrite, reset, or count them as generated output.

Ownership within one file needs hunk/blob evidence. A hunk is a changed group of lines. A blob identifies complete file content in Git. A filename list is insufficient.

Commit and push require explicit invocation choices. After full review and verification, plan-defined commit groups contain only output with evidence of Supership ownership. If a touched hunk mixes ownership that cannot be separated, the run pauses.

The requested output branch wins. Otherwise the engine uses `supership/<slug>` after plan approval when needed. It never commits to a default branch.

Before a push, approve the remote, branch, and exact commits through the TUI, a terminal user interface. CAUTION: A push publishes those commits. Supership never force-pushes or rewrites shared history.

## Local records and export

`state.json` and `events.jsonl` determine the recorded state. The generated HTML is read-only. Lessons stay within the run. Supership neither writes persistent OMP memory nor creates managed skills automatically.

The CLI, a command-line interface, can create a sanitized Markdown export, text with sensitive details removed. It contains the plan, decisions, findings, and verification. Before sharing, inspect the export. Export does not publish it.

The run retains artifacts, patches, diagnostics, and worktrees after completion or cancellation. Artifacts retain work evidence. A worktree is a separate repository working copy. Cleanup is a separate confirmed command that lists exact paths. It does not operate automatically.

## CLI operations

```sh
bun src/cli.ts export --run .planning/<slug>
bun src/cli.ts cleanup --run .planning/<slug> --dry-run
```

Export writes sanitized Markdown to stdout, the standard output stream. It does not overwrite an output file. Before redirecting the export to a new file, inspect it.

After review, use `--apply --confirm <plan-digest>` to apply cleanup. CAUTION: Cleanup removes the listed paths. `--dry-run` always prevents cleanup effects.
