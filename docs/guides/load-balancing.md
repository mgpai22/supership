---
title: Load balancing
order: 3
description: The Task Pool and Health Checks
---

# Load balancing

omp's `modelRoles` chains are fallback-only. The first resolvable model always wins, there is no native rotation, and a provider's in-flight cap queues work rather than spilling it to another provider. So the pipeline load-balances plain `task` spawns itself, across models and subscriptions, via `agent(model=...)`.

This covers plain `task` builders, fixers, and review verifiers. **Genius agents never pool.** The planner, deep-debugger, and the ultra seats always run their own explicit chains.

## Task pool

The pool is configured, not a cell constant. It comes from `modelRoles.taskpool`.

- Entries are single model patterns.
- Weight an entry by repeating it in the list.
- `taskpool: []` **disables** pooling, so spawns run with `model=None`.
- Omitting the key falls back to the shipped default pair.

## Round-robin

Routing is deterministic by piece order (which is what makes it resume-safe). Each spawn picks a pool entry by a stable index derived from the piece id or its position, then walks forward past any unhealthy entry.

## Health checks

Routing is subscription-aware in two layers, both reading omp's own durable usage ledger at `~/.omp/agent/agent.db` (the same data `omp usage` shows).

**Proactive.** Before each spawn, the pipeline reads the ledger (`usage_history` for the used-fraction and status per limit window, plus `auth_credential_blocks`) and walks past any pool entry whose subscription is exhausted (at or above `POOL_FULL`, default 0.95) or whose credentials are all blocked. Model-class-scoped limits are respected, so an exhausted `anthropic:7d:fable` window does not gate a sonnet spawn. The check is **fail-open**. If the ledger cannot be read, the entry counts as healthy.

**Reactive.** If a spawn dies with a usage-limit, quota, or auth-exhaustion error (omp gives up after at most three fast internal same-provider retries), the pipeline re-dispatches that piece once on the other provider and skip-lists the failed provider for 30 minutes, so subsequent pieces route away proactively. Ordinary task failures never trigger cross-provider fallback.

## Multiple accounts

Several Claude Max or Codex logins compose cleanly. omp natively hash-sticks each subagent session to one account and rotates off blocked or exhausted siblings, so intra-provider spreading is automatic. The proactive check evaluates the ledger per account and only marks a provider unhealthy when every account is drained or credential-blocked. One healthy Max account keeps the whole anthropic pool entry usable.

> [!NOTE]
> `taskpool` is a **pool** (round-robin plus health checks), which is a different thing from a fallback chain (first resolvable wins) or the `reviewers` **diversity set** (entries alternate across lenses). See [Configuration](/reference/configuration).
