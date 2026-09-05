#!/usr/bin/env bash
# Delegate to the managed Crust installer. Default behavior is a dry run.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v bun >/dev/null 2>&1; then
  printf "%s\n" "Supership requires Bun >=1.3.14. Install Bun before running this wrapper." >&2
  exit 127
fi
exec bun "$REPO/src/cli.ts" install "$@"
