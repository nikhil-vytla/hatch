# strive

strive is a coding agent that learns from your sessions, and every lesson is
one you can review, measure and undo. Proposed changes to its memory and
skills are gated against the current version before they're kept. Budgets,
a verifiable session log and an OS sandbox are on by default.

> **Status: early.** Stage 1 (M0 to M6) is done. strive runs a coding
> agent in any repository, with a verifiable session journal, budgets,
> approvals, a sandbox and checkpoints. It reads the project's AGENTS.md
> and skills, uses MCP servers, and has a terminal UI and a desktop app.
> Headless runs work. Stage 2's reviewed proposals (M7) are in the daemon;
> the learner that makes them is next; see [ROADMAP.md](docs/ROADMAP.md). The earlier Python research implementation
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
strive fork [ID]      # a new session that goes on from a session's conversation (--at SEQ; /fork n in the TUI)
strive --safe         # a new session in safe mode: no extension's tools or hooks run (also for app and run)
strive sessions       # sessions started here, newest first (--all for every directory)
strive log [ID]       # a session's journal (default: the latest here)
strive verify [ID]    # check a journal is intact; --all checks every session
strive auth anthropic # store an API key (only the daemon ever holds it)
strive gateway        # base URLs that run any Anthropic/OpenAI SDK under this session's budget
strive doctor         # checks sandbox, git, credentials and the daemon
strive status         # daemon pid, uptime, clients
strive stop           # stop the daemon (it also exits when idle)
strive app            # the desktop app on a new session here (-c and -r as for strive)
strive acp            # the Agent Client Protocol on stdio, for editors (below)
strive run "fix the failing test" --approvals full-auto --json
                      # one task, headless; exits 0 done, 1 failed, 3 timed out, 4 interrupted
strive learn          # ask this project's learner to study its sessions (--session ID for chosen ones)
strive review         # what the learner proposed here, and each proposal's status
strive review 12      # one proposal: its diff, evidence, prediction and checks
strive review 12 accept    # write it (or reject; rollback undoes an accepted one)
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
full-auto. `"extensions": false` starts every new session in safe mode, as
`strive --safe` does.

Editors that speak the Agent Client Protocol (Zed, JetBrains IDEs and
others) run strive as an agent with `strive acp`. In Zed's settings:

```json
{ "agent_servers": { "strive": { "type": "custom", "command": "strive", "args": ["acp"] } } }
```

A session started in an editor is an ordinary strive session: the editor
shows its replies and tool calls and asks you about approvals, and
`strive -r ID` continues it in the terminal.

The agent follows the project's `AGENTS.md` (or `CLAUDE.md`) files and
knows its skills (`SKILL.md` under `.strive/skills`, `.claude/skills` or
`~/.strive/skills`). Long conversations are summarized before they
outgrow the model's context. The agent asks you before it changes any of
these files, or `.strive/settings.json`, whatever the approval mode;
allowing an `AGENTS.md` or `CLAUDE.md` edit for the session (`a` in the
terminal) stops the questions about that one file until the session ends. An
`@docs/x.md` line in `AGENTS.md` or `CLAUDE.md` loads that file if it's
inside the project, and the agent asks before changing it too; one outside
the project isn't loaded, and the session says so. A symlinked `AGENTS.md` that leads to some other
file isn't loaded; one that leads to another `AGENTS.md` or `CLAUDE.md` is.

The project's learner studies its sessions and proposes changes to
`.strive/memory.md` and `.strive/skills`. It can't change a file itself.
strive checks each proposal (its path, size, form, secrets, instructions
that would weaken strive, and evidence from real sessions here), a judge
model gives its advice beside the diff, and nothing changes until you accept
it with `strive review`. Accepting writes the file
only if it's still as the learner saw it; rolling back restores it. The
agent reads the accepted memory, labeled as reviewed, after `AGENTS.md`.

If you turn it on, the learner also runs on its own when a session goes
quiet (10 minutes after its last turn) and shows a sign worth learning from: a correction, an
interrupted turn, a declined approval, a command that failed then passed, or
a failed turn. The scan uses no model. At most 3 such runs a day per project,
each on the learning session's budget; `strive review` says why each ran, or
why one was skipped. `"learning"` in settings changes this:

```json
{ "learning": { "mode": "suggest", "idleSeconds": 600, "everyTurns": 0, "dailyRuns": 3 } }
```

`off`, the default, makes no automatic runs (`strive learn` still works).
`suggest` turns them on. Either way you decide on every proposal. A project's `.strive/settings.json` may set a lower mode
(`{"learning": {"mode": "off"}}`), never a higher one.

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
