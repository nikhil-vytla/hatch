# Gateway and budgets

Every model call a session makes goes through the daemon's gateway, which holds the provider keys, refuses calls that could exceed the session's budget, and journals each call's exact bytes, usage and cost. The TUI footer shows spend against the budget; `/budget` changes it.

## Sub-features

- `gw-urls` prints a session's base URLs: `strive gateway [ID]`.
- `gw-forward` forwards a call with the daemon's key, replacing any key the caller sent.
- `gw-journal` journals `model call N: ... holding up to $X` and `model call N done ...: I in, O out · $C`.
- `gw-refuse` answers 402 with the budget explanation when a call's worst case doesn't fit, before sending anything.
- `gw-price` refuses a model with no known price, naming the settings key to add.
- `budget-footer` shows `$S of $L` in the TUI and updates after each call.
- `budget-set` `/budget 2.5` or `/budget off` in the TUI; journaled as `budget: $2.5000`.
- `auth` `strive auth` lists key sources; `strive auth anthropic` stores a key.

## How to get to it (user POV)

- `strive gateway` in a directory with a session, then point any Anthropic or OpenAI SDK at the printed base URL.
- `/budget` in the TUI; `strive auth`; `strive doctor`.

## Driving it with strive-verify

Preconditions:

- A run started with `strive-verify.sh start NAME REPO` from a shell with a real `ANTHROPIC_API_KEY`, or a key stored with `strive auth anthropic`. A live call costs real money: keep it to one Haiku call with `max_tokens` 16.

- **URLs.** Run `send NAME /session` to read the id, then `cli NAME gateway ID`. Two lines: `ANTHROPIC_BASE_URL=http://127.0.0.1:PORT/g/TOKEN/anthropic` and `OPENAI_BASE_URL=...`.
- **Live call.** `curl "$ANTHROPIC_BASE_URL/v1/messages" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "x-api-key: not-a-real-key" -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"Reply with just the word ok."}]}'` answers 200 despite the fake key.
- **Second views.** The TUI shows `N in · M out · $C` and the footer `$C of $5.0000`. `cli NAME log ID` shows the start and done lines with the same numbers as the response's `usage`.
- **Refusal.** `send NAME "/budget 0.0001"`, repeat the curl: HTTP 402 with `strive: this call could cost up to ...`.
- **Proof.** `snap NAME after-live-call` and `cli.txt`.

## Gotchas

- The daemon captures provider keys from its environment when it starts. A key exported later needs `strive auth` or a daemon restart (`strive stop`).
- Automated tests never make live calls: the harness strips provider keys and `scripts/check.sh` unsets them. Only this recipe spends money.
