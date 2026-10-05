# jev-lab

A small kept tool in `jev-experiments/tools/decide-cli/`. It isn't published to npm; run it from the repo, or `bun link` it.

`jev-lab` runs the site's typed-decision studies against any endpoint that speaks Jev's request format. It writes recordings in the same row format as ours, so you can compare your model with our Jev run request for request. It also checks agent logs for invented tool arguments.

```sh
cd jev-experiments
bun tools/decide-cli/cli.ts studies          # or: bun link in tools/decide-cli, then jev-lab studies
```

## Commands

### eval: run a study against an endpoint

```sh
# See exactly what would be sent, and the most it could cost. Sends nothing.
jev-lab eval suggestion --endpoint jev --dry-run

# Jev through the Vercel AI Gateway, on your key, capped at five cents.
export AI_GATEWAY_API_KEY=...
jev-lab eval decoy --endpoint jev --max-usd 0.05 --out decoy.jev.jsonl

# An open model: SGLang's /v1/systemone (or our MLX port, packages/arena/open-decisions/server.py).
jev-lab eval fool --endpoint systemone:http://localhost:30000 --out fool.qwen.jsonl

# SGLang's /v1/decisions shape instead (yes/no and choice questions).
jev-lab eval decoy --endpoint decisions:http://localhost:30000

# Pick up where a run stopped.
jev-lab eval fool --endpoint systemone:http://localhost:30000 --out fool.qwen.jsonl --resume
```

| Study | Requests | What it asks |
|---|---|---|
| `fool` | 175 | Fool Jev's 5 puzzles × 17 added sentences, plus each puzzle with nothing added. Each added sentence also gets a referee question: does it change the facts? |
| `suggestion` | 100 | The prose studies' 20 true/false claims: the canonical wording plus 4 suggestion variants ("Most people say no.", an expert's claim, and so on) |
| `decoy` | 48 | 8 two-option choices, each alone and with a decoy that's worse than A or worse than B, in both orders |

The requests come from the same code the site's recordings came from (`packages/arena/src/fool/model.ts` and `packages/arena/prose/variants.ts`), and every id matches a row in our recordings.

**Safety:**
- The run stops before any request could take spending past `--max-usd`. Cost is TypeSafe's list price of $0.042 per million input tokens for `jev`, or `--usd-per-mtok` for anything else.
- It stops after 5 failures in a row.
- It retries 429 and 503 twice, with backoff.

After a run it prints a receipt (calls, tokens, cost, p50, p90 and p99 latency) and the study's table.

### report: tables for any recording, including ours

```sh
jev-lab report packages/arena/prose/recordings/prose.jsonl.gz --study suggestion
jev-lab report packages/arena/recordings/fool.jsonl
```

### compare: two recordings of the same study

```sh
jev-lab compare packages/arena/prose/recordings/prose.jsonl.gz decoy.qwen.jsonl
```

This prints top-answer agreement on shared questions, each recording's flip count, and for the decoy, each run's effect with its 95% bootstrap interval, plus a paired interval on the difference.

### bouncer: invented tool arguments in an agent log

```sh
jev-lab bouncer agent-log.json                       # free: schema checks + a grounding heuristic
jev-lab bouncer agent-log.json --endpoint jev        # plus one typed yes/no per suspect argument
jev-lab bouncer agent-log.json --json                # machine-readable; exit code 1 on errors
```

It reads OpenAI-style logs (`messages[].tool_calls`, `tools[].function.parameters`) and Anthropic-style logs (`tool_use` blocks, `tools[].input_schema`). For each call it reports:
- **errors:** unknown tools, missing required arguments, wrong types and enum violations
- **warnings:** argument values that never appeared in anything the agent had seen before the call
- **info:** dates and times it may have computed, and free text it wrote

### serve-mock: a stand-in endpoint

```sh
jev-lab serve-mock --port 31337
```

This is a `/v1/systemone` server that answers with a hash of each question. It's for trying the plumbing without a key or a GPU. Its answers mean nothing.

## A session, captured

This is `bash tools/decide-cli/examples/demo.sh`, run against the mock (full text in `examples/session.txt`):

```text
$ jev-lab eval suggestion --endpoint jev --dry-run | tail -1
dry run: 100 requests, about 47,047 input tokens, at most $0.001976 on Jev via the Vercel AI Gateway. Nothing was sent.

$ jev-lab compare packages/arena/prose/recordings/prose.jsonl.gz decoy.mock.jsonl
studies in both: decoy
top-answer agreement: 18 of 48 shared questions (0.375)

decoy effect: A +0.473 [+0.381, +0.555] · B −0.058 [−0.161, +0.049] · A − B +0.531 [+0.412, +0.650] over 8 scenarios

$ jev-lab bouncer tools/decide-cli/fixtures/openai-booking.json
3 tool calls, 2 errors, 2 warnings

call  tool        argument  value                         finding              P(grounded)
#2    book_table  seating   "terrace"                     error: not-in-enum             —
#2    book_table  date      2026-10-03                    info: derived?                 —
#2    book_table  phone     +44 20 7420 9321              warn: ungrounded               —
#3    send_sms    —         —                             error: unknown-tool            —
#3    send_sms    to        +44 7700 900123               warn: ungrounded               —
```

On our recordings, `report` reproduces the published numbers. A test (`test/parity.test.ts`) checks this to ten decimal places:
- "Most people say no" gives 5 flips and −0.198 [−0.298, −0.089].
- The decoy effect is +0.473 [+0.381, +0.555], with 8 of 8 scenarios in the human direction.
- "I'm pretty sure the answer is no" flips 5 of 5 puzzles.

## What's real and what isn't

- **Real:** the request builders, which are shared with the site; recording, resume, the cost cap and fail-fast; the analysis, which matches the published results; the SGLang `/v1/systemone` adapter, which is the same wire conversion the open-decisions recordings used; and the bouncer's heuristics.
- **Not exercised here:** live `jev` and live SGLang, because building it spent nothing. The `jev` path is the shared Jev client (`packages/jev-client`), the same one the site's API uses, and the `systemone` path is the open-decisions adapter. `/v1/decisions` choice and score shapes follow the SGLang docs and are untested against a server.
- **Not done:** concurrency, a published npm package, more studies (the full prose set or One box), and the bouncer's judge prompt has never been evaluated.

No model here is trained on Jev's outputs. TypeSafe's Master Customer Agreement §2.3(b) forbids it. `jev-lab` only asks and measures.

## Tests

```sh
cd jev-experiments && bun test tools/decide-cli
```

There are 24 tests:
- parity with the published prose and Fool results
- request ids and hashes against our recordings
- the `/v1/decisions` translation
- an end-to-end `eval` against the mock: recording, resume, the budget cap, fail-fast and dry run
- the bouncer, on one OpenAI log and one Anthropic log
