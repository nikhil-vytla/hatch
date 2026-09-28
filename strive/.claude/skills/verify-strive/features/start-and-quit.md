# Start and quit

Running `strive` in a repository opens the TUI with a header naming the directory, starting the per-user daemon if needed. Ctrl+C or `/quit` leaves the TUI; the daemon keeps running.

## Sub-features

- `start-header` shows `strive`, the version and the working directory.
- `start-daemon` starts a daemon when none is running.
- `quit-ctrl-c` exits on Ctrl+C with status 0.
- `quit-command` exits on `/quit` with status 0.

## How to get to it (user POV)

- Run `strive` in any directory.
- Press Ctrl+C or Ctrl+D in the TUI.
- Type `/quit` or `/exit`.

## Driving it with strive-verify

Preconditions:

- No run named `NAME` exists.

- **Start.** Run `strive-verify.sh start NAME /tmp`. The screen's first line contains `strive` and the directory. On macOS `/tmp` shows as `/private/tmp`, the resolved path.
- **Daemon started.** Run `strive-verify.sh cli NAME status`. Exit 0, with `clients 2` (the TUI plus this command).
- **Quit.** Run `strive-verify.sh key NAME C-c`, then `strive-verify.sh wait NAME "[strive exited 0]"`.
- **Daemon survives.** Run `strive-verify.sh cli NAME status`. Exit 0, with `clients 1`.
- **Proof.** `snap NAME started` after start and `snap NAME quit` after quitting.

## Gotchas

- On macOS `/tmp` is a symlink, so the header shows `/private/tmp`.
- The TUI needs a real terminal. Run it through `start`, not by piping into `strive`.
