---
name: grill
description: Relentlessly interview the user to stress-test a plan or design BEFORE building — align on scope, surface hidden assumptions, pin down edge cases and acceptance criteria, and reach a shared understanding. Use when the user wants to pressure-test an approach, clarify a vague request, or uses any "grill" / "grill me" / "clarify" trigger phrase. Not for non-coding requests.
---

# Grill

Interview the user relentlessly about this task/plan until you reach a genuine
shared understanding. You are pressure-testing the idea, not being agreeable.
**Do not start building until the user explicitly confirms you're aligned.**

## How to ask

- **One question at a time.** Wait for the answer before the next. Asking several
  at once is bewildering and gets shallow answers.
- **Every question carries your recommended answer.** Propose the default you'd
  pick and why; let the user confirm or override. Never ask a bare open question.
- **Walk the decision tree in dependency order.** Resolve upstream decisions before
  the ones that hang off them. Start with the riskiest unknown — the answer that
  changes the most downstream.
- **Self-serve from the code first.** If a question is answerable by reading the
  codebase, read it instead of asking. Only ask what the code genuinely can't tell
  you.
- **Be specific and actionable.** "Please provide more info" is useless. Challenge
  fuzzy or overloaded terms ("you said 'account' — the Customer or the User?"),
  invent concrete edge-case scenarios that force precise boundaries, and
  cross-check the user's claims against what the code actually does.

## What to pin down

Cover, as relevant: exact scope and **non-goals** (what you will NOT do); hard
constraints; the data shapes / inputs / outputs; **error, empty, and boundary
states**; failure modes and what happens on each; hidden assumptions; performance
or scale expectations; and **acceptance criteria** — how you'll both know it's
done and correct.

## Rules

- Keep a running **"established so far"** recap of what's been resolved, so nothing
  is lost as the interview grows.
- **No question cap, no self-declared clarity.** You don't decide when it's clear —
  the user does. Keep going until they sign off.
- Offer a fast path: the user can say "accept your recommendations and go" to take
  all your defaults, or "stop grilling" to end early.
- On sign-off, write a short **clarified spec**: exactly what to build, the agreed
  decisions, and the non-goals. That is what the actual work should follow.

Governs understanding, not tone. Stop only when the user confirms alignment.
