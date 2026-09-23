# strive

strive is a coding agent that learns from your sessions, and every lesson is
one you can review, measure and undo. Proposed changes to its memory and
skills are gated against the current version before they're kept. Budgets,
a verifiable session log and an OS sandbox are on by default.

> **Status: rebuilding.** Milestones M0 to M2 are done. The daemon,
> protocol, TUI and installer work. Sessions are journaled and verifiable,
> and model calls go through a budgeted gateway. The agent loop arrives in M3. See
> [ROADMAP.md](docs/ROADMAP.md). The earlier Python research implementation is
> at git tag `strive-py-final`.

## Install

From this directory, with [Rust](https://rustup.rs) and [Bun](https://bun.sh):

```sh
./install.sh          # installs strive and strive-tui to ~/.local/bin
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
```

No config file is needed. State lives in `~/.strive`, or in `STRIVE_HOME` if set.
Every session starts with a $5 budget. Change it with `/budget` in the TUI,
or for new sessions in `~/.strive/settings.json`:

```json
{
  "budget": { "usd": 10 },
  "models": {
    "claude-opus-5-5": { "input": 5, "output": 25, "cacheWrite": 6.25, "cacheRead": 0.5, "contextWindow": 1000000 }
  }
}
```

Prices are dollars per million tokens. A model without a known price is
refused rather than guessed.

## Develop

```sh
./scripts/check.sh                        # fmt, clippy, tests, protocol drift, tsc, bun test
./scripts/mutants.sh                      # mutation testing: every surviving mutant is an untested defect
STRIVE_TUI="bun packages/tui/src/main.ts" cargo run   # run the TUI from source
```

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): the daemon, clients and protocol.
- [ADR-0015](docs/adrs/0015-rebuild-daemon-and-host.md): why it's built this way.
- [ADRs](docs/adrs/README.md): the full decision history.
