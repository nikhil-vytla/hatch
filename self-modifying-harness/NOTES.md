# Notes: self-modifying software on pi-durable, OptChat and celld

Working log. Newest findings are at the bottom of each section.

## Brief

Build software that can modify itself, using three pieces:

- [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable): a durable agent harness.
- [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): an endless chat whose memory is a binary tree of summaries.
- [celld](https://github.com/denoland/celld): self-hosted Durable Objects.

Keep this folder self-contained. A sibling folder, `chat-grown-software/`, covers Geoffrey Huntley's "grow an app by
talking to it" idea. Lessons may cross between the two folders, but code may not.

## Environment

- The egress proxy blocks `ghuntley.com`, `celld.dev`, `gist.githubusercontent.com` and `web.archive.org`. It allows
  `git clone` from github.com and gist.github.com, and the npm registry. I read the gist by cloning it as a git repo.
- `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-codemode` are all 1.0.3 on npm. They run on Node 22.22 with
  `--experimental-strip-types`, so no build step is needed.
- No model API key was available, so every demo uses pi-ai's faux provider. Each request still goes through the real
  harness, hooks, tools and storage. Faux replies can be factories that see the request, which I used to assert what a
  real model would see (for example, "is the tool I just wrote on offer?").
- celld could not be run: its installer (`celld.dev`) is blocked and so is the release download. The `celld-sketch/`
  is written against celld's own examples (`facets`, `dynamic-worker-tails`) but is **untested**.

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
  rebuilt from the catalogue document on every change and hot-installed with `registry.install`.
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
- **Catalogue** is a pi-durable session document, committed atomically. It records every version, the live pointer,
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

- The migration runs against the real state *before* the catalogue commit, so a crash between them leaves migrated
  state under old code. On celld both would be in one Durable Object's SQLite and could share a transaction. Here
  they are two databases. A fix would record a "migrating to version X" intent in the cell's SQLite, inside the
  migration transaction, and finish or undo it on boot.
- Checks are example-based and written by the agent. Ratcheting stops silent regressions, but nothing stops the agent
  from writing weak checks for a new feature. The sibling folder works on this (caller-owned goals and invariants,
  use-trace replay).
- QuickJS cold start of about 140 ms per call is fine for tools but not for hot paths. A pooled sandbox per cell
  version would fix it, and celld's isolates are warm by design.
- The truncating summarizer is a placeholder. OptChat's value depends on a good compactor, and the `Summarizer`
  interface is where a model would plug in.
- The agent cannot (yet) modify its own system prompt sections or the memory hook. That is deliberate, since both are
  kernel, but a "skills" layer of prompt sections as cells would be the natural next step.

## Round 2: Brief A, with gdp-ts and anti-slop

Sonnet subagents wrote the code; every step was re-verified here before committing (tsc, oxlint, tests, demo, and a
read of the trusted modules). Sources: [rauchg/gdp-ts](https://github.com/rauchg/gdp-ts) (Ghosts of Departed Proofs,
compile-time proofs; skill read in full) and [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (Oxlint rules
rejecting low-evidence TypeScript; its `install-anti-slop` skill was followed).

### Tooling

- `tsc` 7.0.2 strict, Oxlint 1.87.0, anti-slop's 18 generic rules plus `oxc/no-accumulating-spread` at error, and the
  gdp-ts Oxlint preset (default mode, `proofs: ["src/proofs/**"]`). The gdp preset returns only
  `{ jsPlugins, overrides }`, so it is merged rather than spread over the config.
- anti-slop is meant to be vendored, but this repo commits only code we wrote, so `scripts/vendor-anti-slop.sh` fetches
  it at a pinned commit (`c44ef22`) into a gitignored `tools/oxlint/anti-slop/`. Run `npm run vendor` after cloning.
- Baseline on the round-1 code: 24 type errors (one root: `Catalogue` did not fit pi-durable's `JsonObject`) and 228
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
| `CellVerified<C>` | `verifyCell`, only after the whole gate passes; carries a fingerprint of the candidate's JSON | `acceptVersion` (the only writer of a version into the catalogue) |
| `CellAccepted<C>` | `withAcceptedVersion`, only for a version in the cell's history | `rollbackVersion` |

`src/mistakes.ts` holds 15 `@ts-expect-error` lines (installing a hand-made catalogue, accepting an unverified or
different candidate, a raw `CellVersion`, a forged proof, proofs escaping their callbacks, ...). Removing the directives
gives exactly 15 type errors, so each line guards a real mistake.

The gate, in order: compare-and-swap on `expectLive` (checked again inside every transaction); name, version id, at
least one check; model-proposed invariants may be added but never dropped; every enum member of an action-like
parameter must appear in the version's own checks; `changes` names real actions; migration on a scratch copy, the
check ratchet and purity, all under both invariant lists; replay of up to 50 real calls of the live version (a diff in
an action listed in `changes` is reported as a behaviour change the user should hear about, any other diff rejects);
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
- Proofs describe the moment of the read: `installCells` can be handed an older, still-committed catalogue.
- A rollback does not re-run the gate, so an old version can break an invariant added later; it is enforced at call
  time only.
- The `CellsDoc` token is confined to the trusted modules by a `no-restricted-imports` lint rule, not by types.

gdp-ts's own guidance ("prove the facts whose absence would be an incident, and stop there") is why these stay as
documented limits: each would need a proof threaded through pi-durable's API or the runtime, for a threat (a hostile
caller inside the kernel) this prototype does not have.

### Not done

- A model-backed OptChat summarizer: no API key in this environment.
