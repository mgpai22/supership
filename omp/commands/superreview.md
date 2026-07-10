# /superreview — standalone genius review→fix loop over local changes

Run the supership kit's **genius review → fix → re-verify** loop over your current
local changes — with **no plan and no build**. Use it on ad-hoc changes you made
by hand, or again after a `/supership` run to re-scrutinize the result.
**Always ultra**: the `plato` + `aristotle` duel (`ultra_review_round`). If the
diff touched frontend (`is_frontend`), the duel rubric folds in the UI/UX lens and
frontend-file fixes route to the `designer` agent (same as `/supership`).

This command **reuses supership's machinery** — it does not re-author the review
engine. The engine is `run_review_loop()` in supership's SHARED HELPERS; this
command just seeds a review-only state and calls it. Read
`.omp/commands/supership.md` (this repo; fall back to
`~/.omp/agent/commands/supership.md` if absent) for the HELPERS + POOL blocks referenced below.

## Arguments

`/superreview [--base <ref>] [--slug <slug>] [free-text intent…]`

- `--base <ref>` — review the range since `<ref>` instead of auto-detecting.
- `--slug <slug>` — dashboard slug; default `review-<MMDD-HHMM>`.
- Everything else is **free-text INTENT** — what these changes are meant to do,
  and any scope/non-goals (e.g. "tightening the auth refactor; ignore vendored/").
  Omit it and the reviewers infer intent from the diff + recent commit messages.

Always ultra — there is no normal-tier/lite mode (that is `/supership`'s inline
review). `resume` is supported (see bottom).

## 0. Resolve the diff target (do this yourself, before the cell)

Run these with `tool.bash` and decide `BASE`:

1. `git rev-parse --is-inside-work-tree` — must be a git repo (else tell the user
   there's nothing to review and stop).
2. If `--base` was given → `BASE = "<ref>"`.
3. Else `git status --porcelain` — **any** output (uncommitted or untracked) →
   `BASE = None` (review the working tree; this is the "I just made changes / just
   ran supership" case).
4. Else (clean tree) → `BASE = git merge-base HEAD <default-branch>` where
   `<default-branch>` = basename of `git symbolic-ref refs/remotes/origin/HEAD`
   (fallback `main`, then `master`); if none resolve, `BASE = "HEAD~1"`.

Tell the user in one line what you're about to review (working tree, or since
`<BASE>`), then author and run the single cell below.

## The eval cell

Author ONE `eval` cell (`language: "py"`) = the assignments + supership's **SHARED
HELPERS** (verbatim) + supership's **Cell 2 POOL block** (verbatim: the region from
`_cfg_roles = read_model_roles()` down through `def pool_alt`) + this driver. The
`{{HELPERS}}` / `{{POOL}}` markers show exactly where each pasted block goes — the
POOL block must come **after** `plan` is defined (it builds `PIECE_IDX` from it).

```py
SLUG = "review-MMDD-HHMM"       # MAIN: --slug value, or review-<MMDD-HHMM>
BASE = None                      # None = working tree; else the resolved base ref (string)
INTENT = """..."""               # MAIN: $ARGUMENTS free text (may be ""); the review's stated intent

# {{HELPERS}} — paste supership.md's SHARED HELPERS here (verbatim). Provides
# state I/O, schemas, read_model_roles, review_diff_hint, and run_review_loop.

# minimal review-only plan: lenses only, no pieces (nothing to build)
plan = {"mode": "review", "overlap": False, "pieces": [],
        "review_lenses": ["correctness", "security", "edge-cases", "design"], "notes": ""}

# {{POOL}} — paste supership.md Cell 2's POOL block here (verbatim: from
# `_cfg_roles = read_model_roles()` through `def pool_alt`). Gives fixers/verifiers
# subscription-aware pool_model/pool_alt; needs `plan` (above) for PIECE_IDX.

# ---- driver ----------------------------------------------------------------
phase("Review")
# Always ultra: resolve the seats LIVE (no plan to freeze them) and loud-fail.
assert _cfg_roles.get("plato") and _cfg_roles.get("aristotle"), (
    "/superreview is ALWAYS ultra — set modelRoles.plato + modelRoles.aristotle "
    "(refusing to degrade to a single genius)")
_norm = lambda v: ",".join(v) if isinstance(v, list) else v
TASK = INTENT.strip() or "(intent not stated — infer it from the diff + recent commit messages)"
ensure_gitignore()
S = {"meta": {"task": ("review: " + TASK.splitlines()[0])[:160], "slug": SLUG,
              "mode": "review", "created": time.strftime("%Y-%m-%d %H:%M:%S"),
              "updated": "", "status": "reviewing", "base": BASE,
              # seats frozen into THIS run's state (resume-safe), resolved live above
              "ultra": {"topology": "duel", "plato": _norm(_cfg_roles["plato"]),
                        "aristotle": _norm(_cfg_roles["aristotle"])}},
     "spec": TASK, "plan": plan,
     "approval": {"state": "auto", "at": time.strftime("%Y-%m-%d %H:%M:%S"), "notes": ""},
     "progress_log": [], "review_rounds": [], "findings": [],
     "unresolved": [], "lessons": "", "ponytail_debt": []}
plog(S, "review", f"review start — base={BASE or 'working tree'}, ultra duel")

# Frontend detection over the CHANGED set (gates the design lens; the per-file
# is_frontend() check inside run_review_loop routes frontend fixes to the designer
# regardless). Union of tracked diff vs BASE + untracked files; tolerate the
# {"text": ...} tool.bash shape and fail-open to False.
_gd = tool.bash(command=("git diff --name-only " + (BASE + " " if BASE else "") +
                         "2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null"))
_changed = (_gd.get("text", "") if isinstance(_gd, dict) else (_gd or "")).split()
FRONTEND = any(is_frontend(p) for p in _changed)

# THE shared engine (identical to what /supership runs), pointed at the standalone diff.
run_review_loop(S, plan, TASK, _cfg_roles, diff_hint=review_diff_hint(BASE), frontend=FRONTEND)

phase("Consolidate")
S["meta"]["status"] = "done"
save_state(S)
print(json.dumps({
    "dashboard": PLAN_PATH,
    "base": BASE or "working tree",
    "review_rounds": S["review_rounds"],
    # clean = last round confirmed nothing (all-refuted rounds break clean too)
    "clean": bool(S["review_rounds"])
             and S["review_rounds"][-1].get("confirmed", S["review_rounds"][-1]["kept"]) == 0,
}, indent=2))
```

## After the cell

1. Point the user at `.planning/<slug>/plan.html` (the live dashboard: rounds,
   findings, verdicts). It stops refreshing once `meta.status == "done"`.
2. Harvest **`## Lessons`** + ponytail-debt into the dashboard with the same tiny
   eval supership uses in its §4 (`S = load_state(); S["lessons"] = ...;
   S["ponytail_debt"] = [...]; save_state(S)`) — the fixers may have left
   `// ponytail:` markers worth surfacing.

## Resume (`/superreview resume [slug]`)

1. Given a slug use it; else pick the newest `.planning/review-*/plan.html` whose
   `meta.status` is not `done`.
2. Author a tiny eval (`SLUG = ...` + supership HELPERS + the POOL block) with
   `S = load_state()`, then re-enter the loop against the ORIGINAL base:
   ```py
   run_review_loop(S, S["plan"], S["spec"], _cfg_roles,
                   diff_hint=review_diff_hint(S["meta"].get("base")))
   S["meta"]["status"] = "done"; save_state(S)
   ```
   The round count continues from the file, and fixers already applied survive.

## Non-goals

Local working tree only — **no PR/GitHub integration** (use the built-in
`/code-review` / `/review` for that). No plan, build, clarify, or approval gate.
Always ultra. No new `modelRoles` keys — it reuses `plato`/`aristotle`.
