---
name: verify-strive
description: Drive the real strive CLI and TUI in an isolated tmux session and capture evidence. Use to prove any strive change on the surface a user touches, before calling it done.
---

# Verify strive

strive's user surface is the `strive` command and the TUI it opens. This skill runs a disposable instance with its own `STRIVE_HOME` and tmux session. It never touches the user's daemon in `~/.strive`.

Everything goes through `scripts/strive-verify.sh`. Paths below are relative to the `strive/` directory.

## Launch

1. Build: `.claude/skills/verify-strive/scripts/strive-verify.sh build`. It prints `built .../target/debug/strive`.
2. Start a run: `.claude/skills/verify-strive/scripts/strive-verify.sh start NAME [REPO]`. It opens the TUI in `REPO` (default: the strive checkout) and returns once the header shows. It prints `started NAME in REPO (STRIVE_HOME=/tmp/strv-verify-NAME)`.

Pick a fresh `NAME` per run. `start` refuses a name that is already running.

## Doctor

Run `strive-verify.sh doctor NAME` first whenever anything looks off. It reports whether the tmux session exists and prints `strive status` for the run's home: daemon pid, build and socket. The socket must be under `/tmp/strv-verify-NAME/`. If it points anywhere else, stop.

## Drive

- `send NAME TEXT` types the text and presses Enter. For slash commands it dismisses the autocomplete menu first.
- `type NAME TEXT` and `key NAME KEY` send raw text or one tmux key (`Enter`, `Escape`, `C-c`).
- `wait NAME TEXT [SECS]` blocks until the screen contains the text and prints the screen. It fails with the screen on timeout.
- `screen NAME` prints the current screen.
- `cli NAME ARGS...` runs `strive ARGS...` against the run's home and records the command, output and exit code.

Send text and Enter as separate keystrokes, which `send` does. pi-tui treats one burst as a paste, and Enter then inserts a newline instead of submitting.

## Evidence

- `snap NAME LABEL` saves the screen to `.audit/evidence/NAME/LABEL.txt`.
- `cli` appends to `.audit/evidence/NAME/cli.txt`.
- Proof standard: capture the action and the resulting state. For anything that writes (sessions, journals, files), confirm it from a second view too, such as `strive log` after typing into the TUI.
- Don't use test-only entry points. Drive what a user runs.

## Cleanup

`strive-verify.sh stop NAME` stops that run's daemon, kills its tmux session and deletes its home. Evidence in `.audit/evidence/NAME/` is kept. Never kill strive processes by name; a user's own daemon may be running.

## Feature map

[features/README.md](features/README.md) lists every user-facing feature and how to prove it. A proof that covers one entry point is incomplete when the map lists others.
