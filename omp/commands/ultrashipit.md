# /ultrashipit — supership with TWO genius planners, fully autonomous (ultra)

Run the **exact** pipeline defined in `~/.omp/agent/commands/supership.md` with
the ultra dual-genius planner (`plato` = chief architect / consolidator,
`aristotle` = challenger), in **`MODE = "auto"`**. Read that file now and follow
it with these deltas:

- **`ULTRA = True`** in the Cell 1 assignments.
- **`TOPOLOGY`**: if the FIRST word of `$ARGUMENTS` is `crossreview`, `duel`, or
  `debate`, that is the topology — strip it, and `TASK` is the REST of the
  arguments. Otherwise `TOPOLOGY = "duel"` and `TASK` is the full `$ARGUMENTS`.
- **Skip Phase 0 (clarify) entirely.** Do not interview the user. `TASK` is the
  raw request (minus a leading topology word); the two planners' own
  investigation stands in for clarification.
- **Skip the approval gate.** Cell 1 sets `approval.state = "auto"` and
  `meta.status = "building"` in auto mode — run Cell 2 immediately after Cell 1.
- Everything else is identical: same HELPERS, same cells, same escalation (with
  the ultra fresh-eyes consult — a `design` escalation goes to the challenger),
  review loop, consolidate, lessons + ponytail-debt patch.
- Still open the dashboard (`xdg-open .planning/<slug>/plan.html`) right after
  Cell 1 — it is the user's live window into the autonomous run.
- Cell 1 reads `modelRoles.plato` + `modelRoles.aristotle` from config itself and
  **loud-fails** if either is missing (it refuses to degrade to a single genius).
- `resume` works the same: `/ultrashipit resume [slug]` → supership's *Resume*
  section (the approval branch can't occur in auto runs).

If the task below is genuinely trivial, skip the ceremony — do it directly.

The task: **$ARGUMENTS**
