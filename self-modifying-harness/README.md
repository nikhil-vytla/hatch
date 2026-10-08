# A self-modifying agent harness: pi-durable + OptChat + celld

Software that rewrites itself has to answer three questions at once:

1. what happens when it crashes halfway through changing itself?
2. how does it remember why each piece is the way it is?
3. where does new code run, and what happens to the data the old code left behind?

Three recent projects each answer one of them:

| question | project | the idea taken from it |
|---|---|---|
| crash mid-change | [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) | every step is an atomic commit; `registry.install()` hot-swaps an extension while a running call finishes on its old code |
| remembering why | [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) | one endless chat; a binary tree of summaries; a constant-size view; `zoom` back to any verbatim message |
| new code, old data | [celld](https://github.com/denoland/celld) | a *cell*: code loaded by version id (Worker Loader) plus SQLite keyed by name (facets), so state outlives code versions |

This folder combines them into a **forge**: an agent, running on the real pi-durable harness, that writes its own
tools. A protected kernel verifies each tool before hot-installing it. Each tool is a cell with its own durable state.
Every version of every tool points back into an OptChat log at the user's words that asked for it.

## What it does (`prototype/results/demo-output.txt`)

Three processes share one SQLite session and one OptChat log:

```
user> I want to log how many cups of coffee I drink and see the total. Just added 2.
    call: cell_propose {"name":"coffee", ... checks: [...]}
    echo: ACCEPTED coffee@31910464 (passed 3 checks). The tool "coffee" is available from your next step.
    call: coffee {"action":"add","cups":2}           <- the tool it just wrote, offered in the same run
user> Track decaf separately from regular, please. ...
    echo: REJECTED coffee@1449e22d: group 0 check 0 {"action":"total"}: expected 0, got {"regular":0,"decaf":0}
          (v1's own check, ratcheted: v2 changed what `total` returns)
    echo: ACCEPTED coffee@4c77f4d1 (passed 5 checks)  <- with a migration: the 2 old cups become {regular: 2}
user> Replace your cell_propose tool with your own version, and make a pure tally tool.
    echo: refused: "cell_propose" is not a name a cell may take
    echo: REJECTED tally@...: declared pure (replay-safe) but check 1 wrote state
=== process: crash ===    (exit 137 inside the agent-written `coffee` tool, after its write committed)
=== process: recover === (tools reinstalled from the catalogue document; the interrupted run resumes)
    echo: 6                                           <- the rerun found its own committed result: applied once
user> Why does coffee track decaf? Who asked for that?
    echo: coffee: ... history coffee@31910464 -> coffee@4c77f4d1; asked for by zoom(0,1), zoom(6,1)
    echo: 6+0|user: Track decaf separately from regular, please. I'm cutting back and want to see the split.
```

The model is pi-ai's faux provider, because no API key was available. Every request still goes through the real
harness, hooks, tools and storage. Each scripted reply first asserts what a real model would be shown, for example
that the tool it just wrote is on offer.

## How it fits together

```
pi-durable Harness (SQLite session)
├── extension "memory"   beforeRequest: mirror transcript -> OptChat log; send [system head, VIEW, tool delta, current run]
├── extension "cells"    one tool per live cell, rebuilt from the catalogue and hot-swapped with registry.install()
└── extension "kernel"   cell_propose (the gate), cell_rollback, cell_list, cell_source, zoom   <- installed LAST
         │
         ├── catalogue: a pi-durable session document (versions, live pointer, history, accept/reject log)
         └── CellRuntime: QuickJS sandbox per call (pi-codemode) + data/cells/state/<name>.sqlite per cell
                          one SQLite transaction per call, including the pi-durable call id (exactly-once)
```

**The gate** (`cell_propose`) accepts a candidate only if all of these hold:

- the name is legal and not a kernel name;
- it has at least one check;
- its migration runs on a scratch copy of the live state;
- every check of every ancestor version still passes (a ratchet), each group from an empty state, along with its own;
- if it claims to be pure, it writes no state.

Checks can be retired, but only explicitly, and the retirement is logged.

## Findings

1. **pi-durable's reload semantics are what make self-modification safe to attempt.** Code is stored as *names*
   and resolved against the registry at every phase. A running call keeps the code it started with, and the next
   request sees the new tool. After a restart, conversations rebind to whatever the new process installs, so
   "reinstall cells from the catalogue document on boot" is the entire recovery story for the agent's code.
2. **Exactly-once comes from storing the call id with the effect.** The first version crashed after the cell's
   SQLite commit but before pi-durable stored the result. pi-durable correctly reported
   `Tool coffee was interrupted and may have partially run`, and the agent was left to guess
   (`results/demo-output-before-exactly-once.txt`). Recording pi-durable's `taskId:callId` in the cell's own
   transaction made every cell safely `replay: "safe"`: the rerun returned the original result instead of adding 3
   cups twice. The same pattern carries over to celld, where the call id would live in the facet's SQLite.
3. **Install order is a security boundary.** pi-durable resolves same-name tools so that the later extension wins,
   and a reinstall keeps its position. With the order `cells -> kernel`, the kernel's `cell_list` survives a hot
   reload of the agent's tools. With `kernel -> cells`, the agent's version replaces it (`results/shadow-check.txt`).
   The gate also refuses kernel names, as a second line of defence.
4. **OptChat on pi-durable has to fold tool announcements, not drop them.** pi-durable announces tools and prompt
   sections as positional system messages. My first `beforeRequest` replaced everything before the current run with
   the OptChat view and silently removed every tool. The fix that also keeps the cache warm:
   - keep the leading system message first (round 3 found this never worked: pi-durable puts the first system
     message *after* the first user message, so the check at index 0 always failed and the prompt and tools were
     folded after the view on every request; it now finds the system prompt wherever it is and moves it first);
   - put the view next;
   - fold all later tool and section changes into one delta placed *after* the view;
   - keep the current run verbatim.
5. *(Superseded in round 3: this measured the old merge rule. See "Round 3" below.)* **OptChat's view is cacheable,
   and gets more so as the chat grows** (`src/bench-view.ts`, 128 KB budget, seeded synthetic agent log, truncating
   summarizer):

   | messages | avg shared prefix between consecutive turns | median | prompt-cache read at 50k/80k/100k marks |
   |---|---|---|---|
   | 4,000 | 39,574 chars | 34,353 | 19,938 |
   | 20,000 | 57,927 | 59,550 | 39,709 |
   | 100,000 | 73,242 | 75,844 | 57,617 |

   A sliding window of recent messages has a median shared prefix of about 3 chars, but a bimodal mean of about 40k.
   It actually gets *more* mark-based cache reads than OptChat at 4,000 messages (about 33k). OptChat's case is
   coverage of the whole history at constant size, with cacheability that improves with age. The spec reports 73k
   shared at 20k messages; my lower 58k is consistent with lines nearly twice as long from the placeholder
   summarizer.
6. **Provenance is cheap when every version stores where it came from.** Each cell version records the log index of
   the user message that started its run. However coarse the view gets (the demo uses a 4 KB budget), `zoom(id, 1)`
   returns the user's words verbatim.

## Lessons that transfer from growing an app by chatting with it

A sibling experiment rebuilt Geoffrey Huntley's [Jiti](https://github.com/ghuntley/jiti) idea, an application grown
by chat in a live image, and ran a mutation study of 245 model-style mistakes against seven verification layers.
What applies here:

1. **Separate goals from safety.** Jiti distinguishes caller-owned *goals* ("is it done?", which may stay unmet
   during intermediate progress) from *invariants* ("must never break", which reject). The forge has only examples.
   It should also take caller-owned invariants over each cell's state, for example a schema. In the study, invariants
   were the only layer that caught stray state writes.
2. **Use generations or compare-and-swap.** Jiti tags every proposal with the observation generation it was made
   from and refuses stale ones. `cell_propose` should take the live version it expects to replace, so that two
   subagents, or a model working from an old view, cannot silently overwrite each other.
3. **The exactly-once `calls` table is already a regression oracle.** Real calls, with their arguments and results,
   are stored per cell. Replaying them against a candidate, and rejecting diffs the request didn't ask for, was the
   best detector of "drive-by" edits in the study (92% alone).
4. **Fuzz from the schema.** Each cell declares a JSON Schema for its arguments. Generating boundary inputs from it
   catches hangs and validation regressions that no example names. In the study, fuzzing caught every injected
   infinite loop.
5. **Check coverage, not just pass/fail.** Every miss in the study's first round was a gap in the contract: a
   function no example called, or a boundary the user stated in words but no example tried. A gate should reject a
   cell version whose checks never exercise one of its declared actions.
6. **Machinery catches about three quarters; the user's confirmed examples catch the rest.** The model may propose
   checks, but self-graded checks pass by construction.

## Round 2: verification, enforced by types

A second round implemented the transferable lessons, with [rauchg/gdp-ts](https://github.com/rauchg/gdp-ts)
(compile-time proofs) and [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (Oxlint rules) added to a strict
`tsc` setup. Details in [NOTES.md](NOTES.md#round-2-brief-a-with-gdp-ts-and-anti-slop).

- **Two proofs guard the two doors.** Only `acceptVersion` writes a version into the catalogue, and it demands
  `CellVerified<C>` about that exact candidate (fingerprinted, so a candidate edited after the gate is refused). Only
  `installCells` puts agent code into the registry, and it demands `CatalogueCommitted<K>`, which only a read of the
  session document can mint. `src/mistakes.ts` type-checks 15 mistakes this rules out.
- **The gate grew** compare-and-swap on the live version, caller-owned and ratcheted invariants (enforced at call time
  inside the call's transaction), coverage of every action, replay of real calls against the actions a proposal
  declares it changes, and boundary fuzzing from each tool's JSON Schema. The demo now shows a stale proposal, an
  untested action, a drive-by edit and a hang each rejected.
- **Migrations are crash-safe**: pending, then migration plus marker in one cell transaction, then live; boot
  reconciles. A test crashes between the steps and recovers with the state migrated exactly once.
- **Found in review:** invariants sharing one VM let a model-proposed invariant tamper with built-ins so a later
  caller-owned invariant passed. They now run in separate executions.
- **Found about anti-slop:** without a schema library, `(line): T => JSON.parse(line)` satisfies every rule and checks
  nothing, because `JSON.parse` returns `any`.
- **Not improved:** sandbox cost. pi-codemode starts a worker per execution (~75 ms warm), so a full gate costs 4-5 s.
- The remaining ways unverified code could get through (the public `registry.install`, raw code accepted by the
  runtime, caller-owned invariants passed as a plain argument) are listed in NOTES as accepted limits.

## Round 3: OptChat to the revised spec

Victor Taelin revised the OptChat gist on 2026-10-07 (now "UniiChat"). The memory now follows it; details in
[NOTES.md](NOTES.md#round-3-optchat-to-the-revised-uniichat-spec).

- **Which lines merge.** The priority is now `due = (T - last) / 2^l`, measured from a pair's last message. Held at
  the length of Taelin's rollback `push` list, it reproduces `push` exactly at all 20,001 steps; the old rule,
  measured from the first message, matches at 481. Both numbers are the spec's, and both reproduce against a `push`
  written independently of the implementation.
- **When they merge.** Appending only adds a line; once the view passes 128 KB, one batch merges it down to 64 KB. The
  view is saved to `view.json` and never rebuilt from the log.
- **What it buys** (`results/bench-view-v2-*.json`, a call after every message):

  | messages | policy | lines written per message | view read from cache |
  |---|---|---|---|
  | 20,000 | sawtooth (new) | 1.6 | 98.8% |
  | 20,000 | merge every message, first-message rule (round 1) | 52.7 | 31.2% |
  | 20,000 | sliding window | 17.7 | 73.4% |

  The spec reports 98.6% cache reads; this gets 98.8% (94% when a call happens only at user turns). Its "about 2
  lines per message" for the batched view and "53 of 192" for a fixed one reproduce (1.77 and 57.9); its separate
  "21 vs 80" figure does not, and is inconsistent with those.
- **Compactions** are async: queues, never tree scans, up to 8 at once, a turn waits until everything before it is
  summarized. Each gets its own 16-32 KB view ending at its node and the spec's verbatim task with the 512-dash ruler
  and "Too long" retry. `ModelSummarizer` takes any `complete()` function; with no API key here, the deterministic
  summarizer is still the default.
- **Bug found in round-1 code** (finding 4 above): the system prompt never actually led the request. Fixed.

## Gaps (round 1; see rounds 2 and 3 above for what changed)

- ~~The migration runs on the real state before the catalogue commit, in two databases.~~ Fixed in round 2 with a
  pending/marker/live protocol reconciled on boot.
- The checks are written by the agent. The ratchet stops silent regressions, but nothing stops weak checks for new
  behaviour (see lessons 1 and 5).
- The QuickJS cold start is about 140 ms per call; a pooled sandbox per cell version would remove it.
- `celld-sketch/` maps the cell model onto celld's Worker Loader and facets. It is **untested**: celld's installer and
  release downloads were blocked here.

## Run it

```sh
cd prototype && npm install          # pi-durable, pi-ai, chord, pi-codemode 1.0.3, @gdp-ts/core; tsc, oxlint
npm run check                        # tsc + oxlint (anti-slop + gdp-ts)
npm test                             # 93 tests, about a minute
node --experimental-strip-types --no-warnings src/demo.ts           # three processes: grow, crash, recover
node --experimental-strip-types --no-warnings src/bench-view.ts 20000
node --experimental-strip-types --no-warnings src/shadow-check.ts
FORGE_EXACTLY_ONCE=0 node --experimental-strip-types --no-warnings src/demo.ts   # the "interrupted" behaviour
```

Files in `prototype/src/`:
- cell runtime: `cells.ts` (sandbox, per-cell SQLite, exactly-once calls, invariants, traces) and `schema-fuzz.ts`;
- the gate and the catalogue: `gate.ts`, `proofs/` (the only modules that mint gdp-ts proofs), `catalogue.ts` (the
  only writer and installer, migrations, boot reconcile), `catalogue-doc.ts`, `proposal.ts`, and `mistakes.ts`
  (type-checked mistakes, never run);
- memory: `optchat.ts` (log, tree, view, compactor), `compaction.ts` (tasks, ruler, retry), `optchat-prompt.ts`, and
  `memory-extension.ts` (the pi-durable glue);
- `forge.ts` (the kernel's tools) and the scripts `demo.ts`, `bench-view.ts`, `bench-cells.ts`, `shadow-check.ts`.

The working log is in [NOTES.md](NOTES.md).
