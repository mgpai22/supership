# /ultraship — supership with TWO genius planners (ultra)

Run the **exact** pipeline defined in `~/.omp/agent/commands/supership.md`, but
with the ultra dual-genius planner (`plato` = chief architect / consolidator,
`aristotle` = challenger). Read that file now and follow it with these deltas:

- **`ULTRA = True`** in the Cell 1 assignments.
- **`TOPOLOGY`**: if the FIRST word of `$ARGUMENTS` is `crossreview`, `duel`, or
  `debate`, that is the topology — strip it, and `TASK` is the REST of the
  arguments. Otherwise `TOPOLOGY = "duel"` and `TASK` is the full `$ARGUMENTS`.
- Everything else is **identical to `/supership`**: interactive mode
  (`MODE = "interactive"`) — the clarify interview (Phase 0) and the approval
  gate both run. When you present the plan, also tell the user the topology and
  its genius call count (crossreview 3 / duel 5 / debate 7).
- Cell 1 reads `modelRoles.plato` + `modelRoles.aristotle` from config itself and
  **loud-fails** if either is missing (it refuses to degrade to a single genius);
  configure them first (see the kit's `config/` and README).
- `resume` works the same: `/ultraship resume [slug]` → supership's *Resume*
  section (topology/seat info is stored in `meta.ultra`, so a resumed run keeps
  its ultra identity; planning has already finished by the time you can resume).

If the task below is genuinely trivial, skip the ceremony — do it directly.

The task: **$ARGUMENTS**
