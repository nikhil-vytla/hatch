# Daemon lifecycle

The daemon starts on demand, is shared by every strive command for the user, exits when idle, and can be inspected and stopped from the CLI.

## Sub-features

- `life-status` prints pid, uptime, clients, build, socket and log.
- `life-stop` stops the daemon and reports its pid; a second stop reports none running.
- `life-doctor` checks home, daemon, TUI, sandbox, git and credentials, exiting 1 on any FAIL.
- `life-autostart` starts a daemon on any command that needs one.

## How to get to it (user POV)

- `strive status`, `strive stop`, `strive doctor`.

## Driving it with strive-verify

Preconditions:

- A run started with `strive-verify.sh start NAME`, or none (commands start the daemon themselves).

- **Status.** Run `strive-verify.sh cli NAME status`. Exit 0; the socket line is under `/tmp/strv-verify-NAME/`.
- **Doctor.** Run `strive-verify.sh cli NAME doctor`. The `daemon` line starts with `ok`. The `tui` line is `FAIL` unless `STRIVE_TUI` is set or `strive-tui` sits next to the binary, and then the exit code is 1.
- **Stop.** Run `cli NAME stop`. It prints `stopped daemon (pid N)`. Run it again; it prints `no daemon running`.
- **Proof.** The `cli.txt` evidence file.

## Gotchas

- `cli` does not pass `STRIVE_TUI`, so doctor reports the TUI as missing for a debug build. That is expected, not a regression.
