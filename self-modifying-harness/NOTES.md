# Notes: self-modifying software on pi-durable, OptChat and celld

Working log. Newest findings are at the bottom of each section.

## Brief

Build software that can modify itself, using three pieces:

- [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable): a durable agent harness.
- [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): an endless chat whose memory is a binary tree of summaries.
- [celld](https://github.com/denoland/celld): self-hosted Durable Objects.

## Environment

- The egress proxy blocks `ghuntley.com`, `celld.dev`, `gist.githubusercontent.com` and `web.archive.org`. It allows
  `git clone` from github.com and gist.github.com, and the npm registry. I read the gist by cloning it as a git repo.
- `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-codemode` are all 1.0.3 on npm. They run on Node 22.22 with
  `--experimental-strip-types`, so no build step is needed.
- No model API key was available, so every demo uses pi-ai's faux provider. Each request still goes through the real
  harness, hooks, tools and storage. Faux replies can be factories that see the request, which I used to assert what a
  real model would see (for example, "is the tool I just wrote on offer?").
- celld could not be run at first: its installer (`celld.dev`) was blocked and so was the release download. The
  `celld-sketch/` was written against celld's own examples (`facets`, `dynamic-worker-tails`); round 5 ran it.

## What each source contributes

### pi-durable (read README, spec.md section 7.1, example 31)

- Every change is an atomic commit. Nothing is shown before it is stored. Tasks checkpoint at every step, so a
  restarted process continues from the last checkpoint.
- **Reload is a first-class operation.** `registry.install(ext)` with a name already installed replaces that
  extension in place. Work that has already started keeps the code it took: a running tool call finishes on the old
  implementation, and the next phase or request uses the new code. Conversations store extension *names*, never code,
  so after a restart they bind to whatever code the new process installs. I smoke-tested example 31 against the npm
  build; it printed `v1` during the reload, `v2` after it, and `[]` then `['version']` across a restart.
- Tool replay: a tool's intent is committed before `execute()`. After a crash, the tool reruns only if it is declared
  `replay: "safe"`. Otherwise the model gets an `interrupted` error.
- Documents are typed JSON committed alongside the transcript (`defineDoc`, with session, conversation or task scope).
- Prompt sections and tool changes are **positional system messages** in the transcript (`toolsAdded` and
  `toolsRemoved`), so that provider prompt caches stay warm. This turned out to matter a lot (see below).
- Hooks: `beforeRequest` can replace the messages of one request, which is where OptChat's view plugs in.
  `beforeTool` can block a call, and `onYield` can continue a run.
- `pi-codemode` (same repo) runs model-written JS in QuickJS/wasm. Its only capabilities are the injected functions,
  and it has a timeout and memory limit. That makes it a ready-made isolate for code the agent writes.

### OptChat (full spec read)

- One endless chat. Every message goes into an append-only log. A background compactor builds a purely binary tree
  of 512-byte summaries. Each turn is a **fresh** model call that sees a constant-size view (about 128 KB) of the
  whole chat, plus `zoom(id, n)` to open any line back down to the verbatim message.
- The view is folded incrementally: append, then merge the "most due" adjacent pair (`due = age / 2^(l+2)`), and
  never split. Consecutive views therefore share a long prefix, which keeps them cacheable.
- Compactor priorities put the user's own words first, which is why "instructions stick" without an AGENTS.md. The
  compactor is also told never to obey what it summarizes.
- Its checklist includes: never put cut text in the view; no volatile content in the system prompt; one writer with
  fsync.

### celld (README, examples, docs list)

- A cell is a named server with its own SQLite database. Ownership comes from a conditional bucket write. Writes are
  replicated in LTX format to peers or the bucket. Nodes are replaceable.
- **Worker Loader plus facets is the self-modification primitive.** `env.LOADER.get("app-v1", () => ({ modules: {
  "app.js": CODE } }))` loads code from a string under a version id, and `ctx.facets.get("app", ...)` runs a Durable
  Object class from that code with its own SQLite, replicated with the parent. The state's identity (the facet name)
  is separate from the code's identity (the loader id).
- The README warns that state survives a configuration change and celld does not migrate it, "so an object can keep a
  value that the new configuration rejects. The failure then looks unrelated to the change." That is exactly the
  self-modification hazard, and it is why the prototype's gate has `migrate`.
- celld ships `examples/pi` (a pi harness inside a celld Durable Object) and `examples/opencode`, so agent-in-a-cell is
  already a target its authors care about.

## Design

The system is called the "forge": the agent writes its own tools.

- **Kernel vs. userland.** The kernel cannot be rewritten by the agent. It holds the gate (`cell_propose`),
  rollback, listing, source and `zoom`. Userland is the `cells` extension: one tool per live agent-written cell,
  rebuilt from the catalog document on every change and hot-installed with `registry.install`.
- **Cell = immutable code plus durable state**, after celld. The version id is `name@sha8(source, migrate)`. State is
  one SQLite file per cell name, so it is shared across that cell's versions. The code runs in QuickJS with only
  `args` and `kv` in scope. Each call is one SQLite transaction, so a script that throws leaves no partial writes.
- **Gate.** A candidate must:
  1. take a legal name that is not a kernel name;
  2. have at least one check;
  3. pass its migration on a scratch copy of the live state;
  4. pass every check of every ancestor version on the live lineage (a ratchet), plus its own checks;
  5. not write state if it claims to be pure.

  Each group of checks runs from an empty state, so expectations don't depend on live data. Checks can be
  *retired*, but only explicitly and on the record.
- **Catalog** is a pi-durable session document, committed atomically. It records every version, the live pointer,
  the history and a log of accept and reject events.
- **Memory** is OptChat on pi-durable. A `beforeRequest` hook mirrors the transcript into the OptChat log and
  replaces everything before the current run with the rendered view. `onYield` logs final answers as they happen.
- **Provenance.** Each cell version stores `why`, the log index of the user message that started the run in which
  it was proposed. `cell_list` prints `zoom(why, 1)` for each version, so "why does this tool behave like this?" is
  always one zoom from the user's verbatim words, however far the view has coarsened.

## Log of what happened

1. `cells.ts` first try: QuickJS sandbox per call, about 140 ms cold (wasm load and worker). Timeout works: an
   infinite loop is killed after 2 s. Throw-then-rollback works.
2. Verification first ran checks against a copy of live state, which made expectations depend on history. I changed
   it so each group of checks runs from an empty state and only the migration runs on the live-state copy.
3. OptChat implementation: the first `pump()` rescanned every level on each message (O(T log T) per log, quadratic
   overall). I replaced it with `buildEnding(m)`, which builds only the nodes whose range ends at the new message.
   The full scan is kept for load-time recovery.
4. **Bug: the doc draft lost nested edits.** `const e = (doc.cells[n] ??= {...}); e.versions[v] = ...` silently
   dropped the edits, because the object assigned into a Chord draft is copied, so `e` is not the draft. The fix is
   to assign, then re-read `doc.cells[n]`.
5. **Bug: documents reject `undefined`.** Errors read "Value contains a non-JSON undefined; expected strict JSON".
   The fix is to round-trip the candidate through JSON before storing it.
6. **Biggest integration issue: tools vanished from the request.** pi-durable announces tools as positional system
   messages. My first `beforeRequest` replaced every message before the run with the view, which deleted the tool
   announcements, so the model was offered no tools at all. Fix: keep the leading system message first (constant,
   cacheable), fold every later pre-run system message into one delta placed **after** the view, and keep the run
   verbatim. A self-written tool then stays on offer without rewriting the head of the cached prefix.
7. Demo works end to end across three processes (`results/demo-output.txt`):
   - the agent writes `coffee` and uses it in the same run (the next request offers it);
   - a v2 that changed `total`'s return type is rejected by v1's ratcheted check;
   - the corrected v2 with a migration is accepted, and the 2 earlier cups become `{regular: 2, decaf: 0}`;
   - a cell named `cell_propose` is refused;
   - a stateful cell declared pure is refused;
   - the crash process exits with code 137 inside the `coffee` call;
   - recovery reinstalls the tools from the document;
   - "why does coffee track decaf?" resolves with `cell_list`, then `zoom(6,1)`, which returns the user's own words.
8. Crash semantics, first version (`results/demo-output-before-exactly-once.txt`): pi-durable correctly said
   `Tool coffee was interrupted and may have partially run`, and the cell's SQLite transaction had in fact committed
   (regular went 2 to 5). The agent had to work out for itself whether to redo the add. This is the classic window
   between an effect and recording that it happened.
9. **Exactly-once cells.** The pi-durable `taskId:callId` is recorded in a `calls` table *inside the same SQLite
   transaction as the cell's effects*. On a rerun, the cell finds its own row and returns the stored result. With
   that, every cell can be declared `replay: "safe"`, and after the crash the tool reran and returned the original
   `6` with no double apply (`runtime.replayed = 1`). This makes the "declare pure" flag mostly unnecessary; the check
   that refuses false purity claims is kept as an example of the gate verifying a self-declared property.
10. Shadowing check (`results/shadow-check.txt`): with install order `cells -> kernel`, the kernel's `cell_list`
    wins, and still wins after reloading `cells`. With `kernel -> cells`, the agent's version wins, and reinstalling
    keeps the position. So the install order is a security boundary. The gate refuses kernel names as well (defense
    in depth).
11. OptChat view stability benchmark (`src/bench-view.ts`, seeded synthetic coding-agent log, 128 KB budget,
    truncating summarizer):

    | messages | avg view chars | avg shared prefix between turns | median | cache read at 50k/80k/100k marks |
    |---|---|---|---|---|
    | 4,000 | 127,984 | 39,574 | 34,353 | 19,938 |
    | 20,000 | 129,680 | 57,927 | 59,550 | 39,709 |
    | 100,000 | 130,148 | 73,242 | 75,844 | 57,617 |

    Sliding-window baseline (the most recent whole messages that fit): median shared prefix is 3 to 4 chars, but the
    mean is about 40k, because the window is bimodal (it either shifts, and shares nothing, or has slack and shares
    everything). On mark-based cache reads, the window gets about 34k at every length.
    - The spec reports 73k shared at 20k messages and 92k at 400k. My run gets 58k at 20k and 73k at 100k. The trend
      matches: stability grows with history length because old lines change rarely. The gap is plausibly my
      truncating summarizer: lines average about 460 bytes, versus about 250 bytes for the spec's model-written
      ones, which gives roughly 280 lines instead of 500.
    - **At short histories (4k messages) a sliding window gets more cache reads than OptChat.** OptChat's case is
      coverage (the whole history is reachable by zooming), with cacheability that improves as the chat grows. It is
      not a cache win from day one.
12. The view in the final demo state shows the coarsening working at a deliberately tiny 4 KB budget: old turns are
    `0+2`/`2+2` lines, and recent ones are `+1`.

## Gaps and open questions

- The migration runs against the real state *before* the catalog commit, so a crash between them leaves migrated
  state under old code. On celld both would be in one Durable Object's SQLite and could share a transaction. Here
  they are two databases. A fix would record a "migrating to version X" intent in the cell's SQLite, inside the
  migration transaction, and finish or undo it on boot.
- Checks are example-based and written by the agent. Ratcheting stops silent regressions, but nothing stops the agent
  from writing weak checks for a new feature. Caller-owned invariants and replay of real calls would help (both added
  in round 2).
- QuickJS cold start of about 140 ms per call is fine for tools but not for hot paths. A pooled sandbox per cell
  version would fix it, and celld's isolates are warm by design.
- The truncating summarizer is a placeholder. OptChat's value depends on a good compactor, and the `Summarizer`
  interface is where a model would plug in.
- The agent cannot (yet) modify its own system prompt sections or the memory hook. That is deliberate, since both are
  kernel, but a "skills" layer of prompt sections as cells would be the natural next step.

## Round 2: verification, with gdp-ts and anti-slop

Sonnet subagents wrote the code; every step was re-verified here before committing (tsc, oxlint, tests, demo, and a
read of the trusted modules). Sources: [rauchg/gdp-ts](https://github.com/rauchg/gdp-ts) (Ghosts of Departed Proofs,
compile-time proofs; skill read in full) and [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (Oxlint rules
rejecting low-evidence TypeScript; its `install-anti-slop` skill was followed).

### Tooling

- `tsc` 7.0.2 strict, Oxlint 1.87.0, anti-slop's 18 generic rules plus `oxc/no-accumulating-spread` at error, and the
  gdp-ts Oxlint preset (default mode, `proofs: ["src/proofs/**"]`). The gdp preset returns only
  `{ jsPlugins, overrides }`, so it is merged rather than spread over the config.
- anti-slop is meant to be vendored and owned: its README says to copy the rules in and change them to match your
  standards. It lives in `tools/oxlint/anti-slop/` (from commit `c44ef22`, with Dillon Mulroy's MIT license and an
  `UPSTREAM.md` recording provenance and local changes). An earlier version fetched it with a script into a gitignored
  directory, on a too-broad reading of AGENTS.md's rule against committing code fetched for an investigation.
- Baseline on the round-1 code: 24 type errors (one root: `Catalog` did not fit pi-durable's `JsonObject`) and 228
  anti-slop findings (184 of them `require-readable-spacing`; the rest unknown params/returns, `typeof` narrowing,
  unjustified `as`). Now: 0 and 0.
- **Finding about anti-slop:** `no-runtime-typeof` and `no-unknown-parameters` push parsing to the boundary, but with no
  schema library in the project the path of least resistance became `const parseNode = (line): Node => JSON.parse(line)`:
  `JSON.parse` returns `any`, which satisfies every rule and checks nothing. The linter cannot see this. A schema
  library (or a rule against annotating `JSON.parse` results) is what actually closes it.

### Cell runtime (`src/cells.ts`, `src/schema-fuzz.ts`)

- **Call-time invariants**: run after the script and before COMMIT, in the call's own transaction, with a frozen
  read-only `kv`; a violation, throw or timeout rolls the call back.
- **Invariant isolation (found in review, then fixed):** all invariants of a list ran in one VM, so a model-proposed
  body could rewrite `Array.prototype.push` and make a later caller-owned invariant pass. Now caller-owned and
  model-proposed invariants run in separate sandbox executions, caller-owned first. A test shows the attack works within
  one list and fails across lists.
- **Traces**: the exactly-once `calls` table also stores args, kv before/after (up to 64 KB) and the version. Replay
  runs a candidate on a scratch database seeded from a trace.
- **Schema fuzz**: seeded generator from the cell's JSON Schema, boundary-biased (0, -1, 2^31, MAX_SAFE_INTEGER, 1e308,
  "", unicode, `"__proto__"`, every enum member).
- **Sandbox cost did not improve.** pi-codemode starts a worker and VM per `execute()` by design: ~55 ms is worker
  start, ~20 ms VM and prelude; warm calls ~75 ms, cold ~110 ms, a call with invariants ~165 ms (a second worker).
  Pooling the sandbox and compiling wasm once saved nothing measurable. A real fix needs a persistent worker or
  in-process QuickJS with an interrupt handler, i.e. bypassing `CodemodeSandbox`.

### The kernel behind proofs (`src/proofs/`, `src/catalogue.ts`, `src/gate.ts`)

Three gdp-ts proofs guard the two places where unverified code could reach the live system:

| proof | minted by | demanded by |
|---|---|---|
| `CatalogueCommitted<K>` | `withCommittedCatalogue`, which reads the session document itself | `installCells` (the only way agent code enters the registry) and `verifyCell` (so the ratchet lineage is the committed one) |
| `CellVerified<C>` | `verifyCell`, only after the whole gate passes; carries a fingerprint of the candidate's JSON | `acceptVersion` (the only writer of a version into the catalog) |
| `CellAccepted<C>` | `withAcceptedVersion`, only for a version in the cell's history | `rollbackVersion` |

`src/mistakes.ts` holds 15 `@ts-expect-error` lines (installing a hand-made catalog, accepting an unverified or
different candidate, a raw `CellVersion`, a forged proof, proofs escaping their callbacks, ...). Removing the directives
gives exactly 15 type errors, so each line guards a real mistake.

The gate, in order: compare-and-swap on `expectLive` (checked again inside every transaction); name, version id, at
least one check; model-proposed invariants may be added but never dropped; every enum member of an action-like
parameter must appear in the version's own checks; `changes` names real actions; migration on a scratch copy, the
check ratchet and purity, all under both invariant lists; replay of up to 50 real calls of the live version (a diff in
an action listed in `changes` is reported as a behavior change the user should hear about, any other diff rejects);
fuzz on a budget of 40 sandbox executions (a hang blocks, an invariant violation the live version does not have blocks,
the rest are advisories). A full gate costs about 4-5 s, dominated by the ~100 ms per sandbox execution.

**Crash-safe migration** (round 1's gap #1): the verified version is committed as `pending`; the migration and a
`migrated_to` marker are written in one cell-SQLite transaction; then `live` is committed. On boot, `reconcile` rolls
forward if the marker equals the pending version and drops it otherwise. A test crashes a child process (exit 137)
between the migration and the commit and shows recovery migrates exactly once.

Demo additions (`prototype/results/demo-output.txt`):

```
REJECTED coffee@ca40e404: stale: you expected coffee@00000000 to be live but the live version is coffee@31910464. ...
REJECTED coffee@ca40e404: checks do not exercise every action: action="total" appear in none of this version's own checks.
REJECTED coffee@149804c9: replay: 2 of 3 real calls behave differently from coffee@ca40e404 and this proposal declared
  changes ["breakdown"]: {"action":"add","cups":1,"decaf":true}: result 3 became 2; ... it is a drive-by edit.
REJECTED sum_to@a198ddc2: fuzz: input {"n":9007199254740991} did not finish within 2000 ms (a hang the declared schema allows).
```

The first `coffee` version was accepted with a fuzz advisory: 6 of 20 generated inputs (fractional cups) break the
caller-owned invariant "counts are non-negative integers". The scripted model's tool never validated `cups`, and no
example a person would write tried 36.348 cups.

Tests: 59 (`npm test`, ~60 s), covering the runtime, the proof functions, each gate stage, replay scope, invariant
isolation and the crash-recovery protocol.

### Where unverified code can still get through (accepted limits, from the integrator's report, checked here)

- `registry.install` is public pi-durable API: anything holding the registry can install a hand-built `cells`
  extension. Only `cellsExtension` being unexported stands in the way.
- `CellRuntime` is an open capability: `migrateTo`, `run` and `call` take raw code. Only `commitVerified` calls
  `migrateTo`, but nothing enforces it.
- `verifyCell` takes the caller-owned invariants as a plain argument, so a caller passing `[]` still gets a proof. The
  proof is about the candidate, not the policy it was checked against.
- Proofs describe the moment of the read: `installCells` can be handed an older, still-committed catalog.
- A rollback does not re-run the gate, so an old version can break an invariant added later; it is enforced at call
  time only.
- The `CellsDoc` token is confined to the trusted modules by a `no-restricted-imports` lint rule, not by types.

gdp-ts's own guidance ("prove the facts whose absence would be an incident, and stop there") is why these stay as
documented limits: each would need a proof threaded through pi-durable's API or the runtime, for a threat (a hostile
caller inside the kernel) this prototype does not have.

### Not done

- A model-backed OptChat summarizer: no API key in this environment.

## Round 3: OptChat to the revised (UniiChat) spec

Victor Taelin rewrote the gist on 2026-10-07 (commit `3c190e0`, +403/-706 lines; retitled "UniiChat"). A Sonnet agent
implemented the changes from a spec I wrote; I verified the result independently.

What changed in the spec, and in the code:

- **Merge priority.** `due = (T - last) / 2^l`, the pair's age measured from its *last* message in units of its own
  line size, ties to the oldest pair. The spec derives it from Taelin's rollback `push` (a binary counter: newest
  entries churn, old ones almost never change) and says the old rule, measured from the *first* message, was the bug
  that made old lines churn. Verified two ways: my own scratch `push` + fold script gives 20,001/20,001 for the new
  rule and exactly 481/20,001 for the old one (the spec's numbers), and the agent's exported `mergeDown` gives the
  same against my `push`. Round 1 used the old rule (`(T - start)/2^(l+2)`).
- **Sawtooth.** Append only; past 128 KB, one batch merges down to 64 KB. Between batches the view only grows at its
  end, so each call's view is a prefix of the next one's.
- **Persistence.** The view is saved to `view.json` (atomic write) and never rebuilt from the log, because a rebuilt
  view differs from the live one and kills every cache entry. Round 1 refolded at load. A missing `view.json` with an
  existing log is folded once, as a migration path. The compaction view is not persisted; it is rebuilt at load.
- **Compactions.** Now async: FIFO queues (pending messages, ready merges, retries), up to 8 calls, a message node
  starts when fewer than 8 earlier lines are unbuilt, a merge when both halves are built, no tree scans (load-time
  recovery is two linear passes). `settle(id)` lets a turn wait until everything before it is summarized. Each call
  gets its own view (merged further, 16-32 KB sawtooth, ending at the node, only built lines) and the verbatim task
  with the 512-dash ruler; the "Too long ... ← LIMIT" retry runs in the same conversation, at most 5 tries, shortest
  kept (tested with fake models that overshoot). `ModelSummarizer(complete)` is ready for a real model; there is still
  no API key here, so the deterministic summarizer is the default.
- **Log.** Kinds `user | agent | tool | echo | work | note` (the spec's `unii` renamed), day-split
  `main/` and `tree/` files read with real structural parsers (malformed lines are rejected like torn ones, unlike the
  round-2 `(line): T => JSON.parse(line)` parsers), tool output clipped to 15,000 + 15,000 characters of head and
  tail, any other long text split into 30,000-character messages.
- **Prompt.** The spec's system prompt (renamed to Forge, minus the device/computer paragraph and `zoom("Name")`,
  which Forge has no use for) is a constant pi-durable section; a `date(id)` tool sits next to `zoom` (and is a
  reserved name for cells). The memory glue moved from `forge.ts` to `src/memory-extension.ts`.

**A round-1 bug, found by the agent and confirmed here.** pi-durable places the first system message *after* the
first user message (a probe of the raw request shows `user, system`, then `user, system, assistant, user`). Round 1's
"keep the leading system message first" checked index 0, never matched, and folded the system prompt and every tool
into a delta after the view on every request: the opposite of the cacheable head it was written for. The request is
now `[system prompt] [view] [delta of later tool announcements] [current run]`.

**Benchmark** (`results/bench-view-v2-*.json`; seeded synthetic log; averages skip the first 500 messages; "per
message" is a call after every message, as in the spec's simulation; cache read uses the spec's marking: 4-line
blocks, mark on the last whole block):

| messages | policy | line-inputs / message | cache read | avg view |
|---|---|---|---|---|
| 4,000 | sawtooth 64-128 KB | 1.68 | 98.8% | 96 KB |
| 4,000 | round-1 policy (merge every message, first-message rule, 96 KB) | 71.9 | 31.4% | 96 KB |
| 4,000 | sliding window 96 KB | 18.1 | 73.3% | 90 KB |
| 20,000 | sawtooth | 1.60 | 98.8% | 96 KB |
| 20,000 | round-1 policy | 52.7 | 31.2% | 96 KB |
| 20,000 | sliding window | 17.7 | 73.4% | 90 KB |
| 100,000 | sawtooth | 1.52 | 98.8% | 96 KB |
| 100,000 | round-1 policy | 40.7 | 31.5% | 96 KB |
| 100,000 | sliding window | 16.8 | 74.5% | 90 KB |

- Called only at user turns, the sawtooth reads 94% from cache: a batch every ~110 messages invalidates it, and a turn
  adds about 8 lines.
- This reverses round 1's finding that a sliding window caches better at short histories: that was an artifact of the
  old merge rule, not of OptChat.
- Against the spec: its 98.6% cache read reproduces (98.8%). A pure line simulation (30,000 messages) gives 57.9 lines
  per message for a fixed 192-line view merged every message and 1.77 for a 96-192 line sawtooth, matching the spec's
  §3.3 text ("about 53 of 192", "about 2"). Its "21 vs 80 line-inputs per message" does not reproduce and is
  inconsistent with that text; it may count compaction-call inputs, which this benchmark does not model.

Tests: 93 (31 for the memory, 3 for the request shaping). tsc 0 errors, oxlint 0 findings.

Not done: the spec's "one process owns a chat (hold a lock)"; the batch-in-progress flag is not saved in
`view.json`, so a batch interrupted by a crash resumes only once the view is over 128 KB again (both checked in
`optchat.ts`: no lock of any kind; at load `draining` is set only when the view is over `high`).

**Cache marking cannot follow the spec through pi-ai** (checked in `pi-ai/dist/api/anthropic-messages.js`, after the
first write-up wrongly said it was "not checked"). pi-ai adds Anthropic `cache_control` itself, at fixed places: the
system prompt, the last tool definition and the last block of the last message. A caller cannot place a mark. The
spec's scheme needs a mark on the last whole 4-line block *inside the view*, so the next turn can reuse the view.
Here the view is one text block that is never last, so across turns the cache should hold only the system prompt and
tools, and every turn would rewrite the view; within a turn (tool steps) the end mark still works. This is inferred
from the adapter's code, not measured: there is no API key here. The 98.8% in the table is the spec's scheme,
modeled; getting it for real needs explicit breakpoints in pi-ai or a direct Messages API call.

## Round 4: a real model (DeepSeek V4.1 Flash)

The environment gained DeepSeek access. The key is not in the container: the egress proxy attaches it to requests to
`api.deepseek.com`, so the code sets `DEEPSEEK_API_KEY` to a placeholder that pi-ai's provider requires and the proxy
replaces. Node's `fetch` needed `NODE_USE_ENV_PROXY=1` to go through the proxy (the CA bundle was already configured).
A Sonnet agent wrote `src/live.ts`, `src/chat.ts` and `src/live-run.ts`; I verified the run against its raw output.

- `live.ts` opens the forge with `deepseek-flash` for turns and a `ModelSummarizer` (same model, low reasoning, the
  OptChat system prompt) for compactions, behind a spend meter that refuses requests past a cap (default 60 calls or
  $0.25 per run). pi-durable's retries and its own compaction are off (OptChat is the memory).
- `chat.ts` is an interactive, resumable chat; `live-run.ts` is one scripted run. pi-ai reports DeepSeek's
  `prompt_cache_hit_tokens` as `usage.cacheRead`, with `usage.input` the misses only.

**The run** (`results/live-deepseek-run.txt`, run once, prompts untuned):

1. "Log my coffee, just added 2." The model wrote `coffee` (add/total/reset, 6 checks, an invariant), accepted on the
   first try, and used it in the same run.
2. "Track decaf separately. I had a decaf." It read the source, then needed four proposals. The gate rejected three,
   each for a real reason: it dropped the earlier invariant (invariants only ratchet up); its checks never exercised
   `kind="regular"`; v1's ratcheted `total` check still expected the old shape (it then retired those checks, on the
   record); and its own expectation for `reset` was wrong. The fourth was accepted with a migration, and replay of the
   one real call reported the behavior change to pass on to the user. It declared `changes: ["*"]`, which makes
   scope-aware replay accept any change: the model took the widest declaration rather than naming the actions it
   changed, so that safeguard did not bite here.
3. "What's my breakdown?" One tool call, correct (2 regular, 1 decaf).
4. "Why does the coffee tool track decaf? Who asked?" "The user asked, at message 7: 'Track decaf separately from
   regular, please. I had a decaf.'" Message 7 is the right log index. It answered from the OptChat view without
   calling `cell_list` or `zoom`: with 36 messages the view still held that line verbatim.

**Cost and cache** (checked by summing the per-request rows and recomputing from tokens × prices; both give $0.0708):

| | calls | input read from cache | cost |
|---|---|---|---|
| turns | 14 | 76.9% | $0.0154 |
| compactions | 82 | 82.0% | $0.0553 |
| total | 96 | 80.8% | $0.0708 |

- This is a real-provider answer to round 3's caching question, for DeepSeek: it caches prefixes automatically (no
  markers), so the view is reused across turns without the explicit breakpoints Anthropic needs. Turn requests read
  75-98% from cache, except the first request after a tool was accepted (31% and 8%): a changed tool set changes the
  prompt early. The first request of each run reads less (46-75%) because the view was re-rendered.
- Compactions were 82 of 96 calls for 36 messages: building the summary tree eagerly costs about two calls per message,
  as the spec says. Five compaction replies ended at the 2,000-token output cap (low-effort reasoning still spends
  tokens), and two came back with a copied `18+1|` head despite the prompt; `ModelSummarizer` now strips such heads.
- The fuzz report said "41 of a budget of 40 executions": the budget is checked before each input, and one input can
  cost more than one execution. A soft cap, working as written.

## Round 5: running the celld sketch

- **Getting celld.** With the egress restrictions lifted, `celld.dev` loaded, but its installer downloads from GitHub
  releases, which this environment still gates per repository (an API read of an unattached repo needs credentials
  with push rights, which do not exist here, and should not be needed). The same release is published as a container
  image, so I pulled `ghcr.io/denoland/celld` (v0.6.2, linux/amd64) through the registry API with an anonymous token,
  checked each layer against its digest, and extracted `/usr/local/bin/celld`. No Docker daemon was needed.
- **Who did what.** pi's coding agent (`@earendil-works/pi-coding-agent` 1.1.0) on `deepseek-flash` wrote `test.mjs`,
  the fix and `RESULTS.md`, confined to `celld-sketch/`. I acted as the gate: read the diff, reran the test on the fixed
  sketch (7/7) and on the original `index.js` in a scratch copy (5/7, failing exactly where pi said), and checked
  `RESULTS.md` against those runs.
- **Two harness lessons from driving pi:**
  - `pkill -f "celld dev"` killed pi itself, because its command line held the whole brief, which mentions
    `celld dev`. Pass long prompts as `@file`, and stop processes by PID.
  - In print mode pi reads piped stdin as part of the prompt; launched in the background with stdin left open, it
    waited 45 minutes for end of input without making a single model call. Run it with `< /dev/null`.
- **The finding.** The unchanged sketch passed 5 of 7 scenarios with no errors. A running facet keeps the class it
  started with: `ctx.facets.get` returns the cached facet and never re-runs its startup callback, so after a new
  version went live, calls still ran the old code (4 instead of 13). The restart scenario then failed as a knock-on
  (14 instead of 23: state persisted, but on top of the wrong value). celld documents `ctx.facets.abort(name, reason)`,
  which stops a facet and keeps its database; calling it after the catalog flips `live` fixes both. `ctx.facets.delete`
  also works, so the scratch facet used for checks is now deleted without a guard.
- Not covered: the agent loop on celld, concurrent calls, a crash mid-call, a multi-node fleet.

## Round 6: one command, any model

- **Ask.** Make it as easy to start as other harnesses, and make the model pluggable. A TUI came up too; it would be a
  TypeScript layer on pi's own `@earendil-works/pi-tui` (a Rust TUI would only add a second process and a protocol for
  no speed gain, since a turn waits seconds on the model), and it comes after this round, so this round stays plain text.
- **Who did what.** pi's coding agent on `deepseek-flash` wrote `model-config.ts`, `start.ts`, `chat-loop.ts`, the
  `forge` script and 20 tests from a brief that banned real model calls. Its report matched the diff, and check and
  tests passed when I reran them. I then fixed what review turned up:
  - a model named explicitly was accepted even when its provider had no key, so the error came at the first turn; it
    is now refused up front, with a test;
  - `forge` changed into its own directory, so a relative `--data` landed inside `prototype/`; it now stays in the
    caller's directory and only `npm ci` runs in the script's;
  - the auto-pick defaults were a year old (Haiku 4.5, gpt-5-mini, gemini-2.5-flash); they are now current mid-priced
    models, and a test checks each exists in pi-ai's catalog;
  - the library cap (60 calls, $0.25) fits a scripted run but a chat on a mid-priced model outgrows it in a few turns,
    mostly through compactions, so `./forge` uses 300 calls or $1, still a hard stop.
- **Pricing.** The meter took DeepSeek's prices as a fallback; it now uses the request's own `model.cost` from pi-ai's
  catalog when pi-ai reports no cost. A custom `--base-url` model is priced at zero.
- **End-to-end runs (all here, through `./forge`):** no key → the demo, then the hint; `--model deepseek/...` without a
  key → refused, exit 1; a real chat ("keep a tally of books") → the model's first proposal was rejected by its own check
  (a whitespace title), the second accepted with 12 checks and 40 fuzzed inputs, then used: 26 calls, $0.0194, about 70%
  cache reads; the same `--data` again → "15 messages so far", and the answer came from the existing tool; `--base-url
  https://api.deepseek.com/v1 --model deepseek-flash` with `FORGE_API_KEY` → a reply, priced $0, 0% cache (the generic
  OpenAI-compatible parser does not read DeepSeek's cache field, and the custom model has no catalog price).
- **The environment quirk.** Here the proxy injects the DeepSeek key, so the runs set `DEEPSEEK_API_KEY=proxy-injected`
  on the command line; the code no longer sets it itself.
- Not done: the TUI; a per-model smoke comparison (the round 4 script on several models); a check that a model supports
  tool calls (pi-ai's catalog has no such flag).
