#!/usr/bin/env python3
"""Generate a sample supership dashboard (examples/demo-plan.html) so you can
see the artifact without running a pipeline. Reuses the SHARED HELPERS block
from the command file itself — single source of truth, no reimplementation."""
import os, re, sys, textwrap

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "examples")

md = open(os.path.join(REPO, "omp", "commands", "supership.md")).read()
helpers = next(textwrap.dedent(f) for f in re.findall(r"```py\n(.*?)\n\s*```", md, re.S)
               if "SCHEMAS" in f and "save_state" in f)

g = {"SLUG": "demo", "log": lambda m: None}
exec(helpers, g)
# write straight to out_dir instead of ./.planning/demo
g["PLAN_DIR"], g["PLAN_PATH"] = out_dir, os.path.join(out_dir, "demo-plan.html")
g["TEMPLATE_PATH"] = os.path.join(REPO, "omp", "templates", "supership-plan.html")

S = {
 "meta": {"task": "Add retry with backoff to the tx submission path", "slug": "demo",
          "mode": "interactive", "created": "2026-07-05 17:40:00", "updated": "",
          "status": "done"},
 "spec": ("Add bounded retry (3 attempts, expo backoff + jitter) to SubmitTx.\n"
          "Decisions: reuse internal/utils backoff; no new deps.\n"
          "Non-goals: no idempotency-key redesign; no metrics changes."),
 "plan": {"mode": "parallel", "overlap": False,
          "notes": "p1 and p2 touch disjoint files; verify with make test after both.",
          "review_lenses": ["correctness", "edge-cases"],
          "pieces": [
            {"id": "p1", "agent": "task", "status": "done",
             "description": "Wrap SubmitTx in retry using utils.Backoff (3 attempts, jitter). Guard: never re-submit on definite-accept errors.",
             "summary": "Reused utils.RetryWithBackoff; 14-line diff; added table test."},
            {"id": "p2", "agent": "task", "status": "done",
             "description": "Surface retry count in the submit log line.",
             "summary": "One-line change + test update."},
            {"id": "p3", "agent": "task", "status": "unresolved",
             "description": "Handle mempool-full: distinguish transient vs terminal.",
             "summary": "stuck: upstream error codes ambiguous — escalated to architect; descoped to follow-up."}]},
 "approval": {"state": "approved", "at": "2026-07-05 17:46:10",
              "notes": "approved after merging old p2+p3"},
 "progress_log": [
   {"t": "17:45:02", "phase": "plan", "msg": "plan ready: parallel/overlap=False, 3 piece(s)"},
   {"t": "17:46:10", "phase": "plan", "msg": "plan approved by user"},
   {"t": "17:49:33", "phase": "build", "msg": "p1: done"},
   {"t": "17:49:41", "phase": "build", "msg": "p2: done"},
   {"t": "17:52:07", "phase": "build", "msg": "p3: unresolved"},
   {"t": "17:58:20", "phase": "review", "msg": "round 1: 3 found, 1 kept"},
   {"t": "18:03:11", "phase": "review", "msg": "round 2: clean — no findings"}],
 "review_rounds": [
   {"round": 1, "found": 3, "kept": 1, "verdicts": [
     {"lens": "correctness", "verdict": "issues_remain",
      "explanation": "retry can double-submit on timeout"},
     {"lens": "edge-cases", "verdict": "clean", "explanation": ""},
     {"lens": "over-engineering", "verdict": "clean", "explanation": ""}]},
   {"round": 2, "found": 0, "kept": 0, "verdicts": []}],
 "findings": [
   {"id": "r1-0", "title": "Timeout ambiguity can double-submit a tx",
    "body": ("A submit that times out may still land on-chain; blind retry "
             "re-broadcasts. Fix: check mempool/confirmation before re-submitting."),
    "file_path": "internal/tx/submit.go", "line_start": 42, "line_end": 58,
    "priority": 0, "confidence": 0.9}],
 "unresolved": [{"id": "p3", "why": {"kind": "design", "tried": "mapped upstream codes",
                                     "question": "is mempool-full terminal for our backend?"}}],
 "lessons": ("- Timeout != failure for tx submission: always check before re-broadcast.\n"
             "- Upstream error taxonomy is ambiguous; descope early rather than guess."),
 "ponytail_debt": ["internal/tx/submit.go:51 — ponytail: fixed 3 attempts; make configurable if ops asks"],
}
g["save_state"](S)
print("wrote", g["PLAN_PATH"])
