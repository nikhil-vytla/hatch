# Sessions

Every `strive` run is a session whose prompts are journaled on disk. `strive -c` continues the latest session in the directory and `strive -r ID` resumes one by id. `strive log`, `strive verify` and `strive sessions` read the journals. A journal that was edited fails verification everywhere it is read.

## Sub-features

- `sess-new` starts a session and shows `session …XXXXXX` in the header.
- `sess-prompt` shows the prompt as `› text` and journals it.
- `sess-continue` reopens the latest session here with its history.
- `sess-resume` opens a session by id.
- `sess-log` prints the journal with times; `--json` prints the verified journal.
- `sess-verify` prints `ok    ID  N entries` or `FAIL  ID  reason` and exits 1 on failure.
- `sess-list` lists sessions here, newest first; `--all` lists every directory.
- `sess-tamper` refuses an edited journal in the TUI, `log` and `verify`.

## How to get to it (user POV)

- `strive`, `strive -c`, `strive -r ID` in a directory.
- `/session` in the TUI prints the id and the resume command.
- `strive log [ID] [--json]`, `strive verify [ID | --all]`, `strive sessions [--all]`.

## Driving it with strive-verify

Preconditions:

- A scratch directory, for example `mkdir -p /tmp/strv-repo-NAME`.

- **New and prompt.** Run `start NAME /tmp/strv-repo-NAME`, `send NAME "fix the flaky test"`, then `wait NAME "› fix the flaky test"`. Run `send NAME /session` and read the id from `session ID · resume with strive -r ID`.
- **Second view.** Run `cli NAME log` from the repo directory. The tool runs in the checkout, so pass the id: `cli NAME log ID`. Entry `#2` ends with `you: fix the flaky test`.
- **Continue.** Run `restart NAME /tmp/strv-repo-NAME -c`, then `wait NAME "› fix the flaky test"`. The header shows the same `…XXXXXX`.
- **Verify.** Run `cli NAME verify ID`. It prints `ok    ID  2 entries` and exits 0.
- **Tamper.** Close the TUI with `key NAME C-c`, edit the text in the file `journal NAME ID` prints, then run `cli NAME verify ID`. It prints `FAIL  ID  entry 2 was modified, removed or moved` and exits 1. Run `restart NAME /tmp/strv-repo-NAME -r ID`; the TUI shows `This session's journal failed verification: entry 2 was modified, removed or moved.`
- **Proof.** `snap` after each TUI step; `cli.txt` holds the CLI transcripts.

## Gotchas

- `cli` runs from the checkout, not the repo directory, so `log` and `verify` without an id look for sessions in the checkout. Pass the id.
- Resuming re-verifies the file even when the daemon has the session open, so a tamper made mid-run is refused on the next `-r` or `-c`.
- After a refused resume, typing in the TUI saves nothing. Confirm by grepping the journal for the typed text.
