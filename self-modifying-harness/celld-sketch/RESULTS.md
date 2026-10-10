# Forge sketch on celld 0.6.2 — test results

Environment: celld 0.6.2, Node 22, run from this directory. `test.mjs` starts
`celld dev` on a free port, runs the scenarios with `fetch`, restarts celld,
and exits non-zero on failure:

```sh
node test.mjs
```

## 1. The unchanged sketch

`celld dev --clean .` built and served the sketch unchanged. There were **no
celld error messages and no exceptions**. Most of the design worked:

- `ctx.storage.sql.exec()` created the catalog tables and stored versions.
- `POST /propose` ran the checks in a scratch facet and returned `{"ok":true}`
  for passing checks and `{"ok":false,"check":0,"got":100}` for failing ones.
- The scratch facet was isolated: after checks that ended at 3, the first real
  call returned 1, proving the real facet started at 0.
- `POST /call` wrote the `call:<id>` result and returned it, so different call
  ids incremented and a repeated call id returned the cached result with no
  second increment (exactly-once).
- A failing proposal left the live version unchanged.
- State survived a celld restart without `--clean`.

The one failure was silent wrong behavior on a **code upgrade while the facet
was warm**. Scenario e proposed `counter-v2` (increment by 10) and then called
the cell. The proposal succeeded (`{"ok":true}`), but the call returned `4`
instead of `13`: the facet kept running the old `counter-v1` class and
incremented by 1. Scenario f then inherited the wrong state (`14` instead of
`23`).

Unchanged test output (excerpt):

```
PASS a. propose counter with passing checks -> ok:true
PASS b. two calls with different callIds -> 1 then 2
PASS c. repeat the second call with the same callId -> 2, no increment
PASS d. failing checks -> ok:false and the live version is unchanged (next call 3)
FAIL e. v2 takes effect while the facet is warm and keeps state (3 -> 13)
     POST /propose -> HTTP 200 {"ok":true}, next call -> 4 (expected 13)
FAIL f. restart without --clean -> state persisted (13 -> 23)
     after restart, call -> 14 (expected 23)
PASS g. checks run on scratch state: first real call starts at 0, not at 3
5/7 scenarios passed
```

A longer manual run showed the same bug: after `n` reached 5, proposing v2 and
calling returned `6` where `15` was expected.

Cause: celld's `ctx.facets.get(name, callback)` caches a running facet by name
and returns the existing stub without running `callback` again
(`DurableObjectFacets._running` in celld's `harness.js`). The callback is the
only place the loaded class is named, so a new version's class does not reach a
facet that is already running. The facet only picks up the new class when it is
stopped and started again (for example by an eviction or a node restart).

## 2. Fix

In `propose`, after the new version is written and `cells.live` is flipped, stop
the cell's facet so the next call loads the new class:

```js
// A running facet keeps the class it started with, so stop it to load the new code. `abort` keeps the database.
this.ctx.facets.abort(name, "cell version changed");
```

celld documents `ctx.facets.abort(name, reason)` as stopping a facet while
keeping its database, and the next `ctx.facets.get(name, ...)` re-runs the
startup callback. That keeps the design's promise that a facet's storage is
keyed by the cell name and outlives the code version, while the code can be
upgraded. `abort` on a facet that is not running is a no-op, so the call is safe
for the first proposal too.

The same run confirmed that `ctx.facets.delete(name)` is implemented in 0.6.2,
so the scratch facet is now deleted without the `?.` probe and the comment no
longer treats deletion as an open question.

No other API was unsupported.

## 3. Final test output

```
celld test on http://127.0.0.1:37333

PASS a. propose counter with passing checks -> ok:true
     POST /propose -> HTTP 200 {"ok":true}
PASS b. two calls with different callIds -> 1 then 2
     call b1 -> 1, call b2 -> 2
PASS c. repeat the second call with the same callId -> 2, no increment
     repeat b2 -> 2
PASS d. failing checks -> ok:false and the live version is unchanged (next call 3)
     POST /propose -> HTTP 200 {"ok":false,"check":0,"got":100}, next call -> 3
PASS e. v2 takes effect while the facet is warm and keeps state (3 -> 13)
     POST /propose -> HTTP 200 {"ok":true}, next call -> 13 (expected 13)
PASS f. restart without --clean -> state persisted (13 -> 23)
     after restart, call -> 23 (expected 23)
PASS g. checks run on scratch state: first real call starts at 0, not at 3
     POST /propose -> HTTP 200 {"ok":true} (checks ended at 3), first real call -> 1 (expected 1)

7/7 scenarios passed
```

## 4. celld limitations and notes

- **No hot class swap for a running facet.** `ctx.facets.get(name, callback)`
  never re-runs the startup callback while the facet runs, so a new Worker
  Loader version cannot take effect until the facet is stopped. The only
  documented way to keep the database and restart the facet with a new class is
  `ctx.facets.abort(name, reason)`, which this fix uses. There is no API to ask
  a running facet for its class or to replace it in place.
- **The exactly-once cache lives in the facet, so it is kept across an abort.**
  This is required for the design and works, because `abort` keeps the database.
- **Deletion works.** `ctx.facets.delete(name)` stops the facet and removes its
  database; the scratch facet created for each `propose` is cleaned up with it.
- **Not covered by the test:** the agent loop, concurrent calls (the sketch
  relies on the single-threaded object and one synchronous turn per event), a
  crash in the middle of a call, and the "one or two followers" durability
  behavior of a multi-node fleet. The test runs a single local node. These are
  out of scope for this sketch and are not claimed.
