# strive

strive is a coding agent that learns from your sessions, and every lesson is
one you can review, measure and undo. Proposed changes to its memory and
skills are gated against the current version before they're kept. Budgets,
a verifiable session log and an OS sandbox are on by default.

> **Status: early.** Milestones M0 to M5 are done. strive runs a coding
> agent in any repository, with a verifiable session journal, budgets,
> approvals, a sandbox and checkpoints. It reads the project's AGENTS.md
> and skills, uses MCP servers, and has a terminal UI and a desktop app.
> Headless runs are next; see [ROADMAP.md](docs/ROADMAP.md). The earlier Python research implementation
> is at git tag `strive-py-final`.

## Install

From this directory, with [Rust](https://rustup.rs) and [Bun](https://bun.sh):

```sh
./install.sh          # installs strive, strive-tui and the desktop app (STRIVE_NO_DESKTOP=1 skips it)
```

## Use

```sh
cd any/repository
strive                # opens the TUI in a new session; the per-user daemon starts on its own
strive -c             # continue the latest session in this directory
strive -r ID          # resume a session by id
strive sessions       # sessions started here, newest first (--all for every directory)
strive log [ID]       # a session's journal (default: the latest here)
strive verify [ID]    # check a journal is intact; --all checks every session
strive auth anthropic # store an API key (only the daemon ever holds it)
strive gateway        # base URLs that run any Anthropic/OpenAI SDK under this session's budget
strive doctor         # checks sandbox, git, credentials and the daemon
strive status         # daemon pid, uptime, clients
strive stop           # stop the daemon (it also exits when idle)
strive app            # the desktop app on a new session here (-c and -r as for strive)
strive run "fix the failing test" --approvals full-auto --json
                      # one task, headless; exits 0 done, 1 failed, 3 timed out, 4 interrupted
```

In the TUI, type what you want done. The agent reads and changes files in
the directory and runs commands in a sandbox (no network, writes only in
the workspace). By default, edits in the workspace just happen and commands
ask first; `/approvals` changes that. Esc interrupts. `/rewind` puts the files
back to how they were before any prompt.

No config file is needed. State lives in `~/.strive`, or in `STRIVE_HOME` if set.
Every session starts with a $5 budget. Change it with `/budget` in the TUI,
or for new sessions in `~/.strive/settings.json`:

```json
{
  "model": "claude-sonnet-4-5",
  "approvals": "autoEdit",
  "budget": { "usd": 10 },
  "models": {
    "claude-opus-5-5": { "input": 5, "output": 25, "cacheWrite": 6.25, "cacheRead": 0.5, "contextWindow": 1000000 }
  },
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

Prices are dollars per million tokens. A model without a known price is
refused rather than guessed. `mcpServers` takes the same shape as Claude
Code's (stdio servers). Each tool call asks first unless approvals are
full-auto.

The agent follows the project's `AGENTS.md` (or `CLAUDE.md`) files and
knows its skills (`SKILL.md` under `.strive/skills`, `.claude/skills` or
`~/.strive/skills`). Long conversations are summarized before they
outgrow the model's context.

## Benchmarks

`harbor/strive_agent.py` runs strive as a [Harbor](https://github.com/harbor-framework/harbor)
agent: Terminal-Bench 2.0 and the other Harbor datasets.

```sh
./scripts/build-linux.sh x86_64    # Linux binaries for the task containers (and aarch64 for native ones)
PYTHONPATH=harbor harbor run -d terminal-bench@2.0 -a strive_agent:Strive -m anthropic/claude-haiku-4-5 -l 5
```

Each task container is the sandbox, so the agent runs with `"sandbox": "off"` and full-auto
approvals. `STRIVE_BUDGET_USD` (default 1) and `STRIVE_TURN_SECONDS` limit each task, and the
session's journal lands in the trial's `agent/strive.jsonl`.

## Develop

```sh
./scripts/check.sh                        # fmt, clippy, tests, protocol drift, Biome, Oxlint, tsc, bun test
./scripts/test-linux.sh                   # the Linux sandbox tests, in a container (podman or docker)
./scripts/mutants.sh                      # mutation testing: every surviving mutant is an untested defect
STRIVE_TUI="bun packages/tui/src/main.ts" cargo run   # run the TUI from source
```

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): the daemon, clients and protocol.
- [ADR-0015](docs/adrs/0015-rebuild-daemon-and-host.md): why it's built this way.
- [ADRs](docs/adrs/README.md): the full decision history.
