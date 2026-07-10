# /supership — clarify → plan (approve) → build → review → consolidate

Run the full workflow for the task in `$ARGUMENTS`, with durable state in a
human-readable **`.planning/<slug>/plan.html`** dashboard (embedded canonical
JSON + self-rendering page; open it in a browser and it live-refreshes while the
run is active).

**MODE:** `interactive` when invoked as `/supership` (default) — the user sees
the plan and refines it before anything is built. `auto` when invoked via
`/shipit` — no interview, no approval gate, runs end-to-end. **RESUME:** if
`$ARGUMENTS` starts with `resume`, skip to the *Resume* section at the bottom.

You (the main agent) author and run **`eval` cells, `language: "py"`** that
implement the control flow below in real code — `agent()` / `parallel()` /
`completion()` with the named global agents. Do **not** hand orchestration to a
nested orchestrator. Recursion: main = depth 0, each `agent()` child is +1, and a
spawner may call `agent()` only while `depth < task.maxRecursionDepth` (default
2; set to 3 here; eval hard cap 3) — authoring at depth 0 keeps consultants you
spawn at depth 1 with room for their own scouts at depth 2.

**Cell contract:** every eval cell you author = the assignment line(s) below +
the SHARED HELPERS block + that cell's body. The eval kernel persists state
between cells, but re-including HELPERS is harmless and makes every cell
resume-safe. The **file is the source of truth** — each cell re-reads it.

The task: **$ARGUMENTS**

## Ultra variant (/ultraship, /ultrashipit)

`/ultraship` and `/ultrashipit` run this **exact** pipeline with `ULTRA = True`:
the single planner in Cell 1 is replaced by **two** genius seats you configure as
model roles — `plato` (chief architect / final consolidator) and `aristotle`
(challenger). Everything after planning (execute, review loop, consolidate) is
unchanged. Three topologies, selected by the first word of the arguments (default
`duel`):

- **crossreview** (3 genius calls) — plato plans → aristotle red-teams it → plato
  revises its own plan.
- **duel** (5) — plato and aristotle plan **blind** in parallel → each red-teams
  the *rival's* plan in parallel → plato synthesizes THE plan as sole owner.
- **debate** (7) — duel through the critiques, then one (and only one) revision
  round where each genius revises its OWN plan given the rival + the critique it
  received → plato synthesizes from the two revised plans. Hard cap: one round.

The synthesis is single-owner, never a committee merge — plato adopts the
strongest elements and records the adopted/rejected tradeoffs in the plan `notes`.

In ultra runs, a builder stuck on a `design` question is consulted by
**aristotle** (fresh eyes — the challenger, not the plan's author). The genius
chains are frozen into the run state at plan time, so editing `modelRoles`
mid-run does not retarget an in-flight or resumed run (plan-time identity is
deliberate).

**Why the pipeline reads the chains itself:** omp's `pi/<role>` alias resolver is
hard-gated to built-in role names (≤ 16.3.15), so `model="pi/plato"` passes
through unresolved and omp *silently* spawns an undefined-model session. Cell 1
therefore reads `omp config get modelRoles --json` itself, asserts `plato` +
`aristotle` are configured and non-empty (**loud fail** — it refuses to degrade to
one genius), normalizes each chain to a comma-joined fallback string, and passes
it via `model=` (a call-site `model=` beats the planner's frontmatter chain).

**Fresh-eyes consult:** in an ultra run a `design` escalation is re-adjudicated by
the *challenger* (aristotle), not the plan's author — see `consult()` in Cell 2.
`bug` escalations still go to `deep-debugger`.

## 0. Clarify (interactive mode only — auto skips this entirely)

The eval fan-out is autonomous — subagents cannot ask the user anything — so
reach a shared understanding **now**. Spawn `planner` in CLARIFY mode to develop
context and return a **dependency-ordered** question tree, each question with its
recommended answer (it answers from the code what the code can answer). Then
grill the user yourself: **one question at a time**, upstream decisions first,
specific and actionable, keeping an "established so far" recap. No question cap;
the **user** decides when you're aligned. Fast paths: "accept your
recommendations and go", or "skip clarify". Produce the **CLARIFIED SPEC** —
exactly what to build, agreed decisions, non-goals. That (not the raw request)
is `TASK`.

## 1. Cell 1 — PLAN (writes the dashboard)

Author one eval cell: the three assignments, then HELPERS, then CELL 1.

```py
SLUG = "kebab-task-name-MMDD"      # MAIN: short kebab slug for this run
MODE = "interactive"               # or "auto" (when invoked via /shipit)
ULTRA = False                      # True only via /ultraship or /ultrashipit
TOPOLOGY = "duel"                  # crossreview | duel | debate (ultra only)
TASK = """..."""                   # MAIN: the CLARIFIED SPEC (or raw task in auto
                                   # mode) as a valid Python string — escape any
                                   # triple quotes; don't break the literal.
```

### SHARED HELPERS (include verbatim at the top of EVERY cell, after the assignments)

```py
import json, os, re, time

# ---- durable state: .planning/<SLUG>/plan.html ------------------------------
# The <script id="plan-data"> JSON is canonical; the page is a derived render.
# Updates are CODE-DRIVEN from this pipeline (never trusted to agent memory).
PLAN_DIR = os.path.join(".planning", SLUG)
PLAN_PATH = os.path.join(PLAN_DIR, "plan.html")
TEMPLATE_PATH = os.path.expanduser("~/.omp/agent/templates/supership-plan.html")
_FALLBACK = ('<!doctype html><meta charset="utf-8"><title>supership</title>'
             '<pre id="o"></pre>'
             '<script type="application/json" id="plan-data">{{DATA}}</script>'
             "<script>var S=JSON.parse(document.getElementById('plan-data').textContent);"
             "document.getElementById('o').textContent=JSON.stringify(S,null,2);"
             "if(['done','failed'].indexOf((S.meta||{}).status)<0)"
             "setTimeout(function(){location.reload()},5000);</script>")

def _template():
    try:
        return open(TEMPLATE_PATH, encoding="utf-8").read()
    except OSError:
        return _FALLBACK

def save_state(S):
    S["meta"]["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    os.makedirs(PLAN_DIR, exist_ok=True)
    # escape "</" so agent text containing "</script>" can't break the page
    payload = json.dumps(S, ensure_ascii=False, indent=1).replace("</", "<\\/")
    open(PLAN_PATH, "w", encoding="utf-8").write(_template().replace("{{DATA}}", payload))

def load_state():
    html = open(PLAN_PATH, encoding="utf-8").read()
    m = re.search(r'<script type="application/json" id="plan-data">(.*?)</script>',
                  html, re.S)
    return json.loads(m.group(1).replace("<\\/", "</"))

def plog(S, ph, msg):
    S["progress_log"].append({"t": time.strftime("%H:%M:%S"), "phase": ph, "msg": msg})
    log(msg)
    save_state(S)

def ensure_gitignore():
    # Plans stay out of git by DEFAULT, but committing/pushing .planning/ to share
    # plans is a supported choice — just delete these two lines from .gitignore.
    if not os.path.isdir(".git"):
        return
    try:
        cur = open(".gitignore", encoding="utf-8").read()
    except OSError:
        cur = ""
    if ".planning/" not in cur.split("\n"):
        with open(".gitignore", "a", encoding="utf-8") as f:
            if cur and not cur.endswith("\n"):
                f.write("\n")
            f.write("# supership plan dashboards (delete to commit/push plans)\n.planning/\n")

# ---- config: modelRoles (lazy read; NEVER called at helper-exec time) --------
def read_model_roles():
    # Read modelRoles from omp config INSIDE a cell body (needs the eval `tool`
    # + `json` globals). Fail-OPEN: any error -> {} so callers fall back to
    # their own defaults. In-session tool.bash returns {"text": <stdout>,
    # "details": {...}} (raw string only when a tool emits no details, which
    # bash never does); the CLI `--json` shape is {"key":..., "value": {...}}.
    try:
        raw = tool.bash(command="omp config get modelRoles --json")
        if isinstance(raw, dict):
            raw = raw.get("text", "")
        mr = json.loads(raw)
        if isinstance(mr, dict) and "value" in mr:
            mr = mr["value"]
        return mr if isinstance(mr, dict) else {}
    except Exception:
        return {}

# ---- SCHEMAS (JSON Schema dialect; descriptions survive) ---------------------
PLAN_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["mode", "overlap", "pieces", "review_lenses", "notes"],
    "properties": {
        "mode": {"type": "string", "enum": ["sequential", "parallel"],
            "description": "sequential = one implementer does all pieces in order; parallel = pieces run concurrently"},
        "overlap": {"type": "boolean",
            "description": "parallel only: true if pieces may edit the SAME repo files (-> isolated worktrees + serial synthesis); false if the pieces touch disjoint files"},
        "pieces": {"type": "array",
            "description": "Ordered, self-contained units of work (>=1; sequential plans still list them)",
            "items": {"type": "object", "additionalProperties": False,
                "required": ["id", "description", "agent"],
                "properties": {
                    "id": {"type": "string", "description": "Stable short id, e.g. p1"},
                    "description": {"type": "string", "description": "Complete standalone instruction for this piece's implementer"},
                    "agent": {"type": "string", "enum": ["task", "deep-debugger"],
                        "description": "task for mechanical work; deep-debugger only if the piece needs hard diagnosis first"}}}},
        "review_lenses": {"type": "array", "items": {"type": "string"},
            "description": "Review focuses to fan out, e.g. correctness, security, edge-cases, design"},
        "notes": {"type": "string", "description": "Sequencing constraints + synthesis/verify guidance"},
    },
}

FINDINGS_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {"type": "array",
            "description": "Real, patch-anchored defects; empty array if none",
            "items": {"type": "object", "additionalProperties": False,
                "required": ["title", "body", "file_path", "line_start", "line_end", "priority", "confidence"],
                "properties": {
                    "title":      {"type": "string",  "description": "Imperative, <=80 chars"},
                    "body":       {"type": "string",  "description": "Bug -> trigger -> impact, one paragraph"},
                    "file_path":  {"type": "string",  "description": "Repo-relative path"},
                    "line_start": {"type": "integer", "description": "First line (1-indexed)"},
                    "line_end":   {"type": "integer", "description": "Last line (1-indexed)"},
                    "priority":   {"type": "integer", "description": "0=blocker,1=next-cycle,2=eventually,3=nit"},
                    "confidence": {"type": "number",  "description": "0.0-1.0 that it's a real bug"}}}},
    },
}

JUDGE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["decisions", "verdicts"],
    "properties": {
        "decisions": {"type": "array", "description": "One entry per input finding",
            "items": {"type": "object", "additionalProperties": False,
                "required": ["id", "keep", "reason"],
                "properties": {
                    "id":     {"type": "string",  "description": "The finding's id"},
                    "keep":   {"type": "boolean", "description": "true ONLY if a real, in-scope defect worth fixing (drop nits/dupes/false-positives)"},
                    "reason": {"type": "string",  "description": "one-line justification"}}}},
        "verdicts": {"type": "array", "description": "One entry per review lens this round",
            "items": {"type": "object", "additionalProperties": False,
                "required": ["lens", "verdict", "explanation"],
                "properties": {
                    "lens":        {"type": "string"},
                    "verdict":     {"type": "string", "enum": ["clean", "issues_remain"], "description": "clean = nothing real left on this lens"},
                    "explanation": {"type": "string"}}}},
    },
}

BUILD_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["status", "summary"],
    "properties": {
        "status": {"type": "string", "enum": ["done", "stuck"],
            "description": "done = piece implemented; stuck = escalating instead of thrashing"},
        "summary": {"type": "string", "description": "What was done (or how far you got)"},
        "stuck": {"type": "object", "additionalProperties": False,
            "required": ["kind", "tried", "question"],
            "properties": {
                "kind": {"type": "string", "enum": ["bug", "design"],
                    "description": "bug = mechanical failure needing root-cause diagnosis; design = the plan seems ambiguous/wrong for this piece"},
                "tried": {"type": "string", "description": "What you attempted + the exact error/observation"},
                "question": {"type": "string", "description": "The precise question to escalate"}}},
    },
}

VERIFY_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["confirmed", "evidence"],
    "properties": {
        "confirmed": {"type": "boolean",
            "description": "true ONLY with concrete evidence the finding is a real defect; false if it cannot be confirmed (i.e. refuted)"},
        "evidence": {"type": "string",
            "description": "file:line + why it is really a defect, or the reason the finding is refuted"},
    },
}
```

### CELL 1 body (after the helpers)

```py
phase("Plan")
ensure_gitignore()

# Shared by the legacy single-planner path AND every ultra topology (each genius
# gets the SAME task framing; only the model differs).
PLAN_PROMPT = (
    "Produce a concrete execution plan for the task below. Investigate ONLY via "
    "your cheap subagents (explore/david-research/librarian) — do not grep or "
    "browse yourself. Decide sequential-vs-parallel honestly; most work is "
    "sequential (one implementer). If parallel, set overlap=true only when the "
    "pieces may edit the SAME files.\n\nTASK:\n" + TASK)

PLATO = ARISTOTLE = None
if not ULTRA:
    plan = agent(PLAN_PROMPT, agent="planner", label="plan", schema=PLAN_SCHEMA)
else:
    # --- ultra preflight: resolve the two genius chains OURSELVES ------------
    # omp's pi/<role> alias resolver is hard-gated to BUILT-IN role names
    # (verified <=16.3.15): a custom role like pi/plato passes through
    # unresolved and omp SILENTLY spawns an undefined-model session (the error
    # is discarded). So read the chains from config and pass them as ordered
    # comma-joined fallback strings via model= — a call-site model= beats the
    # planner agent's own frontmatter chain. The read (+ {"text": ...}/{"value":
    # ...} unwrap) is factored into the shared read_model_roles() helper; the
    # LOUD assert stays here (ultra refuses to degrade to one genius).
    _roles = read_model_roles()
    assert _roles.get("plato") and _roles.get("aristotle"), (
        "ultra needs modelRoles.plato + modelRoles.aristotle configured — "
        "refusing to degrade to a single genius")
    _norm = lambda v: ",".join(v) if isinstance(v, list) else v
    PLATO, ARISTOTLE = _norm(_roles["plato"]), _norm(_roles["aristotle"])

    def _crit(plan_json):    # adversarial red-team of ONE plan (free text, no schema)
        return ("Red-team this execution plan against the task. Be specific and "
                "adversarial — no praise, no summary. Call out wrong, missing, or "
                "risky pieces; sequencing errors; simpler alternatives; and "
                "approaches the author never considered.\n\nTASK:\n" + TASK +
                "\n\nPLAN:\n" + plan_json)

    def _synth(body):        # sole-owner consolidation into THE plan
        return ("You are the SOLE OWNER of the final plan. Given the plan(s) and "
                "critique(s) below, produce THE execution plan for the task: adopt "
                "the strongest elements and discard the rest. A committee merge is "
                "failure — own the tradeoffs. In the plan `notes`, explicitly record "
                "what you took from the aristotle plan/critique and what you rejected "
                "and why.\n\nTASK:\n" + TASK + "\n\n" + body)

    if TOPOLOGY == "crossreview":                # 3 calls: plato plans -> aristotle
        pl = agent(PLAN_PROMPT, agent="planner", model=PLATO,        # critiques ->
                   label="plan:plato", schema=PLAN_SCHEMA)           # plato revises
        cr = agent(_crit(json.dumps(pl)), agent="planner", model=ARISTOTLE,
                   label="critique:aristotle")
        plan = agent(
            "Revise YOUR plan below, addressing every valid point in the critique; "
            "produce the improved plan. In `notes`, record which critique points you "
            "adopted vs rejected and why.\n\nTASK:\n" + TASK +
            "\n\nYOUR PLAN:\n" + json.dumps(pl) + "\n\nCRITIQUE:\n" + cr,
            agent="planner", model=PLATO, label="synthesis", schema=PLAN_SCHEMA)
    else:
        # duel + debate share a BLIND-plan opening (neither genius sees the other)
        # then a parallel cross-critique (each red-teams the RIVAL's plan).
        pl_p, pl_a = parallel([
            lambda: agent(PLAN_PROMPT, agent="planner", model=PLATO,
                          label="plan:plato", schema=PLAN_SCHEMA),
            lambda: agent(PLAN_PROMPT, agent="planner", model=ARISTOTLE,
                          label="plan:aristotle", schema=PLAN_SCHEMA)])
        cr_p, cr_a = parallel([
            # critique:plato = plato red-teaming aristotle's plan, and vice versa
            lambda: agent(_crit(json.dumps(pl_a)), agent="planner", model=PLATO,
                          label="critique:plato"),
            lambda: agent(_crit(json.dumps(pl_p)), agent="planner", model=ARISTOTLE,
                          label="critique:aristotle")])
        if TOPOLOGY == "debate":                 # 7 calls: exactly ONE revision round
            def _revise(own, rival, crit):
                return ("Revise YOUR plan below. You have the rival's competing plan "
                        "and a critique of your plan — address every valid point and "
                        "steal the rival's best ideas. In `notes`, record what you "
                        "changed and why.\n\nTASK:\n" + TASK + "\n\nYOUR PLAN:\n" + own +
                        "\n\nRIVAL PLAN:\n" + rival + "\n\nCRITIQUE OF YOUR PLAN:\n" + crit)
            rv_p, rv_a = parallel([
                # each revises its OWN plan given the rival + the critique it RECEIVED
                lambda: agent(_revise(json.dumps(pl_p), json.dumps(pl_a), cr_a),
                              agent="planner", model=PLATO,
                              label="revise:plato", schema=PLAN_SCHEMA),
                lambda: agent(_revise(json.dumps(pl_a), json.dumps(pl_p), cr_p),
                              agent="planner", model=ARISTOTLE,
                              label="revise:aristotle", schema=PLAN_SCHEMA)])
            plan = agent(_synth(
                "PLATO REVISED PLAN:\n" + json.dumps(rv_p) +
                "\n\nARISTOTLE REVISED PLAN:\n" + json.dumps(rv_a) +
                "\n\nCRITIQUE BY PLATO (of aristotle):\n" + cr_p +
                "\n\nCRITIQUE BY ARISTOTLE (of plato):\n" + cr_a),
                agent="planner", model=PLATO, label="synthesis", schema=PLAN_SCHEMA)
        else:                                    # duel: 5 calls, straight to synthesis
            plan = agent(_synth(
                "PLATO PLAN:\n" + json.dumps(pl_p) +
                "\n\nARISTOTLE PLAN:\n" + json.dumps(pl_a) +
                "\n\nCRITIQUE BY PLATO (of aristotle):\n" + cr_p +
                "\n\nCRITIQUE BY ARISTOTLE (of plato):\n" + cr_a),
                agent="planner", model=PLATO, label="synthesis", schema=PLAN_SCHEMA)

for p in plan["pieces"]:
    p["status"], p["summary"] = "pending", ""

S = {
    "meta": {"task": TASK.strip().split("\n")[0][:160], "slug": SLUG, "mode": MODE,
             "created": time.strftime("%Y-%m-%d %H:%M:%S"), "updated": "",
             "status": "awaiting_approval" if MODE == "interactive" else "building"},
    "spec": TASK,
    "plan": plan,
    "approval": {"state": "pending" if MODE == "interactive" else "auto",
                 "at": "" if MODE == "interactive" else time.strftime("%Y-%m-%d %H:%M:%S"),
                 "notes": ""},
    "progress_log": [], "review_rounds": [], "findings": [],
    "unresolved": [], "lessons": "", "ponytail_debt": [],
}
if ULTRA:
    S["meta"]["ultra"] = {"topology": TOPOLOGY, "plato": PLATO, "aristotle": ARISTOTLE}
_gc = {"crossreview": 3, "duel": 5, "debate": 7}.get(TOPOLOGY, 0) if ULTRA else 0
plog(S, "plan", f"plan ready: {plan['mode']}"
     + (f"/overlap={plan.get('overlap')}" if plan["mode"] == "parallel" else "")
     + f", {len(plan['pieces'])} piece(s)"
     + (f" [ultra:{TOPOLOGY}, {_gc} genius calls]" if ULTRA else ""))
print(json.dumps({"dashboard": PLAN_PATH, "plan": plan}, indent=2))
```

## 2. Approval gate (interactive mode only — auto goes straight to Cell 2)

1. **Open the dashboard**: `xdg-open .planning/<slug>/plan.html` (macOS: `open`).
   It live-refreshes; the user can keep it open for the whole run.
2. **Present the plan** in chat (shape, pieces, lenses, notes) and iterate. In an
   ultra run, also tell the user the topology and the rough genius spend — the
   `S["meta"]["ultra"]["topology"]` and its call count (crossreview 3 / duel 5 /
   debate 7 genius calls) — so they know what the two planners cost:
   - User gives feedback → apply it: either re-run the planner with the feedback
     folded in (re-assign `S["plan"]`, reset piece statuses, `save_state(S)`), or
     patch directly in a tiny eval (e.g. merge/edit/drop pieces), then re-present.
   - User says **"re-read"** (they edited the JSON in the file and saved) →
     `S = load_state()` and honor their edits.
3. **On approval**, run a tiny eval:
   ```py
   S = load_state()
   S["approval"] = {"state": "approved", "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "notes": "<any conditions the user attached>"}
   S["meta"]["status"] = "building"
   plog(S, "plan", "plan approved by user")
   ```
   Do **not** start Cell 2 until the user approves.

## 3. Cell 2 — EXECUTE → REVIEW → CONSOLIDATE (state-driven, resume-safe)

Author one eval cell: `SLUG = "..."` + HELPERS + this body. Everything derives
from the file, so this cell also works cold (resume) with no kernel state.

The review loop is **judge → verify → fix**: diverse reviewers (models from
`modelRoles.reviewers`) fan out per lens, the judge keeps the real findings, then
a per-finding **refute-verifier** re-checks each kept finding against the actual
code before any fixer runs — the judge rules on finding *text*, so this catches
plausible-but-wrong findings the judge can't. Verification is fail-open (a
verifier error keeps the finding) and gated by `VERIFY_FINDINGS`; only *confirmed*
findings reach fixers and `S["findings"]`. A round with nothing confirmed (all
refuted) counts as clean.

```py
S = load_state()
assert S["approval"]["state"] in ("approved", "auto"), "plan not approved — aborting"
plan, TASK = S["plan"], S["spec"]
S["meta"]["status"] = "building"
save_state(S)

MAX_ROUNDS = 3                   # hard cap on review->fix->reverify iterations
VERIFY_FINDINGS = True           # gate fixers behind refute-verifiers (blind-judge fix)
BUDGET_RESERVE = 60_000          # stop the loop if a hard budget dips below this

_cfg_roles = read_model_roles()  # one config read for the whole cell (pool + reviewers)

# Load-balance plain "task" spawns across subscriptions. omp role chains are
# fallback-only (no rotation; in-flight caps queue, not spill), so the pipeline
# routes explicitly via agent(model=...): deterministic round-robin by piece
# order, made SUBSCRIPTION-AWARE via omp's own durable usage ledger
# (~/.omp/agent/agent.db: usage_history + auth_credential_blocks — the same
# data `omp usage` shows). Pool entries are single model patterns, rotated +
# health-checked per provider; weight by repeating an entry. Configured via
# modelRoles.taskpool; an explicit taskpool:[] DISABLES pooling (model=None),
# while an ABSENT key yields the default pair. Explicit agents never pool.
TASK_MODEL_POOL = list(_cfg_roles["taskpool"] if "taskpool" in _cfg_roles
                       else ["openai-codex/gpt-5.6-terra:medium", "anthropic/claude-sonnet-5:high"])
POOL_FULL = 0.95          # used_fraction at/above which a subscription is "full"
POOL_SKIP = {}            # provider -> unix ts to skip until (reactive marks)
LIMIT_ERR = ("usage_limit_reached", "usage limit", "resource_exhausted",
             "insufficient_quota", "quota will reset", "exhausted your capacity",
             "rate limit", "no api key for provider", "no oauth credential available")
PIECE_IDX = {p["id"]: i for i, p in enumerate(plan["pieces"])}

def _prov(model): return model.split("/")[0]

def pool_healthy(model):
    # Proactive check against omp's ledger. Fail-open: read hiccup = healthy.
    import time
    if POOL_SKIP.get(_prov(model), 0) > time.time(): return False
    try:
        import sqlite3, os
        prov = _prov(model)
        db = sqlite3.connect("file:" + os.path.expanduser(
            "~/.omp/agent/agent.db") + "?mode=ro", uri=True)
        # usage_history is per ACCOUNT (multiple Max/Codex logins each write
        # their own rows). Health is per account; the provider is unhealthy
        # only when EVERY account is drained — omp natively hash-sticks each
        # subagent to an account and rotates off blocked siblings, so one
        # healthy account keeps the provider usable.
        rows = db.execute(
            "SELECT account_key, limit_id, status, used_fraction FROM usage_history "
            "WHERE provider=? AND (account_key, limit_id, recorded_at) IN ("
            "  SELECT account_key, limit_id, MAX(recorded_at) FROM usage_history"
            "  WHERE provider=? GROUP BY account_key, limit_id)",
            (prov, prov)).fetchall()
        n_creds = db.execute(
            "SELECT COUNT(*) FROM auth_credentials WHERE provider=? "
            "AND disabled_cause IS NULL", (prov,)).fetchone()[0]
        n_blocked = db.execute(
            "SELECT COUNT(DISTINCT credential_id) FROM auth_credential_blocks "
            "WHERE provider_key LIKE ? AND blocked_until_ms > ?",
            (prov + ":%", int(time.time() * 1000))).fetchone()[0]
        db.close()
        if n_creds and n_blocked >= n_creds: return False
        acct_ok = {}
        for ak, lid, status, frac in rows:
            # Ignore limits scoped to a model class this entry doesn't use
            # (anthropic:7d:fable must not gate a sonnet spawn).
            extra = [x for x in lid.lower().split(":")[1:]
                     if x not in ("primary", "secondary", "5h", "7d", "weekly", "default")]
            if extra and not any(x in model.lower() for x in extra): continue
            bad = status == "exhausted" or (frac or 0) >= POOL_FULL
            acct_ok[ak] = acct_ok.get(ak, True) and not bad
        if acct_ok and not any(acct_ok.values()): return False
    except Exception:
        pass
    return True

def pool_model(key, idx=None):
    # Deterministic round-robin, then walk forward past unhealthy entries.
    if not TASK_MODEL_POOL: return None
    import zlib
    i = idx if idx is not None else zlib.crc32(str(key).encode())
    order = [TASK_MODEL_POOL[(i + k) % len(TASK_MODEL_POOL)]
             for k in range(len(TASK_MODEL_POOL))]
    return next((m for m in order if pool_healthy(m)), order[0])

def pool_alt(mdl, err):
    # Reactive cross-provider fallback. omp flattens errors to plain strings
    # across the eval bridge (after <=3 fast internal same-provider retries),
    # so classify by substring (mirrors pi-ai error/flags.ts). A limit hit
    # skip-lists the provider for 30 min (dict write is GIL-atomic).
    if not mdl or not any(s in str(err).lower() for s in LIMIT_ERR): return None
    import time
    POOL_SKIP[_prov(mdl)] = time.time() + 1800
    return next((m for m in TASK_MODEL_POOL
                 if _prov(m) != _prov(mdl) and pool_healthy(m)), None)

LEAN = ("\n\nBuild LEAN (ponytail ladder): does this need to exist (YAGNI)? "
        "reuse what's already in the codebase → stdlib → native platform → an "
        "already-installed dep → one line → only then minimal new code. Smallest "
        "correct diff; no unrequested abstractions, scaffolding, or new deps; "
        "prefer a root-cause fix over a symptom patch. Mark deliberate shortcuts "
        "with a `// ponytail:` comment naming the ceiling + upgrade path. NEVER "
        "simplify away validation at trust boundaries, error handling, security, "
        "accessibility, or anything explicitly requested. Understand the full "
        "flow first, then be lazy.")
ESCALATE = ("\n\nIf after a genuine attempt you are STUCK — a failure you can't "
            "resolve, or the plan seems ambiguous/wrong for this piece — do NOT "
            "spawn a debugger yourself and do NOT thrash: stop, leave your work "
            "in place, and return status=stuck with kind (bug|design), what you "
            "tried, and the precise question. The pipeline will consult the "
            "architect or a debugger and re-dispatch you with guidance.")

def build_prompt(p, guidance=None):
    return (f"Implement this piece of the overall task.\n\nOVERALL TASK:\n{TASK}"
            f"\n\nPIECE {p['id']}:\n{p['description']}\n\nPlan notes: {plan['notes']}"
            + LEAN + ESCALATE
            + (f"\n\nESCALATION GUIDANCE (from a prior consult — act on it):\n{guidance}"
               if guidance else ""))

def consult(p, stuck):
    # Junior-engineer ladder, top rung: design questions -> the ARCHITECT (planner
    # CONSULT mode); mechanical failures -> the DEBUGGER. Both at depth 1 here, so
    # they keep full tools + their own research subagents at depth 2.
    if stuck["kind"] == "design":
        # Fresh eyes: in an ultra run the CHALLENGER (aristotle), not the plan's
        # author, re-adjudicates a design escalation — the model that red-teamed
        # the plan is best placed to reopen it. Legacy runs use the planner chain.
        u = S["meta"].get("ultra")
        return agent(
            "CONSULT mode. You are the architect of this plan; an implementer is "
            "stuck on a design question. Adjudicate — clarify intent, adjust the "
            "piece, or descope — and return concrete actionable guidance, not a "
            f"new plan.\n\nPLAN:\n{json.dumps(plan)}\n\nPIECE {p['id']}:\n"
            f"{p['description']}\n\nTRIED:\n{stuck['tried']}\n\nQUESTION:\n"
            f"{stuck['question']}",
            agent="planner", model=u["aristotle"] if u else None,
            label=f"consult:{p['id']}")
    return agent(
        "A worker is stuck on a hard failure. Find the ROOT CAUSE and return the "
        f"exact fix + how to verify.\n\nPIECE {p['id']}:\n{p['description']}\n\n"
        f"TRIED / ERROR:\n{stuck['tried']}\n\nQUESTION:\n{stuck['question']}",
        agent="deep-debugger", label=f"debug:{p['id']}")

def salvage_yield(label_frag):
    # A harness kill (e.g. "Soft request budget exceeded" — omp aborts a child at
    # 1.5x task.softRequestBudget) can land AFTER the child finished its work but
    # BEFORE its final yield's toolResult is recorded. The yield toolCall still
    # sits in the child's transcript — recover it before declaring the piece lost.
    import glob as _g, os as _os
    hits = sorted(_g.glob(_os.path.expanduser(
               f"~/.omp/agent/sessions/*/*/{label_frag}.jsonl"))
           + _g.glob(_os.path.expanduser(
               f"~/.omp/agent/sessions/*/*/{label_frag}-*.jsonl")),
           key=_os.path.getmtime)
    if not hits: return None
    def find(o):   # tolerant: entry shapes vary across omp versions
        if isinstance(o, dict):
            if (o.get("toolName") == "yield" or o.get("name") == "yield"):
                a = o.get("args") or o.get("arguments") or o.get("input")
                if isinstance(a, str):
                    try: a = json.loads(a)
                    except Exception: a = None
                if isinstance(a, dict) and "status" in a: return a
            for v in o.values():
                if (r := find(v)): return r
        elif isinstance(o, list):
            for v in o:
                if (r := find(v)): return r
        return None
    for line in reversed(open(hits[-1], errors="ignore").readlines()):
        if '"yield"' not in line: continue
        try: y = find(json.loads(line))
        except Exception: continue
        if y: return y
    return None

def run_build(p):
    # Non-isolated build with the stuck-signal contract: one consult, one guided
    # retry, then surface. Returns a record; NO shared-state writes (thread-safe
    # inside parallel() waves — the driver records results).
    ag = p.get("agent") or "task"
    mdl = pool_model(p["id"], PIECE_IDX.get(p["id"])) if ag == "task" else None
    if mdl: log(f"{p['id']} routed to {mdl}")
    try:
        r = agent(build_prompt(p), agent=ag, model=mdl, label=f"build:{p['id']}",
                  schema=BUILD_SCHEMA)
        if r["status"] == "stuck" and r.get("stuck"):
            log(f"{p['id']} stuck ({r['stuck']['kind']}) — consulting")
            guidance = consult(p, r["stuck"])
            r = agent(build_prompt(p, guidance), agent=ag, model=mdl,
                      label=f"build:{p['id']}:retry", schema=BUILD_SCHEMA)
        ok = r["status"] == "done"
        return {"id": p["id"], "ok": ok, "status": "done" if ok else "unresolved",
                "summary": r["summary"], "why": None if ok else (r.get("stuck") or r["summary"])}
    except Exception as e:
        # Before writing the piece off, check whether the child actually finished
        # and only its final yield was killed in flight (budget/abort races).
        sal = salvage_yield(f"build{p['id']}")
        if sal and sal.get("status") == "done":
            plog(S, "build", f"{p['id']}: salvaged done-yield after abort: {e}")
            return {"id": p["id"], "ok": True, "status": "done",
                    "summary": f"[salvaged after abort] {sal.get('summary','')}",
                    "why": None}
        # Subscription exhausted? Flip to the other pool provider and
        # re-dispatch this piece once there.
        alt = pool_alt(mdl, e)
        if alt:
            plog(S, "build", f"{p['id']}: {_prov(mdl)} limit hit — re-dispatching on {alt}")
            try:
                r = agent(build_prompt(p), agent=ag, model=alt,
                          label=f"build:{p['id']}:alt", schema=BUILD_SCHEMA)
                ok = r["status"] == "done"
                return {"id": p["id"], "ok": ok, "status": "done" if ok else "unresolved",
                        "summary": r["summary"], "why": None if ok else (r.get("stuck") or r["summary"])}
            except Exception as e2:
                e = e2
        return {"id": p["id"], "ok": False, "status": "unresolved",
                "summary": f"error: {e}", "why": f"error: {e}"}

def record(res):
    # Driver-side state write (sequentially, never from inside a wave).
    p = next(x for x in plan["pieces"] if x["id"] == res["id"])
    p["status"], p["summary"] = res["status"], str(res["summary"])[:400]
    if not res["ok"]:
        S["unresolved"].append({"id": res["id"], "why": res["why"]})
    plog(S, "build", f"{res['id']}: {res['status']}")

def safe_isolated(p):
    # Isolated builds stay schema-less (handle-node return); failures fall back to
    # run_build on the shared tree, where the stuck contract applies. merge=False
    # forces PATCH mode so node["patch_path"] is always set; apply=False keeps
    # edits in the worktree; reconcile serially in Synthesize (no concurrent-apply race).
    try:
        ag = p.get("agent") or "task"
        return {"id": p["id"], "ok": True,
                "node": agent(build_prompt(p), agent=ag,
                              model=pool_model(p["id"], PIECE_IDX.get(p["id"])) if ag == "task" else None,
                              label=f"build:{p['id']}", isolated=True,
                              apply=False, merge=False, handle=True)}
    except Exception as e:
        return {"id": p["id"], "ok": False, "error": str(e)}

todo = [p for p in plan["pieces"] if p.get("status") != "done"]   # resume-safe
phase("Execute")
if plan["mode"] == "sequential" or len(todo) <= 1:
    for p in todo:                              # shared tree, in order, no isolation
        p["status"] = "building"; save_state(S)
        record(run_build(p))
elif not plan.get("overlap"):
    # disjoint parallel -> shared tree directly (different files, no race)
    for p in todo: p["status"] = "building"
    save_state(S)
    for res in parallel([lambda p=p: run_build(p) for p in todo]):
        record(res)
else:
    # overlapping parallel -> isolated worktrees, collect patches, reconcile serially
    for p in todo: p["status"] = "building"
    save_state(S)
    built = parallel([lambda p=p: safe_isolated(p) for p in todo])
    patches = []
    for b in built:
        if b["ok"] and b["node"].get("patch_path"):
            patches.append(b["node"]["patch_path"])
            record({"id": b["id"], "ok": True, "status": "done",
                    "summary": "patch captured; merged in Synthesize", "why": None})
        elif b["ok"]:
            record({"id": b["id"], "ok": False, "status": "unresolved",
                    "summary": "isolated build returned no patch", "why": "no patch_path"})
        else:
            # isolation unavailable (task.isolation.mode == "none" / not a git
            # repo) or builder raised -> sequential on shared tree WITH escalation
            log(f"isolated build failed for {b['id']}; falling back sequential")
            p = next(x for x in todo if x["id"] == b["id"])
            record(run_build(p))
    if patches:
        phase("Synthesize")
        agent("Apply and reconcile these worktree patches onto the current working "
              "tree, in order, resolving conflicts so all pieces integrate. Then "
              "build/lint to confirm it compiles.\nPatches:\n" + "\n".join(patches),
              agent="task", label="synthesize")
        plog(S, "build", f"synthesized {len(patches)} patch(es)")

# ============================================================================
# REVIEW -> FIX -> REVERIFY  (real loop until a clean round)
# ============================================================================
S["meta"]["status"] = "reviewing"
save_state(S)
lenses = plan.get("review_lenses") or ["correctness", "security", "edge-cases", "design"]
if "over-engineering" not in lenses:      # standing ponytail lens
    lenses = lenses + ["over-engineering"]

def review_specs():
    # DIVERSE MODELS on ONE clean reviewer: deep-reviewer has no native output
    # schema, so the FINDINGS_SCHEMA call-site override applies cleanly (avoids
    # oh-my-pi #3926 with the bundled `reviewer`). Diversity via model= per lens.
    # `reviewers` is a DIVERSITY SET (entries alternate across lenses), NOT a
    # fallback chain — though each entry MAY itself be a comma-joined chain. An
    # empty diversity set is a misconfig, not a feature: fall back to the default.
    review_models = list(_cfg_roles.get("reviewers")
                         or ["anthropic/claude-opus-4-8:max", "openai-codex/gpt-5.6-sol:high"])
    return [{"agent": "deep-reviewer", "model": review_models[i % len(review_models)], "lens": lens}
            for i, lens in enumerate(lenses)]

def run_reviewer(s):
    rubric = ("" if s["lens"] != "over-engineering" else
        " Apply the ponytail (lazy-senior-dev) rubric: flag unnecessary abstractions "
        "(interface/factory/config with one use), scaffolding 'for later', a NEW "
        "dependency where stdlib/native/a few lines suffice, re-implementation of "
        "something already in the codebase, a symptom-patch where a shared root-cause "
        "fix is a smaller diff, and explanation longer than the code. For each, give "
        "the simpler alternative. Do NOT flag validation, error handling, security, "
        "accessibility, or explicitly-requested work — those are never 'bloat'.")
    try:
        r = agent(
            "Review the current UNCOMMITTED changes (inspect via `git diff` and read "
            "the touched files) that implement:\n" + TASK +
            f"\n\nFocus lens: {s['lens']}. Report ONLY real, patch-anchored defects."
            + rubric,
            agent=s["agent"], model=s["model"], label=f"review:{s['lens']}",
            schema=FINDINGS_SCHEMA)
        return r.get("findings", [])
    except Exception as e:                 # schema-violation / unknown-agent -> skip lens
        log(f"reviewer {s['agent']}/{s['lens']} failed: {e}")
        return []

round_n = len(S["review_rounds"])          # resume-safe: continue the count
while True:
    round_n += 1
    if budget.total and budget.remaining() < BUDGET_RESERVE:   # gate on total FIRST
        plog(S, "review", f"budget low ({budget.remaining()}); stopping at round {round_n}")
        break
    phase(f"Review round {round_n}")
    groups = parallel([lambda s=s: run_reviewer(s) for s in review_specs()])
    findings = [f for g in groups for f in g]
    for i, f in enumerate(findings):
        f["id"] = f"r{round_n}-{i}"
    if not findings:
        S["review_rounds"].append({"round": round_n, "found": 0, "kept": 0, "verdicts": []})
        plog(S, "review", f"round {round_n}: clean — no findings")
        break
    judged = completion(
        "You are the review judge. For each finding, keep=true ONLY if it is a real, "
        "in-scope defect worth fixing (drop nits, dupes, false positives). Then give a "
        "per-lens verdict.\nFINDINGS:\n" + json.dumps(findings),
        model="slow", schema=JUDGE_SCHEMA)
    keep_ids = {d["id"] for d in judged["decisions"] if d["keep"]}
    real = [f for f in findings
            if f["id"] in keep_ids and f["priority"] <= 1 and f["confidence"] >= 0.6]
    kept_n = len(real)   # judge-kept count, BEFORE the refute-verify gate
    # VERIFY (blind-judge fix): the judge rules on the finding TEXT, never the
    # code — so a plausible-but-wrong finding survives. Gate the fixers behind a
    # per-finding verifier that tries to REFUTE it against the real code; only
    # confirmed findings reach fixers / S["findings"]. Fail-OPEN (infra noise
    # must never silently drop a judge-kept finding). Zero-kept rounds spawn none.
    if VERIFY_FINDINGS and real:
        def verify_finding(f):
            try:
                v = agent("Try to REFUTE this code-review finding against the actual code. "
                          "Read the files; run cheap checks if useful. confirmed=true ONLY "
                          "with concrete evidence (file:line + why it is really a defect). "
                          "If you cannot confirm with evidence, it is refuted (confirmed=false)."
                          "\n\nTASK CONTEXT:\n" + TASK + "\n\nFINDING:\n" + json.dumps(f),
                          agent="task", model=pool_model(f["id"]), label=f"verify:{f['id']}",
                          schema=VERIFY_SCHEMA)
                return {**f, "verified": v["confirmed"], "evidence": v["evidence"]}
            except Exception as e:
                # fail-OPEN: infra noise must never silently drop a judge-kept finding
                return {**f, "verified": True, "evidence": f"verifier error (kept): {e}"}
        real = [f for f in parallel([lambda f=f: verify_finding(f) for f in real]) if f["verified"]]
    S["review_rounds"].append({"round": round_n, "found": len(findings),
                               "kept": kept_n, "confirmed": len(real),
                               "verdicts": judged["verdicts"]})
    S["findings"].extend(real)
    plog(S, "review", f"round {round_n}: {len(findings)} found, {kept_n} kept, {len(real)} confirmed")
    if not real:
        break
    if round_n >= MAX_ROUNDS:
        plog(S, "review", f"hit MAX_ROUNDS={MAX_ROUNDS} with {len(real)} open finding(s)")
        break
    # Fix on the SHARED tree (never isolated — fixes must accumulate so the next
    # round re-reviews them). Group by file; parallel across DISTINCT files only.
    phase(f"Fix round {round_n}")
    by_file = {}
    for f in real:
        by_file.setdefault(f["file_path"], []).append(f)
    def fix_file(path, items):
        body = "\n\n".join(
            f"- {x['title']} (L{x['line_start']}-{x['line_end']}): {x['body']}" for x in items)
        prompt = (f"Fix these confirmed review findings in {path}. Edit the shared "
                  f"working tree in place; do NOT create new files.\n{body}")
        mdl = pool_model(path)
        try:
            agent(prompt, agent="task", model=mdl, label=f"fix:{path}")
        except Exception as e:
            alt = pool_alt(mdl, e)
            try:
                if not alt: raise
                agent(prompt, agent="task", model=alt, label=f"fix:{path}:alt")
            except Exception as e2:
                log(f"fix failed for {path}: {e2}")
    parallel([lambda k=k, v=v: fix_file(k, v) for k, v in by_file.items()])
    plog(S, "review", f"round {round_n}: dispatched fixes for {len(by_file)} file(s)")
    # loop continues -> next round RE-REVIEWS the accumulated fixes

# ============================================================================
# CONSOLIDATE
# ============================================================================
phase("Consolidate")
S["meta"]["status"] = "done"
save_state(S)
print(json.dumps({
    "dashboard": PLAN_PATH,
    "plan": {"mode": plan["mode"], "overlap": plan.get("overlap"),
             "pieces": {p["id"]: p["status"] for p in plan["pieces"]}},
    "review_rounds": S["review_rounds"],
    "unresolved": S["unresolved"],
    # clean = last round left nothing CONFIRMED (a round whose findings were all
    # refuted breaks as clean too); no-findings rounds lack "confirmed" -> kept=0.
    "clean": bool(S["review_rounds"])
             and S["review_rounds"][-1].get("confirmed", S["review_rounds"][-1]["kept"]) == 0
             and not S["unresolved"],
}, indent=2))
```

## 4. After Cell 2 returns

1. Write the final **`## Lessons`** for the user (recurring mistakes, dead-ends,
   gotchas across planning/build/review — omp's per-repo memory captures this).
2. **Ponytail-debt harvest**: `git diff | grep -n 'ponytail:'` (+ grep touched
   files) → list marker → ceiling / upgrade path under **`## Ponytail debt`**.
3. **Patch both into the dashboard** with a tiny eval so the artifact is complete:
   ```py
   S = load_state()
   S["lessons"] = """..."""
   S["ponytail_debt"] = ["file:line — marker text", ...]
   save_state(S)
   ```
4. Point the user at `.planning/<slug>/plan.html` (final render, refresh stops).

## Resume (`/supership resume [slug]`)

1. Find the run: given a slug use it; else pick the newest `.planning/*/plan.html`
   whose `meta.status` is not `done`/`failed` (peek with grep or a tiny eval).
2. Author a tiny eval (`SLUG = ...` + HELPERS) with `S = load_state()`; branch on
   `S["meta"]["status"]`:
   - `awaiting_approval` → re-enter the **Approval gate** (present + refine).
   - `building` / `reviewing` → run **Cell 2** as-is: it skips `done` pieces and
     continues the review-round count from the file.
   - `planning`/`clarifying` (rare: died mid-plan) → restart Cell 1 with the
     stored `S["spec"]`.

## If an eval cell is interrupted mid-run (recovery — do NOT respawn)

An interrupted eval cell (`KeyboardInterrupt: Execution interrupted`) does **not**
kill the `agent()` jobs it spawned — they keep running in the background and
usually FINISH, writing their result to the session artifacts (`<label>.md`,
also retrievable with the eval `output("<job id>")` helper; check `/jobs`).

1. **Recover, don't redo.** Check the job first: still running → wait/poll it;
   finished → fetch its result (`output(...)` in a fresh eval cell, or read the
   artifact) and continue the pipeline from that exact point. Respawning burns
   the money already spent and orphans a live genius job.
2. **NEVER re-route planning/consult/debug to a generic worker as a "faster
   fallback".** The task tool's `role=` field is a display persona, NOT an agent
   selector — a task item without `agent="planner"` runs on the generic task
   worker (task-role model), silently swapping the genius brain for a cheap one.
   If you must use the task tool instead of eval, pass `agent=` explicitly.
   If the planner genuinely cannot run, STOP and tell the user — never downgrade.
3. Repeated interrupts are an environment problem to surface to the user, not to
   code around with a different (weaker) spawn path.

## Harness request-budget kills (`Soft request budget exceeded`)

omp caps each subagent at `task.softRequestBudget` requests (default 90): at the
budget it MAY steer the child to wrap up (only if `task.softRequestBudgetNotice`
is true), and at **1.5×** it hard-aborts — sometimes in the exact instant the
child is yielding `status="done"`, so the pipeline sees "error" while the work
is complete on disk. `run_build` salvages that case automatically
(`salvage_yield`). If a piece still lands unresolved with this error:
1. The child's edits SURVIVE in the working tree — `git status` before assuming
   loss; its transcript (`<session>/<label>.jsonl`) holds its findings.
2. Re-dispatch as a **continuation** ("prior work is on disk at <files>; verify
   and finish — do not restart"), never a from-scratch redo.
3. For heavy pieces (debuggers routinely need 150+ requests), tell the user to
   raise `task.softRequestBudget` and enable `task.softRequestBudgetNotice` so
   children get the wrap-up warning instead of a silent kill.

## Rules

- Use the CHEAPEST agent that fits each step. The genius agents (`planner`,
  `deep-debugger`) are for planning, consults, and hard diagnosis — never grunt work.
- **Agent selection is an invariant, not a preference:** plan/consult → `planner`,
  hard diagnosis → `deep-debugger`, review → `deep-reviewer` — always via an
  explicit `agent=`. A `role=` string alone NEVER substitutes for `agent=`.
- Only parallelize (and only isolate) when `planner` says `mode=parallel` **and**
  `overlap=true`. Isolation costs worktrees + a synthesis step.
- All dashboard writes happen at DRIVER level (between/after waves), never from
  inside `parallel()` thunks — last-write-wins races would drop sibling updates.
- If `$ARGUMENTS` is genuinely trivial, skip the ceremony — do it directly or with
  one `task` agent. This pipeline is for non-trivial work.
- The full escalation chain (`task` → `deep-debugger` → its scouts) needs
  `task.maxRecursionDepth >= 3` (set globally; default 2 blocks the innermost spawn).
