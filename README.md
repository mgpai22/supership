# supership

A deterministic multi-agent workflow kit for oh-my-pi

A complete, reproducible agent setup for [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi):
two slash commands that run a **clarify -> plan -> build -> review -> consolidate**
pipeline as *real code* (omp's `workflowz` eval engine — `agent()` / `parallel()` /
`completion()` with deterministic control flow), a roster of specialized global
agents, a cross-harness **grill** skill, and a **live HTML dashboard** that makes
every run human-readable, durable, and resumable.

```
/supership <task>     interactive: grill you for clarity -> plan -> YOU approve/refine
                      the plan in a live dashboard -> build -> review loop -> consolidate
/shipit <task>        autonomous: same pipeline, no interview, no gate — fire & forget
/supership resume     re-enter any interrupted run where it left off
```

Generate a sample dashboard: `python3 scripts/demo.py` -> `examples/demo-plan.html`.

## What's in the box

| Path | What it is |
|---|---|
| `omp/commands/supership.md` | The pipeline (interactive). Three eval-cell blocks: SHARED HELPERS (state I/O + schemas), CELL 1 (plan -> dashboard), CELL 2 (build -> review -> consolidate, resume-safe). |
| `omp/commands/shipit.md` | Thin auto-mode wrapper (it executes supership.md with `MODE="auto"`). |
| `omp/templates/supership-plan.html` | The dashboard template with dark, dependency-free, `file://`-safe, XSS-safe (textContent-only render). |
| `omp/agents/planner.md` | GENIUS architect. Three modes: CLARIFY (dependency-ordered question tree, each with a recommended answer), PLAN (structured plan), CONSULT (adjudicate a stuck implementer's design question). |
| `omp/agents/task.md` | Mechanical worker. Offloads research to scouts; returns a `stuck` signal instead of thrashing. |
| `omp/agents/david-research.md` | Cheap web/docs/repo scout this helps keeps internet context out of the parent. |
| `omp/agents/deep-debugger.md` | GENIUS root-cause diagnostician. |
| `omp/agents/deep-reviewer.md` | Clean reviewer (no native output schema -> call-site schemas apply cleanly; model varied per lens for diversity). |
| `omp/agents/review-orchestrator.md` | Legacy manual review loop (superseded by the in-pipeline loop; kept for standalone use). |
| `omp/APPEND_SYSTEM.md` | Global system-prompt append which teaches the main agent the roster, delegation discipline, and both commands. |
| `skills/grill/SKILL.md` | Cross-harness clarifying-interview skill (one question at a time, recommended answers, user sign-off). Works in Claude Code, Codex CLI, and omp via the shared `~/.agents/skills/` hub. |
| `config/` | The `config.yml` keys the kit relies on (model roles, recursion depth) + `modelRoles.json` for `omp config set`. |
| `install.sh` | Idempotent installer: `--link` to keep this repo as the live source of truth, `--config` to apply the config keys. |

## Install

```sh
git clone <this-repo> && cd <this-repo>
./install.sh            # copy into ~/.omp/agent + ~/.agents/skills
# or:
./install.sh --link     # symlink (edit here, live everywhere)
./install.sh --config   # also apply modelRoles + task.maxRecursionDepth via omp config
```

Then restart your omp session. `plan.html` runs are auto-gitignored per repo
(the installer-written pipeline adds `.planning/` to `.gitignore` with a
*"delete to commit/push plans"* comment — committing plans is a supported choice).

### Requirements & sharp edges (learned the hard way)

- **omp ≥ v16.2.8** — earlier snapcompact builds can wedge long sessions
  (unbounded frame payloads -> `Anthropic Internal server error` on resume;
  fixed by [oh-my-pi PR #3866](https://github.com/can1357/oh-my-pi/pull/3866)).
- **`modelRoles` fallback chains must be comma-separated STRINGS, never YAML
  lists** — list values crash omp's `pi/<role>` resolver
  ([oh-my-pi #4492](https://github.com/can1357/oh-my-pi/issues/4492)).
- **`task.softRequestBudget: 250` + `task.softRequestBudgetNotice: true`**
  (defaults: 90, notice **off**). omp hard-aborts any subagent at **1.5× the
  budget** — with the defaults that's a silent kill at 135 requests, which this
  kit's builders/debuggers routinely exceed (an observed deep-debugger run was
  killed at 135 *while yielding `status=done`*, misfiling a finished piece as
  unresolved). The pipeline salvages that specific race (`salvage_yield` in
  Cell 2), but the config raise + wrap-up notice is what actually prevents it.
- **`task.maxRecursionDepth: 3`** (default 2). The pipeline itself routes
  escalation at depth 0 and works at any cap; 3 un-cripples *ad-hoc* escalation
  (a task agent spawning deep-debugger outside the pipeline). Depth contract:
  main = 0, each `agent()` child +1, spawn allowed while `depth < cap`, eval
  hard cap 3 ([oh-my-pi #4493](https://github.com/can1357/oh-my-pi/issues/4493)).
- The model roles reference providers you must have authenticated in omp
  (Anthropic, OpenAI-Codex, Google-Antigravity, ZAI in the shipped set) — edit
  `config/modelRoles.json` to match your catalog (`omp models`).
- Reviewers use `deep-reviewer` (not the bundled `reviewer`) with call-site
  schemas — avoids an intermittent schema-violation with the bundled agent's
  native output labels ([oh-my-pi #3926](https://github.com/can1357/oh-my-pi/issues/3926)).

### Optional companion

[`ponytail`](https://github.com/DietrichGebert/ponytail) (`omp install
git:github.com/DietrichGebert/ponytail`) — the pipeline's build prompts and the
standing **over-engineering review lens** already encode its "lazy senior dev"
ladder inline, and the consolidate step harvests `// ponytail:` debt markers;
installing ponytail globally reinforces the same discipline in ordinary
(non-pipeline) sessions.

## How the pipeline works

```
/supership <task>
│
├─ 0 CLARIFY (interactive only)   planner[CLARIFY] builds a question tree ->
│                                 main grills you one question at a time -> SPEC
├─ 1 PLAN                         planner[PLAN] -> structured plan -> plan.html
│                                 (interactive: YOU refine + approve in the
│                                  dashboard/chat before anything builds)
├─ 2 EXECUTE                      sequential -> one worker, in order
│                                 disjoint parallel -> shared-tree wave
│                                 overlapping parallel -> isolated worktrees
│                                   (patch mode) -> serial synthesis
│     └─ stuck builder?           kind=design -> planner[CONSULT]
│                                 kind=bug    -> deep-debugger
│                                 -> one guided retry -> else surfaced unresolved
├─ 3 REVIEW LOOP                  diverse reviewers per lens (incl. standing
│                                 over-engineering lens) -> judge keeps real
│                                 findings -> fixers on shared tree -> re-review
│                                 until a clean round (budget-gated, capped)
└─ 4 CONSOLIDATE                  final state -> dashboard; ## Lessons +
                                  ponytail-debt harvested; omp per-repo memory
                                  carries lessons into future sessions
```

## License

MIT — see [LICENSE](LICENSE).
