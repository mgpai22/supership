---
title: Load balancing
order: 3
description: Logical seats, explicit fallback, and run limits.
---

# Load balancing

OMP resolves models from agent definitions, role aliases, and `task.agentModelOverrides`. An alias provides an alternative model name. Supership records logical seats, assignments of agents and models. Overrides within one run do not change global configuration or sibling sessions.

A `modelRoles` list defines an ordered model selection sequence. It does not distribute requests in rotation. It does not guarantee that a model request succeeds. If a provider fails, an explicitly configured fallback policy determines the alternative. A provider supplies model responses.

The old task-pool rotation, usage-database scraping, and per-call model argument on `agent()` are not part of this package. Supership does not read private OMP account tables to guess provider health.

## Independent seats

Concurrent reviewers can use distinct seats and model assignments. Ultra requires both planning seats and both judge seats. Missing agents/models block the phase. The engine does not silently choose a default model or drop a reviewer.

The engine retains source and model origins for recovery. A declared fallback differs from an undeclared model switch. Invalid structured output receives one same-seat correction and one configured fallback attempt. Unresolved output blocks the action.

## Limits

Live OMP concurrency, the number of simultaneous tasks, is the ceiling. A run can specify a lower ceiling. Supership does not raise the global OMP limit. WorkPool schedules repeated independent items. It does not rotate models.

No new finite token, cost, wall-time, or review-round cap applies by default. Tokens are units of model input and output. Wall-time is elapsed clock time.

Interactive planning asks about unspecified limits. Autonomous runs use configured defaults. Work pauses when it reaches a limit. Unknown pricing stays unknown. Active provider requests can exceed a measured budget before the next observable boundary.
