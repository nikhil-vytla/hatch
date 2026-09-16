# Working notes — arena candidate 4 (axis D, workspace-first)

Append-only log of what I tried and what I learned while producing this design package.

## Order of work

Followed the runner discipline literally: `USAGE.md` first, in full, before any type existed.
Wrote the three call sites (Slack, web server, local test) as if the library already shipped,
then derived `SKETCH.ts` from them. Two places where the sketch and the usage disagreed, and in
both I changed the sketch, not the usage:

1. `scriptedAgent` originally took `ToolCall[]` (`{tool, args}`). The test call site had written
   `{ tool: "edit", path, to }`, which reads better. Added a domain-level `ScriptStep` union to
   match. The usage was right: a test asserting gate behaviour should not have to build an args
   bag.
2. `localPorts({ origin })` originally took `{repo, path}`. The test passed a `gitFixture(...)`
   result straight in and then called `origin.readAtHead(...)` on it. Added `OriginFixture` with
   `head`/`readAtHead`/`commit` so the fixture is one object rather than two.

One naming fix in the other direction: the usage referenced `turn.acceptedAt` as the stream
cursor, which reads like a timestamp when it is a sequence number. Renamed to `turn.queuedSeq` in
both files.

## Where the axis actually paid off

Picking workspace-first as the root aggregate was assigned, but three things fell out of it that
I did not expect when I started:

- **Freshness stops being session state.** The baked-in commit belongs to the image generation,
  which is repo-scoped, so `Freshness` is derivable rather than stored. Under a session-rooted
  design I would have had a per-session `syncedAt` that can disagree with the sandbox. Here it
  cannot, because there is nowhere to write a second copy.
- **Webhooks route with no index.** The workspace owns the branch namespace, so
  `branchOfSession` has an inverse and a `pr.merged` delivery resolves to a session by parsing
  the ref. I had assumed a branch→session table was unavoidable.
- **The reaper has an obvious home.** Leaked sandboxes after a crashed session are a real cost
  problem and need something that can see the whole population of slots. Workspace-first has
  exactly one such thing.

The cost is equally real and I did not manage to design it away: leasing is now a cross-Durable-
Object protocol. Fencing epoch + TTL + reaper makes it eventually consistent, not correct by
construction. Written up as the leading open question.

## Things I tried and backed out of

- **Modelling slot dirtiness as a fifth `Freshness` state** (`dirty`, meaning the session has
  written to the tree so the slot can no longer be recycled into the pool). Wrong: dirtiness is
  orthogonal to git delta, and jamming it into one union meant states like "fresh and dirty" had
  no representation. Replaced with a derived property — a slot is recyclable iff `admitWrites`
  was never granted on its lease, which is already recorded.
- **A `SandboxService` sitting under the session**, i.e. the shape I ended up listing first in
  the alternatives. Got two paragraphs into the types before noticing that the service owned
  mutable shared state (pool, generations) with no aggregate boundary around it, which makes it
  a second root wearing a service's name.
- **Putting `admitWrites` on the session** (`session.beginEdit()`). Meant the session had to know
  about freshness, which reintroduces the second copy of the sync state I had just eliminated.
- **A `policy/` directory** for the pure functions. That is the layer split `design-red-flags.md`
  warns about; they belong with their owners (`planPool` in `workspace/pool.ts`, `advanceQueue`
  in `session/queue.ts`). They are collected in one section of `SKETCH.ts` only for readability,
  and `MODULES.md` says so explicitly.

## Found during the self-check

`SessionLifecycle` was carrying `SlotLease` on `active` and `SnapshotRef` on `parked`, so
`session.view()` shipped slot ids, snapshot ids and lease epochs to every web client. Split into a
private `LeaseBinding` and a public `SessionLifecycle` with `publicLifecycle` as the only
projection. This is the kind of leak that survives review because both types are "ours" — the
question that caught it was "would a Slack renderer ever use this field?".

## Verification

`SKETCH.ts` typechecks clean:

```
npx tsc --noEmit --strict --target ES2022 --lib ES2022,DOM \
  --moduleResolution bundler --module ESNext SKETCH.ts
```

That is a weak signal (a file of interfaces and `throw` bodies is easy to keep compiling) but it
does catch the real mistakes in a sketch this size: unions that do not discriminate, brands used
interchangeably, and interface extensions whose method signatures do not actually widen. The
`MutableSlot extends LeasedSlot` widening of `run` is the one I specifically wanted the compiler
to confirm.

Not verified: the usage snippets do not compile, because they import client libraries and
renderers that do not exist. I read them against the sketch by hand instead, method by method,
and fixed the four mismatches listed above.
