---
title: Installation
order: 2
description: Dry-run first managed local package installation.
---

# Installation

The upgrade targets Linux, Git, Bun `>=1.3.14`, and OMP `>=18.1.10 <18.2.0`.

At startup, Supership makes sure that OMP provides the required version and features. It also resolves seats, the assignments of agents and models. Supership refuses OMP Plan Mode and supports Code Mode.

The complete offline suite and typecheck passed with compiled OMP 18.1.11 and SDK 18.1.10 fixtures. Typecheck detects incompatible code types. SDK means software development kit. Fixtures supply controlled test inputs.

These commands describe the managed CLI, a command-line interface. They do not establish that an installation uses the new package.

## Local preparation

From the canonical checkout, the primary repository copy, install the pinned local dependencies:

```sh
bun install --frozen-lockfile
bun src/cli.ts --help
bun src/cli.ts doctor --cwd .
./install.sh --dry-run
```

`install.sh` delegates to `bun src/cli.ts install`. The install command defaults to a dry run, a preview without changes. It does not operate the old copy installer.

The installer does not download `ax`, install shared skills, or apply global model configuration. Old `--link` and `--config` wrapper flags no longer select an installation mode.

## Review the migration plan

```sh
bun src/cli.ts migrate --dry-run
bun src/cli.ts migrate --dry-run --siftly /path/to/siftly/.omp --palmyra /path/to/palmyra/.omp
```

The CLI computes its own read-only inventory and plan. Do not use native `omp plugin link` as a dry run. Its dry-run behavior is not a safe substitute for this inventory.

Inspect every path, checksum, source, proposed effect, and policy mapping. A checksum identifies file content. A policy mapping connects old rules to their replacements.

To select locations, use `--canonical-root`, `--agent-root`, `--plugin-root`, and `--backup-root`. `--manifest` selects an explicit versioned managed manifest, a file that declares installation ownership and operations. `--include-protected` includes protected-source proposals for inspection. It does not authorize replacement.

A manifest is trusted input. It can name arbitrary absolute roots and claim ownership through current file digests, which identify file content. That claim can remove the individual confirmation requirement.

Before use, review all manifest roots, baseline digests, content, modes, and effects. CAUTION: An untrusted manifest can authorize changes to files that Supership does not own.

Supership supports custom fixture and installation roots. The CLI makes sure that schemas and paths meet its requirements. These requirements do not establish ownership. A schema defines the required data structure.

Unsafe inventory paths appear in `blockers`. The plan still lists the remaining inspected operations. No confirmation bypasses inventory blockers. A malformed manifest fails before inventory access.

Known inventory also retains policy-mapping blockers. An unknown workflow cannot disappear without an explicit reviewed mapping.

The target is one canonical local package and one global registration. Use your checkout as the canonical package. Repository overlays, local additions to policy, contain policy and configuration only.

The package loads one extension and exactly three root personas, reusable agent instructions. It does not register old Markdown commands.

## Confirmed application

Before `--apply --confirm <plan-sha256>`, review the complete dry-run output. CAUTION: This command changes installation paths and registration.

For modified managed files, review their full diff or content. A diff shows changes between file versions. Approve each file with `--confirm-file <token>`. Copy each exact `operations[].confirmation` token from the reviewed plan. Repeat that flag for each approved file.

A token is `file:` plus the SHA-256 of a JSON tuple. The tuple contains the operation direction, root ID, relative path, absolute target, and before/after snapshots.

Colons in roots or paths cannot combine two approvals. The CLI rejects the old colon-joined root/path/digest spelling. Changed bytes, modes, or targets invalidate prior approval. Backups preserve original bytes outside active discovery before replacement.

If a required policy item changes but retains its ID, the proposal shows a full overlay diff. That change requires per-file confirmation. The proposal retains unrelated custom rules and requires the current mandatory policy.

Original file content and modes remain unchanged until exact approval. Refusal does not discard a customized rule.

`omp/agents/review-orchestrator.md` and `omp/agents/kimi-reviewer.md` are protected user work. Supership preserves their exact source bytes until full-content or diff review and final confirmation. A matching filename does not prove ownership.

Known global, Siftly, and Palmyra installations require inventory and confirmed migration. Existing local rules, independent commands, shell approvals, and unrelated files must remain. A new registration alone does not prove that old commands no longer shadow it.

After a confirmed migration, restart OMP. Operate `doctor`. Make sure that the expected commands and personas own each name. Until each known target passes, do not report installation complete.

## Interrupted migration

Preview the original journal before retry:

```sh
bun src/cli.ts migrate --recover /path/to/journal.json
```

After review, use `--apply --confirm <original-plan-sha256>` with the same required `--confirm-file` tokens. CAUTION: This retry changes installation files.

Recovery makes sure that the original journal, the recorded migration steps, meets its requirements. It uses the original manifest. It does not reconstruct intent from partially migrated files. Later conflicting edits still require a new decision.

## Rollback and retention

`migrate --rollback <journal>` and `migrate --rollback <journal> --dry-run` only prepare a fresh rollback preview. Rollback restores the prior installation state. The original forward plan checksum cannot authorize rollback.

The CLI makes sure that backups match the recorded evidence. The preview binds the journal, backups, current targets, restoration snapshots, modes, and inverse effects.

Before `migrate --rollback <journal> --apply --confirm <rollback-preview-sha256>`, review the fresh rollback preview. CAUTION: This command restores or removes the listed paths. `--dry-run` prevents effects even with `--apply`.

Rollback refuses later edits and post-effect mismatches by default. The CLI makes sure that restoration evidence supports the proposed recovery. If that evidence passes, a changed target has an individual `confirmation` token beside its current-to-restoration diff. Binary content appears as base64.

For changed plugin registries, the diff includes complete current and restoration bytes. It includes unrelated records and configuration. Keep this output private.

For each changed target that you approve, append `--confirm-file <token>` with the current rollback preview checksum. CAUTION: Approval restores the reviewed whole file and discards later customization that the diff shows as removed. No blanket overwrite flag exists.

Missing, corrupt, or symlinked backups remain blockers. A symlink points to another filesystem location. Unsafe target paths also remain blockers. Approval tokens cannot bypass these conditions.

A change after preview invalidates approval. This includes mode-only changes. Under the migration lock, the CLI again makes sure that the files match the preview. The lock prevents simultaneous migration changes.

After partial rollback, request a new preview. Approve only the remaining changed targets. The journal and original backups remain available for further recovery.

Raw `.planning/` state stays local and ignored. For deliberate sharing, export sanitized Markdown, text with sensitive details removed. Cleanup lists exact paths and requires separate confirmation. Cancellation and installation do not automatically remove run artifacts, files that retain work evidence.

A linked canonical checkout can expose unchanged root `skills/ax` and `skills/grill` through OMP resource discovery. The package file list does not restrict a live symlink.

These optional skills do not add command owners or persona bodies. The installer does not copy them into shared user directories.
