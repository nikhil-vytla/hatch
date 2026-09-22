# strive

strive is a coding agent that learns from your sessions, and every lesson is
one you can review, measure and undo. Proposed changes to its memory and
skills are gated against the current version before they're kept. Budgets,
a verifiable session log and an OS sandbox are on by default.

> **Status: rebuilding.** Milestone M0 is done: the daemon, protocol, TUI shell
> and installer work. The agent loop arrives in M3. See
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
strive                # opens the TUI; the per-user daemon starts on its own
strive doctor         # checks sandbox, git, credentials and the daemon
strive status         # daemon pid, uptime, clients
strive stop           # stop the daemon (it also exits when idle)
```

No config file is needed. State lives in `~/.strive`, or in `STRIVE_HOME` if set.

## Develop

```sh
./scripts/check.sh                        # fmt, clippy, tests, protocol drift, tsc, bun test
STRIVE_TUI="bun packages/tui/src/main.ts" cargo run   # run the TUI from source
```

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): the daemon, clients and protocol.
- [ADR-0015](docs/adrs/0015-rebuild-daemon-and-host.md): why it's built this way.
- [ADRs](docs/adrs/README.md): the full decision history.
