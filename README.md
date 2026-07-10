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
/ultraship [topo] <task>    interactive, but with TWO genius planners (plato + aristotle)
                            debating the plan first — topo = crossreview|duel|debate
/ultrashipit [topo] <task>  autonomous dual-genius: same two-planner front end, no gate
/superreview [--base <ref>] [intent]   standalone: genius review->fix loop over your
                            CURRENT local changes (no plan/build) — always ultra
```

Generate a sample dashboard: `python3 scripts/demo.py` -> `examples/demo-plan.html`.

## What's in the box

| Path | What it is |
|---|---|
| `omp/commands/supership.md` | The pipeline (interactive). Three eval-cell blocks: SHARED HELPERS (state I/O + schemas), CELL 1 (plan -> dashboard), CELL 2 (build -> review -> consolidate, resume-safe). |
| `omp/commands/shipit.md` | Thin auto-mode wrapper (it executes supership.md with `MODE="auto"`). |
| `omp/commands/ultraship.md` | Thin ultra wrapper: supership.md with `ULTRA=True` (two genius planners debate the plan) + a topology word. Interactive. |
| `omp/commands/ultrashipit.md` | Autonomous ultra wrapper: `ULTRA=True` + `MODE="auto"` (dual-genius plan, no interview/gate). |
| `omp/commands/superreview.md` | Standalone genius **review→fix** loop over local changes (no plan/build). Reuses supership's shared `run_review_loop()` engine; always ultra. |
| `omp/templates/supership-plan.html` | The dashboard template with dark, dependency-free, `file://`-safe, XSS-safe (textContent-only render). |
| `omp/agents/planner.md` | GENIUS architect. Three modes: CLARIFY (dependency-ordered question tree, each with a recommended answer), PLAN (structured plan), CONSULT (adjudicate a stuck implementer's design question). |
| `omp/agents/task.md` | Mechanical worker. Offloads research to scouts; returns a `stuck` signal instead of thrashing. |
| `omp/agents/david-research.md` | Cheap web/docs/repo scout this helps keeps internet context out of the parent. |
| `omp/agents/deep-debugger.md` | GENIUS root-cause diagnostician. |
| `omp/agents/deep-reviewer.md` | Clean reviewer (no native output schema -> call-site schemas apply cleanly; model varied per lens for diversity). |
| `omp/agents/designer.md` | UI/UX specialist (`pi/designer`). Builds/modifies/improves frontend pieces, reviews the `design` lens, and fixes frontend findings. Design-system-first, accessibility-aware. |
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
- **`modelRoles` chains ship as YAML lists — requires omp ≥ 16.3.7.** List
  values crash the `pi/<role>` resolver on older builds
  ([oh-my-pi #4492](https://github.com/can1357/oh-my-pi/issues/4492), fixed in
  16.3.7); on < 16.3.7, flatten each list to one comma-separated string
  (identical semantics).
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

## Load balancing across subscriptions (usage-aware)

omp's `modelRoles` chains are fallback-only (first resolvable model always
wins — no native rotation, and provider in-flight caps queue rather than
spill over). So Cell 2 routes explicitly: a **pool** (`modelRoles.taskpool`)
round-robins plain `task` builders, fixers, and review verifiers across
models/subscriptions via `agent(model=...)`, deterministically by piece order
(resume-safe). The pool is **configured, not a cell constant** — set it in
`modelRoles.taskpool` (entries are single model patterns; weight by repeating
an entry; `taskpool: []` **disables** pooling; omitting the key falls back to
the shipped default pair). Genius agents never pool.

Routing is **subscription-aware**, two layers:
- **Proactive** — before each spawn, `pool_healthy()` reads omp's own durable
  usage ledger (`~/.omp/agent/agent.db`: `usage_history` used-fraction/status
  per limit window + `auth_credential_blocks`) and walks past any pool entry
  whose subscription is exhausted (≥ `POOL_FULL`, default 0.95) or whose
  credentials are all blocked. Model-class-scoped limits are respected
  (an exhausted `anthropic:7d:fable` window doesn't gate a sonnet spawn).
  Fail-open: if the ledger can't be read, the entry counts as healthy.
- **Reactive** — if a spawn dies with a usage-limit/quota/auth-exhaustion
  error (omp gives up after ≤3 fast internal same-provider retries),
  `pool_alt()` re-dispatches that piece once on the other provider
  (`build:pX:alt`) and skip-lists the failed provider for 30 minutes, so
  subsequent pieces route away proactively. Ordinary task failures never
  trigger cross-provider fallback.

**Multiple accounts per provider** (several Claude Max / Codex logins)
compose cleanly: omp natively hash-sticks each subagent session to one
account and rotates off blocked/exhausted siblings, so intra-provider
spreading is automatic. `pool_healthy()` evaluates the ledger **per
account** and only marks a provider unhealthy when every account is
drained or credential-blocked — one healthy Max account keeps the whole
anthropic pool entry usable.

## Review verification (the blind-judge gate)

The review judge rules on each finding's **text**, never the code — so a
plausible-but-wrong finding (a real defect that isn't, a misread of the diff)
sails through and a fixer "corrects" working code. To close that gap, every
judge-kept finding passes through a **refute-verifier** before any fixer runs:
one `task` agent per finding tries to *disprove* it against the actual code
(reading the files, running cheap checks), and the finding is dropped unless it
comes back `confirmed=true` with concrete evidence (`file:line` + why it's a
real defect). Only confirmed findings reach the fixers and `S["findings"]`; a
round where everything is refuted counts as clean and the loop exits. The gate
is **fail-open** — a verifier that errors keeps its finding, so infra noise
never silently drops a real bug — and `VERIFY_FINDINGS` (in Cell 2) is the
kill-switch to disable it. Each round records `found` / `kept` (judge) /
`confirmed` (post-verify) in the dashboard.

Reviewer models are a **diversity set** you configure via `modelRoles.reviewers`
(entries alternate across the lenses so different lenses get different eyes; not
a fallback chain, though an entry may itself be a comma-joined chain). Omitting
the key falls back to the shipped default pair.

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
│     ├─ frontend piece?          planner tagged agent=designer -> the DESIGNER
│     │                           builds it (UI/UX, design-system, a11y)
│     └─ stuck builder?           kind=design -> planner[CONSULT]
│                                 kind=bug    -> deep-debugger
│                                 -> one guided retry -> else surfaced unresolved
├─ 3 REVIEW LOOP                  diverse reviewers per lens (incl. standing
│                                 over-engineering lens; + a `design` lens by the
│                                 DESIGNER when frontend changed) -> judge keeps
│                                 real findings -> refute-verifiers gate fixers ->
│                                 fixers on shared tree (frontend files -> DESIGNER)
│                                 -> re-review until a clean round (budget-gated, capped)
└─ 4 CONSOLIDATE                  final state -> dashboard; ## Lessons +
                                  ponytail-debt harvested; omp per-repo memory
                                  carries lessons into future sessions
```

## Ultra variant (`/ultraship`, `/ultrashipit`)

The base pipeline plans with a single genius. The **ultra** variant runs the
**exact same pipeline** but replaces that one planner with **two** genius seats
that debate the plan before anything is built, then hands the agreed plan to the
unchanged execute → consolidate machinery — and reviews genius-tier too (see
[Ultra review](#ultra-review) below). Use it when the plan is the risky part
(ambiguous architecture, big blast radius, one-shot migrations); skip it when the
work is mechanical.

Two model-role seats you configure (see `config/`):

- **`plato`** — chief architect and **final consolidator**; always owns THE plan.
- **`aristotle`** — the **challenger**; red-teams, never rubber-stamps.

Three topologies (first word of the command picks one; default `duel`):

| Topology | Genius calls | Flow | Use when |
|---|---|---|---|
| `crossreview` | 3 | plato plans → aristotle red-teams → plato revises | cheapest sanity check on a single strong plan |
| `duel` | 5 | both plan **blind** in parallel → each red-teams the rival → plato synthesizes | you want two genuinely independent takes reconciled |
| `debate` | 7 | duel + one revision round (each revises its own plan given the rival + its critique) → plato synthesizes | highest-stakes plans worth a full argue-and-refine |

Synthesis is **single-owner, never a committee merge** — plato adopts the
strongest elements and records the adopted/rejected tradeoffs in the plan `notes`.
`debate` is hard-capped at exactly one revision round (no convergence loops).

`/ultraship <topo> <task>` is interactive (clarify + approval gate, and the plan
presentation tells you the topology and its genius spend); `/ultrashipit <topo>
<task>` is autonomous (no interview, no gate). Both accept `resume`.

**Fresh-eyes consults:** in an ultra run, a `design` escalation from a stuck
builder is re-adjudicated by the **challenger** (aristotle), not the plan's
author — the model that red-teamed the plan is best placed to reopen it. `bug`
escalations still go to `deep-debugger`.

### Ultra review

Ultra doesn't stop at the plan — it also reviews genius-tier, because a diff worth
two geniuses debating the plan is worth two geniuses reviewing. Each review round
is a **fixed duel** of the same two seats:

1. `plato` and `aristotle` each review the diff **blind** — one holistic pass
   covering **all** lenses at once (the lenses become a rubric; no per-lens genius
   fan-out, which would blow up cost). Persona stays `deep-reviewer` (clean
   call-site schema), only the model is the genius chain.
2. Each **red-teams the rival's** findings against the actual code.
3. `plato` **synthesizes** the final kept set as sole owner + per-lens verdicts.

The cross-red-team **subsumes** the normal refute-verifier — the rival already
tried to knock each finding down — so ultra rounds run no separate `task` verify
pass; the synthesis output *is* the confirmed set (still passed through the same
`priority`/`confidence` numeric gate). Everything after "here are the confirmed
findings" — fixers, the round loop, `MAX_ROUNDS`, budget gate, clean detection,
dashboard `found`/`kept`/`confirmed` records — is the **identical code** the normal
loop runs, so normal `/supership` runs are byte-for-byte unaffected.

The review shape is a **fixed duel regardless of the plan topology** (crossreview
and debate don't map to review — you don't "revise a review," you re-review after
fixes, which the outer round loop already does). Cost is bounded: ~5 genius calls
per round, early-exit on a clean round, capped at `MAX_ROUNDS`. The seats are read
from the **frozen run state**, not live config, so review uses the same brains
that planned and a resumed run doesn't retarget. No new config, no new command —
it rides the same `ULTRA` flag; you cannot get ultra review on a normally-planned
run (an accepted non-goal).

**Config the seats** (merge into `modelRoles`, e.g. via `./install.sh --config`):

```yaml
modelRoles:
  plato:                              # chief architect / consolidator
    - anthropic/claude-fable-5:high
    - anthropic/claude-opus-4-8:max
  aristotle:                          # challenger (same model as plato is legal)
    - openai-codex/gpt-5.6-sol:xhigh
    - openai-codex/gpt-5.6-sol-pro:xhigh
```

If either seat is unset, ultra **fails loud** — Cell 1 asserts both are configured
and non-empty and refuses to silently degrade to a single genius.

**Why the pipeline resolves the chains itself:** omp's `pi/<role>` aliases only
cover **built-in** role names (through omp ≤ 16.3.15), so `model="pi/plato"` for a
custom role passes through unresolved and omp *silently* spawns an undefined-model
session. So Cell 1 reads `omp config get modelRoles --json` itself, normalizes each
chain to a comma-joined fallback string, and passes it via `model=` (a call-site
`model=` overrides the planner agent's frontmatter chain).

## Frontend & design (the `designer` agent)

Anything user-facing routes through the **`designer`** agent (omp's UI/UX
specialist, model `pi/designer`) — design-system-first, accessibility-aware —
instead of the generic `task` worker, end to end:

- **Build:** the planner tags any piece whose primary deliverable is UI as
  `agent="designer"` (building frontend from scratch, modifying, or improving it);
  the build wave dispatches it to the designer (backend/API/data stays `task`).
- **Review:** when the change touched frontend, the review loop adds a **`design`
  lens reviewed by the designer** (normal runs); ultra runs fold the design rubric
  into the plato/aristotle duel instead of spawning a third reviewer.
- **Fix:** review fixes on a frontend file are dispatched to the designer, not the
  `task` pool — so the thing correcting UI findings has design instincts too.

Detection is split by where it happens: **build** routing is the planner's semantic
call (the piece `agent`), while **review/fix** routing is a mechanical
`is_frontend(path)` glob (`.tsx/.jsx/.vue/.svelte/.astro/.css/.scss/.less/.html/.mdx`
+ `components|styles|ui|pages|views|layouts` dirs) — the only signal available
post-hoc, and the same one `/superreview` uses over its diff. Uses the existing
`modelRoles.designer` chain; no new config.

## Standalone review (`/superreview`)

`/supership` reviews as the last stage of a full plan→build→review run.
`/superreview` peels that review stage off into a **standalone command** you point
at *any* local changes — a diff you wrote by hand, or the output of a previous
supership run you want a second, harder pass on. It runs the **exact same engine**
(the shared `run_review_loop()`), just seeded with a review-only state and no
plan/build. **Always ultra** — the `plato`+`aristotle` genius duel.

```
/superreview [--base <ref>] [--slug <slug>] [free-text intent…]
```

- **Diff target** (auto-detected): uncommitted changes if the working tree is
  dirty; otherwise the current branch vs its `git merge-base` with the default
  branch; `--base <ref>` overrides. Re-review always diffs the same fixed base, so
  fixes accumulate across rounds.
- **Intent**: the free-text argument is what the change is *meant* to do (plus any
  scope/non-goals); omit it and reviewers infer intent from the diff + recent
  commits. There's no plan to anchor scope, so reviewers lean toward *defects in
  what changed*.
- **Always ultra**: seats are resolved **live from config at review start** (no
  plan to freeze them) and frozen into this run's state; loud-fail if `plato`/
  `aristotle` are unset. No normal-tier/lite mode.
- **Same UX**: writes a `.planning/review-<MMDD-HHMM>/plan.html` dashboard,
  resumable via `/superreview resume`, and it **fixes** on the shared tree (the
  full review→fix→re-verify loop, not just a report). No clarify, no approval gate.

Because it shares `run_review_loop()` with the pipeline, every improvement to the
review engine (the verify gate, the ultra duel) lands in both at once. It's
**local-only** — for GitHub PR review use the built-in `/code-review` / `/review`.

## License

MIT — see [LICENSE](LICENSE).
