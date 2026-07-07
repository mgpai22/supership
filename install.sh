#!/usr/bin/env bash
# Installer for the supership agent kit.
#   ./install.sh              copy files into place (safe default)
#   ./install.sh --link       symlink instead of copy (repo stays the source of truth)
#   ./install.sh --config     also apply config keys via `omp config set`
# Idempotent; never overwrites an existing APPEND_SYSTEM.md that differs.
set -euo pipefail

MODE="copy"; APPLY_CONFIG=0
for a in "$@"; do
  case "$a" in
    --link) MODE="link" ;;
    --config) APPLY_CONFIG=1 ;;
    *) echo "usage: $0 [--link] [--config]"; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMP_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
SKILLS_HUB="$HOME/.agents/skills"

put() {  # put <src> <dst>
  mkdir -p "$(dirname "$2")"
  if [ "$MODE" = "link" ]; then ln -sfn "$1" "$2"; else cp -f "$1" "$2"; fi
  echo "  + $2"
}

echo "== omp commands / agents / templates -> $OMP_DIR"
for f in "$REPO"/omp/commands/*.md;  do put "$f" "$OMP_DIR/commands/$(basename "$f")"; done
for f in "$REPO"/omp/agents/*.md;    do put "$f" "$OMP_DIR/agents/$(basename "$f")"; done
for f in "$REPO"/omp/templates/*;    do put "$f" "$OMP_DIR/templates/$(basename "$f")"; done

echo "== APPEND_SYSTEM.md"
if [ ! -e "$OMP_DIR/APPEND_SYSTEM.md" ]; then
  put "$REPO/omp/APPEND_SYSTEM.md" "$OMP_DIR/APPEND_SYSTEM.md"
elif cmp -s "$REPO/omp/APPEND_SYSTEM.md" "$OMP_DIR/APPEND_SYSTEM.md"; then
  echo "  = unchanged"
else
  echo "  ! $OMP_DIR/APPEND_SYSTEM.md exists and differs — NOT overwriting."
  echo "    merge manually from $REPO/omp/APPEND_SYSTEM.md"
fi

echo "== grill skill -> $SKILLS_HUB/grill (shared hub: omp + Codex read it directly)"
mkdir -p "$SKILLS_HUB"
if [ "$MODE" = "link" ]; then ln -sfn "$REPO/skills/grill" "$SKILLS_HUB/grill"
else mkdir -p "$SKILLS_HUB/grill" && cp -f "$REPO/skills/grill/SKILL.md" "$SKILLS_HUB/grill/"; fi
echo "  + $SKILLS_HUB/grill"
if [ -d "$HOME/.claude/skills" ] && [ ! -e "$HOME/.claude/skills/grill" ]; then
  ln -s "../../.agents/skills/grill" "$HOME/.claude/skills/grill"
  echo "  + ~/.claude/skills/grill (symlink — Claude Code only scans ~/.claude/skills)"
fi

if [ "$APPLY_CONFIG" = 1 ]; then
  echo "== config (via omp config set — merges into your global config.yml)"
  command -v omp >/dev/null || { echo "  ! omp not on PATH; apply config/config.snippet.yml manually"; exit 1; }
  omp config set task.maxRecursionDepth 3
  omp config set task.softRequestBudget 250
  omp config set task.softRequestBudgetNotice true
  omp config set modelRoles "$(cat "$REPO/config/modelRoles.json")"
  echo "  + task.maxRecursionDepth=3, softRequestBudget=250 (+notice), modelRoles applied"
  echo "  (compaction/memory keys: see config/config.snippet.yml — apply if wanted)"
else
  echo "== config: skipped (run with --config, or merge config/config.snippet.yml by hand)"
  echo "   REQUIRED for full escalation: task.maxRecursionDepth >= 3"
  echo "   REQUIRED for heavy builds: task.softRequestBudget >= 250 + softRequestBudgetNotice=true"
  echo "   (omp's default 90 hard-kills subagents at 135 requests, with no warning)"
  echo "   CRITICAL: modelRoles fallback chains must be comma STRINGS, not YAML lists (omp #4492)"
fi

echo
echo "Done. Restart your omp session, then try:  /supership <task>   or   /shipit <task>"
