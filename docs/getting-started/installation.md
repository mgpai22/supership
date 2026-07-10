---
title: Installation
order: 2
description: Requirements, sharp edges learned the hard way, and the installer.
---

# Installation

## Requirements and sharp edges

supership rides on omp's subagent and config machinery, so a few version and config details matter.

> [!WARNING]
> **omp version floors.** Use **omp >= 16.2.8**. Earlier snapcompact builds can mess up long sessions (unbounded frame payloads produce an `Anthropic Internal server error` on resume, fixed by oh-my-pi PR #3866). If you ship `modelRoles` chains as YAML lists you also need **omp >= 16.3.7** (list values crash the `pi/<role>` resolver on older builds, oh-my-pi #4492). On anything older than 16.3.7, flatten each list to one comma-separated string. The semantics are identical.

The request-count governor default is too low for this kit. omp steers a subagent to wrap up at `task.softRequestBudget` and hard-aborts it at 1.5x the budget. The default of 90 silent kills at 135 requests, which this kit's builders and debuggers routinely exceed. Raise the budget and turn the notice on.

```type-table
# task settings
softRequestBudget | number | 90 | Requests before omp steers the child to wrap up; hard-abort at 1.5x. Set to 250 (warns at 250, kills at 375).
softRequestBudgetNotice | boolean | false | Off by default, so the first signal a child gets is the kill. Turn on so children can wrap up and yield.
maxRecursionDepth | number | 2 | Subagent spawn depth cap. Set to 3 so ad-hoc escalation (a task agent spawning deep-debugger) keeps its own scouts.
```

The pipeline routes its own escalation at depth 0 and works at any cap. The bump to `maxRecursionDepth: 3` is for ad-hoc use, where a `task` agent spawns `deep-debugger`, which then needs room for its own scouts (main = 0, each `agent()` child adds 1, the eval hard cap is 3).

> [!INFO]
> **Authenticate your providers.** The shipped model roles reference Anthropic, OpenAI-Codex, Google-Antigravity, and ZAI. You must have those authenticated in omp, or edit `config/modelRoles.json` to match your own catalog (check `omp models`).

## Install

```steps
# Clone and run the installer
Clone the repo, then run `install.sh`. The default copies the commands, agents, templates, and the grill skill into place. Use `--link` to symlink instead, so this repo stays the live source of truth and edits here take effect everywhere.

# Apply the config keys
Add `--config` to also apply the config keys via `omp config set`. This writes `modelRoles`, `task.maxRecursionDepth`, `task.softRequestBudget`, and `task.softRequestBudgetNotice`. The `compaction` and `memory` keys are not auto-applied; merge them from `config/config.snippet.yml` if you want them.

# Restart omp
Restart your omp session so it picks up the new commands, agents, and config.

# Verify
Try `/supership <task>` or `/shipit <task>`.
```

Clone the repo, then run the installer from its root.

```bash
git clone https://github.com/mgpai22/supership.git && cd supership
./install.sh            # copy into ~/.omp/agent + ~/.agents/skills
./install.sh --link     # symlink (edit here, live everywhere)
./install.sh --config   # also apply modelRoles + task keys via omp config
```

The installer is idempotent and never overwrites an existing `APPEND_SYSTEM.md` that differs from the shipped one. If yours differs it tells you to merge by hand.

## Install with an agent

Paste this into your coding agent and it does the setup for you.

```text
Install the supership kit for oh-my-pi from https://github.com/mgpai22/supership.
Clone the repo, run `./install.sh --config` (this copies the commands, agents, and
grill skill into ~/.omp/agent and applies the modelRoles + task config), then tell
me to restart my omp session. Reference: https://supership.shishirpai.com
```

## Plans stay out of git by default

The first run in a repo appends `.planning/` to `.gitignore` with a "delete to commit/push plans" comment. Plan dashboards are local by default, but committing them to share a plan is a supported choice. Delete the two added lines to opt in.

> [!TIP]
> Sharing a plan across a team is intentional. If you want the dashboard committed, remove the `# supership plan dashboards` block from `.gitignore` and the JSON travels with your branch.
