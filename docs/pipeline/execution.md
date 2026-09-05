---
title: Execution
order: 3
description: Dependency-safe work and strict results.
---

# Execution

The engine starts work only after its dependencies finish under the current plan revision. Each assignment names its seat, paths, expected output, prior evidence, tool grants, and verification. A seat assigns an agent and model. A grant authorizes access to a tool. Verification establishes whether requirements pass.

Independent items can proceed concurrently within the live OMP ceiling and any lower run ceiling.

Overlapping edits never proceed concurrently. Separate working copies can isolate independent builders. Isolation cannot make competing writes safe to merge. Before integration, the combination of changes, the engine makes sure that the baseline and external changes permit safe updates. The baseline records the starting repository state.

## Task and eval contracts

The main session controls finite task or agent groups. Current JavaScript helpers return promises, references to future results.

Await `agent()` to obtain its handle, a reference to active work. Then await `handle.wait()` or `wait(handles)` for results.

For repeated independent items within one scope, use WorkPool. WorkPool schedules tasks. It does not store durable state, records that survive process loss.

Product control cells, managed blocks of code, carry action identities and report receipts, records of observed results. The engine makes sure that each action identity matches the current work. Do not replace them with a manually written driver.

Supership does not depend on removed Python coordination helpers. It does not use per-call model parameters on `agent()`.

The invocation supplies a strict output schema, the required result structure. Workers finalize with the native OMP top-level yield tool according to its shown schema. On OMP 18.1.10, a nested eval-bridged yield does not finalize the child. Eval means code evaluation within a persistent session.

Prose and fenced JSON do not substitute for a valid terminal result.

## Failure and evidence

An invalid result receives one correction attempt on the same seat. It then receives one configured fallback attempt, an alternative after failure. Failure after that blocks the action. The engine does not accept unstructured prose instead.

Before another attempt, reconcile effects by comparing recorded and observed work. A builder can change files even if its result is invalid or missing. Before an adopt/retry/discard decision, inspect its worktree, patches, receipts, and artifacts. A worktree is a separate repository working copy. Artifacts retain work evidence.

A worker assertion that checks passed is not sufficient evidence. Record the actual command, result, applicable output or artifact, and the code version that the command covers. No universal test command replaces the repository instructions.

## Parent access

Only the orchestrator, the agent that coordinates work, registers dynamic tools. A granted callback, a function that another task invokes, operates in the parent JavaScript kernel, the persistent JavaScript environment. This applies even when its caller has an isolated worktree.

Label this as worktree isolation with parent access. The captured child patch excludes parent writes. Those writes need separate ownership evidence and review.
