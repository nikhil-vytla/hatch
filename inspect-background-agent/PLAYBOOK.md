# Figure-it-out: harness hardening playbook

## Phase A — Frame

### Done predicate (falsifiable)

A reviewer can run these and get green without API keys:

1. `npm test` — queues/lifecycle/models/policy tests pass
2. `npm run e2e` — OpenCode writes a file in an isolated sandbox, commits, DELETE leaves disk gone
3. `npm run eval:smoke` — ≥2 scripted tasks pass (file exists + optional assert)
4. `npm run serve` health + create session still works
5. Sandbox dirs under `/tmp/hatch-inspect` are destroyed on `DELETE /api/sessions/:id` and on process shutdown for idle sessions older than TTL
6. Two prompts on one session run **serially** (second starts after first idle); overlapping `void runPrompt` races are gone
7. `GET /api/models` lists runnable OpenCode free models; `OPENCODE_MODEL` selects one that `e2e` accepts
8. Obsolete fake-only demo path (`scripts/demo.ts` using in-memory fakes as the "product") is removed; pure policy unit tests may remain

### Scope

~6 landable units on the existing working stack. Not a Modal/CF rewrite. Blockers already known: OpenCode project-root resolution (mitigated by `--dir` + `/tmp` sandboxes).

### Rigor

**High on lifecycle + async** (crash/leak/race are one-way in production harnesses). **Medium on evals/models** (encode as scripts). **Skip second arena** (design already synthesized; laziness protocol).

### Principles shaping this run

- **Prove it works** — real e2e/eval scripts, not self-report
- **Sequence verifiable units** — queue before lifecycle before evals
- **Subtract before you add** — delete obsolete fake product path before new layers
- **Make operations idempotent** — destroy/reap safe to call twice
- **Encode lessons in structure** — AGENTS.md + eval script + TTL reaper
- **Laziness protocol** — no speculative plugin framework; OpenCode is the extension surface for now

### Tradeoffs (checkpoint)

| Choice | Take | Reject |
| --- | --- | --- |
| Async | Per-session promise chain | Global worker pool (premature) |
| Lifecycle | Explicit destroy + idle TTL reaper | Modal-style snapshot lease broker |
| Evals | Smoke script of fixed prompts | Full Braintrust/LangSmith (later layer) |
| Extensions | Document OpenCode plugins as the hook | Build our own MCP registry now |
| Types | Keep branded kernel; SessionRow stays server-local | Unify everything into one god type file |
| Models | Thin list of known-free + env override | Full provider OAuth matrix |

## Phase B — Units (riskiest unknown first)

| # | Unit | Hypothesis | Verify |
| --- | --- | --- | --- |
| U0 | AGENTS.md verbatim | Steering text lands once | file matches user text |
| U1 | Remove obsolete fake product path | Working product is control-plane only | `demo` gone or rewritten; `e2e` green |
| U2 | Per-session prompt queue | Serial prompts, no overlapping OpenCode in one sandbox | unit + e2e double-prompt |
| U3 | Resource lifecycle | destroy + TTL reap frees disk | assert dir gone after DELETE |
| U4 | Model compat surface | models endpoint + env model in e2e | curl + e2e with env |
| U5 | Eval smoke | two tasks pass on real OpenCode | `npm run eval:smoke` |
| U6 | Decision trail | TSV rows with evidence | committed `decisions.tsv` |

## Phase C/D/E

Execute U0–U6 under the loop. Log each to `decisions.tsv`. Final handback names predicate status and open work.
