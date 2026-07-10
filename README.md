# supership

A deterministic multi-agent **clarify, plan, build, review, consolidate** workflow kit for [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi). The main agent authors and runs `eval` cells that drive the pipeline in real code, with durable state in a live HTML dashboard.

**Full docs: [supership.shishirpai.com](https://supership.shishirpai.com)**

## Commands

```
/supership <task>     interactive: clarify, plan, YOU approve, build, review loop, consolidate
/shipit <task>        autonomous: same pipeline, no interview, no gate
/ultraship [topo] <task>    two genius seats (plato + aristotle) debate the plan and review
/ultrashipit [topo] <task>  autonomous dual-genius
/superreview [--base <ref>] [intent]   standalone review-and-fix loop over local changes
<command> resume      re-enter an interrupted run where it left off
```

## Install

```bash
git clone https://github.com/mgpai22/supership.git && cd supership
./install.sh --config   # copy into ~/.omp/agent + apply modelRoles + task config
```

Then restart your omp session. Use `./install.sh --link` to keep this repo as the live source, or `./install.sh` to copy without applying config.

### Install with an agent

Paste this into your coding agent and it does the setup for you.

```text
Install the supership kit for oh-my-pi from https://github.com/mgpai22/supership.
Clone the repo, run `./install.sh --config` (this copies the commands, agents, and
grill skill into ~/.omp/agent and applies the modelRoles + task config), then tell
me to restart my omp session. Reference: https://supership.shishirpai.com
```

## Docs

Everything lives at [supership.shishirpai.com](https://supership.shishirpai.com).

- [Getting started](https://supership.shishirpai.com/getting-started/overview): overview, installation, commands.
- [The pipeline](https://supership.shishirpai.com/pipeline/how-it-works): plan, execute, review, consolidate.
- [Ultra mode](https://supership.shishirpai.com/ultra/overview): the plato and aristotle genius duel.
- [Guides](https://supership.shishirpai.com/guides/superreview): standalone review, frontend and design, load balancing, resume and recovery.
- [Reference](https://supership.shishirpai.com/reference/agents): agents, configuration, architecture.
- [Changelog](https://supership.shishirpai.com/changelog/changelog): every merged pull request.

## License

MIT, see [LICENSE](LICENSE).
