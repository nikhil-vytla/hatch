# Working on strive

strive is a Rust daemon (`crates/`) plus TypeScript clients (`packages/`). Read
`docs/ARCHITECTURE.md` before changing how they talk. This file lists traps, not a map.

## Before you say it works

- `scripts/check.sh` is what CI runs: fmt, clippy `-D warnings`, cargo tests,
  protocol drift, Biome, Oxlint, tsc, bun tests. Run it before every commit.
- Run narrow tests while you iterate: `cargo test -p strived --test gateway <name>`,
  `bun test packages/host`. Then run the whole script.
- A failing or flaky test is yours to explain. Never assume it was already broken.
  A test that fails 1 run in 5 is a race, either in the code or in the test. Find
  which one before you change anything.
- Tests never hold real provider keys. `check.sh` unsets them, and
  `crates/strived/tests/common` points upstreams at a dead port. Keep it that way.

## The boundary that matters

- The daemon is trusted and the host is not. The host has no keys and no file access.
  Every model call goes through the gateway, and every file or shell action is an
  effect the daemon authorizes, journals and runs. Don't add a shortcut around this,
  even in tests.
- Journal first. A client may learn that something happened only after the journal
  records it. For example, the gateway journals a call's finish before the client's
  stream ends.
- Money is integer micro-USD. `f64` exists only while settings load. A call whose
  cost is unknown is charged everything it reserved, never nothing.

## Rust

- Clippy denies `unwrap`, `expect`, `panic!` and `todo!` outside tests. Encode the
  invariant in a type, or return an error. If something really can't fail, use
  `#[expect(clippy::expect_used, reason = "...")]` and state why.
- Suppress a lint with `#[expect(lint, reason = "...")]`. `#[allow]` is denied, so a
  stale suppression breaks the build. If a lint flags dead code, delete the code.
- Match your own enums exhaustively, with no `_` arm, so a new variant fails to
  compile where it needs handling.
- `let _ =` on a fallible call needs a reason to exist. The accepted one is sending
  to a receiver that may be gone. Otherwise, propagate the error or log it.
- Take std locks with `crate::sync::lock`, `read` or `write`. Never hold one across
  an `.await`; clippy denies it.
- Use `anyhow` in the `strived` binary and concrete error types in library crates.
- The Rust types in `crates/proto` are the protocol. `cargo test -p strive-proto`
  regenerates `packages/protocol/src/generated`. Never edit generated files.

## TypeScript

- Oxlint runs anti-slop (`tools/oxlint/anti-slop`, see its `UPSTREAM.md`).
  - Parse data from outside at its boundary with type guards. Don't read it
    through `any` or cast it.
  - Every remaining `as` needs a `// SAFETY:` comment that states the invariant.
- Use `describeError` from `@strive/protocol` to show a thrown value, not
  `(e as Error).message`.
- `FakeDaemon` handlers are typed by the protocol. Type fixtures as `Entry`,
  `SessionInfo` and so on, so they can't drift from the daemon.
- Pin dependencies exactly. Bump `oxlint` and `@oxlint/plugins` together.

## Tests

- Test behavior through real interfaces:
  - the real daemon (`startDaemon`, `crates/strived/tests/common`)
  - the real TUI in a virtual terminal (`VirtualTerminal`)
- Fakes are only for network edges and for orderings the real daemon won't produce
  on demand (`FakeAnthropic`, `FakeDaemon`).
- A bug fix starts with a test that fails without the fix.
- No tautological tests. A test must be able to fail when the behavior breaks.
  Don't assert a value you just set, or a constant.
- Don't hard-code journal sequence numbers. Find entries by type, or derive seqs
  from the journal.
- Wait for a condition (`wait_for`, `term.waitFor`), not for a fixed time.
  "Visible on disk" is not "committed and reported". Wait for the signal the code
  under test acts on.
- `scripts/mutants.sh` runs cargo-mutants on the library crates. A surviving mutant
  means a test is missing. It is rarely dead code. Record an equivalent mutant with
  its reason instead of deleting code to kill it.

## Writing

- Comments explain why, or state an invariant. Don't narrate the code, its
  history ("now", "previously", "no longer") or the conversation that produced it.
- User-facing text is plain and specific: say what happened and what to do next.
- Commit subjects start with `strive: `. Commit each verified unit.
