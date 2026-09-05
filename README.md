# Supership

Supership adds a guided coding process to Oh My Pi (OMP). It guides work from scope questions through research, planning, implementation, review, and completion.

The extension owns versioned state, the recorded progress and decisions. The main OMP agent does managed task and JavaScript eval actions. Eval means code evaluation within a persistent session.

The upgrade targets Linux, Git, Bun `>=1.3.14`, and OMP `>=18.1.10 <18.2.0`. At startup, Supership makes sure that OMP provides the required features.

The complete offline suite and typecheck passed with compiled OMP 18.1.11 and SDK 18.1.10 fixtures. Typecheck detects incompatible code types. SDK means software development kit. Fixtures supply controlled test inputs.

Offline scripts do not prove real-model judgment quality.

## Commands

```text
/supership <task>                       interactive interview and plan approval
/shipit <task>                          autonomous ordinary plan decisions
/ultraship [crossreview|duel|debate] <task>
/ultrashipit [crossreview|duel|debate] <task>
/superreview [--base <ref>] [--slug <slug>] [intent]
<command> resume [slug]
```

Ultra planning preserves the three, five, and seven-call graphs, sequences of dependent planning calls. Normal review uses one judge. Ultra and review-only use two independent judges. Reviews have no default round cap.

Stalls, judge disagreement, limits, and unsafe recovery pause work instead of declaring success. Autonomous mode never removes OMP safety approvals.

Commit and push require explicit consent. Push needs final approval through the TUI, a terminal user interface. Supership refuses OMP Plan Mode and supports Code Mode.

## Dry-run installation

From your canonical checkout, the primary repository copy, use these commands:

```sh
bun install --frozen-lockfile
bun src/cli.ts doctor --cwd .
./install.sh --dry-run
bun src/cli.ts migrate --dry-run
```

A dry run previews changes without applying them. The wrapper delegates to the Crust CLI, a command-line interface. It does not copy the old payload, download unrelated tools, or rewrite global model configuration.

Before any apply operation, read [Installation](docs/getting-started/installation.md).

The package owns one extension and three provider-neutral personas in root `agents/`. A persona supplies reusable agent instructions. Provider-neutral roles do not require a specific model service.

Legacy `omp/` sources remain preserved and inactive in the new package. This includes protected user personas. Existing installed copies still need approved migration. Migration must establish that old commands no longer take precedence.

## State and safety

`.planning/<slug>/state.json` and `events.jsonl` determine the recorded state. Generated `plan.html` is read-only. Trusted OMP TUI controls own approvals and recovery. Legacy HTML-only runs cannot resume.

Dynamic tools operate in the parent JavaScript kernel, the persistent JavaScript environment. A child worktree, a separate repository working copy, does not confine a granted callback. A callback is a function that another task invokes.

Source review enforces policy. It is not a sandbox, a boundary that restricts code effects. Kernel loss pauses affected work. The engine never automatically evaluates recorded source.

## Documentation

- [Workflow](docs/pipeline/how-it-works.md), [planning](docs/pipeline/planning.md), and [review](docs/pipeline/review.md).
- [Ultra graphs](docs/ultra/planning-topologies.md) and [standalone review](docs/guides/superreview.md).
- [Recovery](docs/guides/resume-and-recovery.md), [configuration](docs/reference/configuration.md), and [architecture](docs/reference/architecture.md).
- [Changelog](docs/changelog/changelog.md).

Supership uses the MIT license. See [LICENSE](LICENSE).
