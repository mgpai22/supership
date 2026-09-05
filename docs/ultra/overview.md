---
title: Ultra mode
order: 1
description: Two logical planning seats and independent review judges.
---

# Ultra mode

`/ultraship` and `/ultrashipit` preserve the normal interactive and autonomous modes. They add two planning seats, assignments of agents and models. The architect owns the final plan. The critic supplies an independent alternative or critique according to the topology, the order of planning calls.

Seats are logical roles without fixed providers. A provider supplies model responses. Configure models through OMP agent definitions, role aliases, or `task.agentModelOverrides`. An alias provides an alternative model name. Alternatively, select an explicit override for the current run.

Missing required seats or models block the phase with diagnostics. Ultra never silently becomes a single-seat run.

Both seats receive the same cited research packet. The run records the resolved seat identity and source. A later global configuration edit does not silently redirect existing work. An override within one run must not alter global configuration or a sibling session.

For planning, choose [crossreview, duel, or debate](/docs/ultra/planning-topologies). Ultra review uses a separate sequence of risk-selected reviewers and two independent judges. Judge disagreement pauses work in the TUI, a terminal user interface.
