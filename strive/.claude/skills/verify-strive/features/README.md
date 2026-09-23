# strive verification map

The maintained recipes for proving strive's user-facing behavior. Read this index, then use the matching feature file.

## Baseline preconditions

- Build with `strive-verify.sh build`.
- Start each run with a fresh name, which gives it its own `STRIVE_HOME` under `/tmp/strv-verify-NAME`.
- Run `strive-verify.sh doctor NAME`. It must report a socket under that home.
- Never drive a daemon this run didn't start.

## Proof and skip reporting

- CLI proof includes the command, output and exit code. The `cli` subcommand records all three.
- TUI proof is a snapshot taken after the action, showing the resulting state.
- Writes are confirmed from a second view.
- Report an unreachable path with the command tried and the unmet precondition. Don't report a skipped entry point as verified through another one.

## Feature entry contract

Each feature file has an H1 and one paragraph on the user-visible behavior, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with strive-verify`, `Gotchas`.

## Features

- [Start and quit](./start-and-quit.md) covers opening the TUI in a repository and leaving it.
- [Slash commands](./slash-commands.md) covers `/status`, `/help` and unknown commands.
- [Daemon lifecycle](./daemon-lifecycle.md) covers `strive status`, `strive stop`, `strive doctor` and automatic daemon start.
- [Sessions](./sessions.md) covers new, continued and resumed sessions, `strive log`, `strive verify`, `strive sessions` and tamper detection.
- [The agent](./agent.md) covers turns, tool activity, approvals, interrupting, resuming and rewinding.
- [Gateway and budgets](./gateway-and-budgets.md) covers `strive gateway`, live model calls through the gateway, budget refusals, the TUI spend footer, `/budget` and `strive auth`.
