# Slash commands

Typing `/` opens a completion menu of commands. `/status` reports the daemon, `/help` lists commands and keys, and an unknown command is named in an error.

## Sub-features

- `cmd-complete` shows the menu when `/` is typed.
- `cmd-status` prints `daemon pid N · up Ns · K clients`.
- `cmd-help` lists `/status`, `/help`, `/quit` and the key hints.
- `cmd-unknown` prints `Unknown command /X. Type /help.`

## How to get to it (user POV)

- Type `/` in the TUI editor, then a command name, then Enter.

## Driving it with strive-verify

Preconditions:

- A run started with `strive-verify.sh start NAME`.

- **Menu.** Run `strive-verify.sh type NAME /`. The screen lists `status`, `help` and `quit` with descriptions. Clear it with `key NAME Escape` and `key NAME BSpace`.
- **Status.** Run `strive-verify.sh send NAME /status`, then `wait NAME "daemon pid"`. The pid equals the one `cli NAME status` prints.
- **Help.** Run `send NAME /help`, then `wait NAME "Ctrl+C exits"`.
- **Unknown.** Run `send NAME /nope`, then `wait NAME "Unknown command /nope"`.
- **Proof.** `snap NAME commands`.

## Gotchas

- Without Escape before Enter, Enter may pick the highlighted completion instead of submitting what was typed. `send` handles this.
