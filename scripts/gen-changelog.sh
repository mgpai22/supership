#!/usr/bin/env bash
# Regenerate the docs Changelog page from merged pull requests.
# Runs in CI before the docs build (needs `gh` + GH_TOKEN). Safe to run locally.
set -euo pipefail

REPO="${REPO:-mgpai22/supership}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/docs/changelog/changelog.md"

# MDX parses the markdown, so escape characters a PR title could carry that would
# otherwise break the build (< > { }).
esc() { sed -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/{/\&#123;/g' -e 's/}/\&#125;/g'; }

entries="$(gh pr list --repo "$REPO" --state merged --limit 300 \
  --json number,title,mergedAt,url \
  --jq 'sort_by(.mergedAt) | reverse | .[] | "- [#\(.number)](\(.url)) \(.title) (\(.mergedAt[0:10]))"' \
  | esc)"

{
  printf -- '---\ntitle: Changelog\norder: 1\ndescription: Merged Changes\n---\n\n'
  printf -- '# Changelog\n\n'
  printf -- 'Every merged pull request, newest first. Regenerated from GitHub on each deploy, so it always reflects what shipped.\n\n'
  if [ -n "$entries" ]; then printf -- '%s\n' "$entries"; else printf -- '_No merged pull requests yet._\n'; fi
} > "$OUT"

echo "wrote $OUT"
