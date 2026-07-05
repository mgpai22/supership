# /shipit — supership, fully autonomous (no interview, no approval gate)

Run the **exact** pipeline defined in `~/.omp/agent/commands/supership.md`, but
in **`MODE = "auto"`**. Read that file now and follow it with these deltas:

- **Skip Phase 0 (clarify) entirely.** Do not interview the user. `TASK` is the
  raw request below; the planner's own investigation stands in for clarification.
- **Skip the approval gate.** Cell 1 already sets `approval.state = "auto"` and
  `meta.status = "building"` in auto mode — run Cell 2 immediately after Cell 1.
- Everything else is identical: same HELPERS, same cells, same escalation,
  review loop, consolidate, lessons + ponytail-debt patch.
- Still open the dashboard (`xdg-open .planning/<slug>/plan.html`) right after
  Cell 1 — it is the user's live window into the autonomous run.
- `resume` works the same: `/shipit resume [slug]` → supership's Resume section
  (approval branch can't occur in auto runs).

If the task below is genuinely trivial, skip the ceremony — do it directly.

The task: **$ARGUMENTS**
