---
title: ax web fetch
order: 5
description: The Web Fetch and Extract CLI
---

# ax web fetch

`ax` is the AI-era curl. It fetches a URL, discovers page structure, and extracts rows or tables in one command.

## Why the kit ships it

Agents reach for `curl` and get nothing back on an empty body. Or they dump raw HTML into context and blow the token budget. Or they hand-roll regex over markup that breaks on the next page. `ax` replaces all three. It returns structured status and body, never goes silent, and caps output at 50 rows by default so a page cannot flood the window. The kit ships a matching `ax` skill so every agent knows the discover-then-extract workflow.

## Cheatsheet

```sh
ax https://api.site.example/users                 # {status, ok, ms, headers, body}
ax https://api.site.example/x -H 'authorization: Bearer k' -X POST -d '{"a":1}'
ax https://site.example --outline                 # discover repeating structures
ax https://site.example --locate 'some text'      # find which selector holds text
ax https://site.example '.card' --count           # confirm a hypothesis
ax https://site.example '.card' --row 'title=a, href=a@href'
ax https://site.example 'table' --table --where 'Stars >= 30000'
ax https://docs.site.example/guide --md --budget 800
```

Fetch or `--outline` once, `--locate` or `--count` to confirm, then one `--row` or `--table` call. Repeat fetches of the same URL are cached for about two minutes, so probing is cheap. Every extraction prints `N rows extracted` on stderr, which is the verification.

## Install

`ax` is pinned to v0.1.5 and vendored next to the skill so the agent instructions match the binary. `install.sh` installs it automatically into `~/.local/bin` (override with `AX_INSTALL_DIR`), verifies the download against the published sha256 checksum, and skips when `ax` is already present. If you already had a different `ax` version installed, the installer keeps yours, so the skill-matches-binary guarantee only holds for the auto-installed pin. To install by hand, run `curl -fsSL https://ax.yusuke.run/install | sh`.

## When not to use it

- JS-rendered SPAs. If `ax` reports a likely SPA, the data is not in the raw HTML, so switch to the browser tool.
- Local files and non-web work. Use your normal read and search tools.
