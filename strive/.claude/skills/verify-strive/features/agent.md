# The agent

A prompt starts a turn: the daemon starts an agent host for the session if none is running, the model works through tools the daemon performs, and the turn ends with a summary. The TUI streams the reply, shows each change and command, asks for approvals, and shows spend.

## Sub-features

- `agent-turn` a prompt runs a turn to a reply; the footer shows `working… Esc to interrupt` meanwhile, then only spend.
- `agent-tools` reads, writes (`write PATH (N bytes)`), edits (`edit PATH`) and commands (`$ COMMAND`) appear as they happen.
- `agent-approve` a command asks `Allow run: COMMAND?`; `y`, `a` or `n` answer it.
- `agent-interrupt` Esc stops the turn: `Interrupted.`
- `agent-resume` `strive -c` continues with the whole conversation.
- `agent-rewind` `/rewind` lists checkpoints; `/rewind N` puts the files back.

## How to get to it (user POV)

- Type a request in the TUI.
- `/approvals ask|auto-edit|full-auto`, `/rewind`, Esc.

## Driving it with strive-verify

Preconditions:

- A real model costs money. Put `{"model": "claude-haiku-4-5", "budget": {"usd": 0.5}}` in the run's home (`/tmp/strv-verify-NAME/settings.json`) before starting, and a key in `ANTHROPIC_API_KEY`.
- A scratch repository with a small, checkable task (a failing test to fix).

- **Turn.** `start NAME REPO`, then `send NAME "TASK"`. Poll `screen NAME`: when it shows `y yes · a yes for this session · n no`, answer with `type NAME y`. The turn is over when the footer no longer shows `working…`.
- **Second views.** Run the repository's tests yourself. `cli NAME log ID` ends with `turn 1 done`; `cli NAME verify ID` passes.
- **Proof.** `snap NAME finished`, plus the test output.

## Gotchas

- The footer's `working…` is the turn indicator; don't judge completion by the last line of text.
- Automated tests use a scripted model (`@strive/testkit` FakeAnthropic); only this recipe calls a real one.
