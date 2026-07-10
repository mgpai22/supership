---
title: Frontend and design
order: 2
description: The Designer Agent and Routing
---

# Frontend and design

Anything user-facing routes through the `designer` agent, omp's UI/UX specialist (model `pi/designer`), instead of the generic `task` worker. The designer is design-system-first and accessibility-aware, and it handles frontend end to end: build, review, and fix. There is no new config; this reuses the existing `modelRoles.designer` chain.

## Build

The planner tags any piece whose primary deliverable is UI as `agent="designer"` (building frontend from scratch, modifying it, or improving it). The build wave dispatches those pieces to the designer, with no pooling. Backend, API, and data pieces stay `task`. This is a semantic call the planner makes at plan time. See [Planning](/pipeline/planning).

## Review

When the change touched frontend, the review loop adds a **design lens**.

- On a normal run, the design lens is reviewed by the designer (it does not consume a reviewer-model slot, which keeps the diversity alternation stable).
- On an ultra run, the design rubric is folded into the `plato` and `aristotle` duel instead of spawning a third reviewer.

## Fix

Review fixes on a frontend file are dispatched to the designer, not the task pool, so the agent correcting UI findings has design instincts too. If the designer fix errors, it falls back to the task pool.

## is_frontend detection

Build routing is the planner's semantic call. Review and fix routing is mechanical, because after the fact the only signal available is the file path. The `is_frontend(path)` check matches a known UI extension or a UI-ish path segment.

- **Extensions:** `.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.sass`, `.less`, `.html`, `.htm`, `.mdx`.
- **Path segments:** `components`, `component`, `styles`, `style`, `ui`, `pages`, `views`, `layouts`.

The check is approximate and tunable. A `.ts` file full of DOM logic will not match, which is an accepted tradeoff. `/superreview` uses the same `is_frontend` signal over its diff.

> [!NOTE]
> Two detection paths, split by where they happen. Build routing is the planner's call, encoded in the piece `agent`. Review and fix routing is the mechanical `is_frontend(path)` glob. Both send frontend work to the same designer.
