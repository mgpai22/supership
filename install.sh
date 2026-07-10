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

echo "== ax (web fetch/extract CLI)"
# Pinned + vendored. Upstream is 4 days old with 5 releases in 36h, so we pin the
# binary AND vendor skills/ax at the SAME version so the agent instructions match
# the binary's behavior. Re-pin deliberately: bump AX_VERSION and re-vendor SKILL.md.
AX_VERSION="0.1.5"
AX_INSTALL_DIR="${AX_INSTALL_DIR:-$HOME/.local/bin}"
install_ax() {
  if command -v ax >/dev/null 2>&1; then
    echo "  = ax already on PATH ($(ax --version 2>/dev/null || echo '?')) — skipping install"
    return 0
  fi
  if [ -x "$AX_INSTALL_DIR/ax" ]; then
    echo "  = ax already at $AX_INSTALL_DIR/ax ($("$AX_INSTALL_DIR/ax" --version 2>/dev/null || echo '?')) — skipping install"
    return 0
  fi

  local os arch asset url sum_url dest expected actual sha
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux|darwin) ;;
    *) echo "  ! unsupported OS '$os' — install manually: https://ax.yusuke.run"; return 0 ;;
  esac
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "  ! unsupported arch '$arch' — install manually: https://ax.yusuke.run"; return 0 ;;
  esac

  asset="ax-$os-$arch"
  url="https://github.com/yusukebe/ax/releases/download/v$AX_VERSION/$asset"
  sum_url="https://github.com/yusukebe/ax/releases/download/v$AX_VERSION/checksums.txt"

  # darwin has no sha256sum; fall back to shasum -a 256
  if command -v sha256sum >/dev/null 2>&1; then sha="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then sha="shasum -a 256"
  else echo "  ! no sha256sum/shasum available — cannot verify, skipping ax"; return 0; fi

  mkdir -p "$AX_INSTALL_DIR"
  dest="$AX_INSTALL_DIR/ax"

  echo "  downloading $asset (v$AX_VERSION)"
  if ! curl -fsSL "$url" -o "$dest.tmp"; then
    echo "  ! download failed ($url) — skipping ax (install later: https://ax.yusuke.run)"
    rm -f "$dest.tmp"; return 0
  fi

  expected="$(curl -fsSL "$sum_url" 2>/dev/null | grep " $asset\$" | awk '{print $1}' || true)"
  if [ -z "$expected" ]; then
    echo "  ! could not fetch checksum for $asset — refusing to install unverified binary, skipping ax"
    rm -f "$dest.tmp"; return 0
  fi
  actual="$($sha "$dest.tmp" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "  ! CHECKSUM MISMATCH for $asset"
    echo "      expected $expected"
    echo "      actual   $actual"
    echo "    refusing to install a bad binary — deleting download, skipping ax"
    rm -f "$dest.tmp"; return 0
  fi
  echo "  checksum OK ($asset sha256 $expected)"

  mv -f "$dest.tmp" "$dest"
  chmod +x "$dest"
  echo "  + $dest ($("$dest" --version 2>/dev/null || echo installed))"

  case ":$PATH:" in
    *":$AX_INSTALL_DIR:"*) ;;
    *) echo "  ! $AX_INSTALL_DIR is not on PATH — add it so 'ax' resolves" ;;
  esac
}
install_ax || echo "  ! ax install step failed — continuing (install manually: https://ax.yusuke.run)"

echo "== ax skill -> $SKILLS_HUB/ax (shared hub: omp + Codex read it directly)"
mkdir -p "$SKILLS_HUB"
if [ "$MODE" = "link" ]; then ln -sfn "$REPO/skills/ax" "$SKILLS_HUB/ax"
else mkdir -p "$SKILLS_HUB/ax" && cp -f "$REPO/skills/ax/SKILL.md" "$SKILLS_HUB/ax/"; fi
echo "  + $SKILLS_HUB/ax"
if [ -d "$HOME/.claude/skills" ] && [ ! -e "$HOME/.claude/skills/ax" ]; then
  ln -s "../../.agents/skills/ax" "$HOME/.claude/skills/ax"
  echo "  + ~/.claude/skills/ax (symlink — Claude Code only scans ~/.claude/skills)"
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
