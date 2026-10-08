# Notes (Pharo Smalltalk kernel)

## What I built
- `src/ChatKernel/` (Tonel): `CkKernel` (JSON-lines server, ops, gates, persistence), `CkGate` (static gate on the AST),
  `CkJson` (JSON boundary + the three invariants), `ExpenseBase`/`ExpenseApp`/`ExpenseCandidate` (state holder, live class,
  scratch class). `setup.sh` copies /opt/pharo/Pharo.image to `build/kernel.image` and loads the package with
  `TonelReader` + `MCSnapshot install`, then saves. `run.sh <dir>` copies that image to `<dir>/world.image` on first start.
- Result: `conformance.ts smalltalk` 51/51.

## Choices
- Selector convention: function name = first keyword. `add_expense(a,c)` -> `add_expense: a category: c`; the call is
  dispatched on (name, arity) so the other keywords are free (a model writes `category:` instead of `with:`). 0 args = unary.
  An optional argument is a second method of different arity (turn 8 ships both, the 2-arg one delegating with `note: nil`).
- Live code = methods in `ExpenseApp`; scratch = `ExpenseCandidate` rebuilt from (live code map + forms - removes) for every
  try/develop/rollback, so a try never touches the live class. Both subclass `ExpenseBase` (kernel methods `state`, `state:`
  cannot be redefined: forms may not define anything Object/ExpenseBase understands).
- Timeout: each call runs in a forked process at background priority; the main process waits on a semaphore for 1 s, then
  `terminate`s the worker. `[ true ] whileTrue` and infinite recursion both end cleanly in ~1 s. First timeout aborts the gate.
- Persistence: `world.json` (code map per revision, state, examples, traces, request results) written atomically after every
  change (1.7 ms for the 8-turn world) + `world.image` saved at clean EOF (`Smalltalk snapshot:andQuit:`, 256 ms for 55 MB).
  world.json is authoritative; on start the code map is reconciled with the methods already in the image (same source =
  untouched), so a fresh snapshot makes resume skip recompiling. A kill -9 loses nothing but the snapshot.
- Not done: `laws` are ignored (would need a state generator on our side). Timing of start: 130 ms warm, ~0.5 s first start
  (copies the 55 MB image).

## Things that bit me
- `Semaphore>>waitTimeoutMilliseconds:` answers TRUE when it timed out (inverse of what I assumed).
- Pharo's `st file` does not exit after a successful script (use `Smalltalk quitPrimitive`) and `!` is a chunk separator in
  `st` files; `displayNl` does not exist on strings in 12 (use `traceCr`, or write to `Stdio stdout`).
- `Stdio stdout nextPutAll:` of a WideString writes UTF-32. Fix: output is pure ASCII JSON (non-ASCII as \uXXXX); stdin is
  read as bytes and `utf8Decoded`.
- STONJSON refuses OrderedCollection in JSON mode -> own `CkJson toJson:` converts everything to Dictionary/Array first.
- RBParser `parseMethod:` on bad source signals CodeError (good: "exactly one method" is just "it parses"); variable kinds
  (`isGlobalVariable`, `isUndeclaredVariable`, `isThisContextVariable`...) need `methodClass:` + `doSemanticAnalysis` first.
  `isSelfVariable` is only valid after semantic analysis; for post-hoc checks compare `name = 'self'`.
- Epicea: `EpMonitor current log entries` is a stale cache (empty); use `priorEntriesFromHeadDo:` (newest first).
  Entry timestamps were nil in headless mode. `EpMethodModification` has no `selector`, use `methodAffected selector`.
- Pharo's `st` with a faulty Tonel/typo can hang forever in the background: always wrap runs in `timeout`.
- The rollback conformance check is "rolled back or cleanly refused": with the recorded 3-argument trace the previous add_expense
  cannot replay, so rollback is refused (by traces). A rollback that is accepted is shown in the showcase.

## Latencies (conformance run, 4 cores)
start (first observe, new dir) ~130 ms; develop avg 24 ms (8 turns incl. compile of candidate + replay); `loops` probe 1.03 s
(the 1 s limit); restart 115 ms.
