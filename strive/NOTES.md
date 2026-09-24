# strive implementation notes

[ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the current design and
[the ADRs](docs/adrs/README.md) record durable decisions. These notes track
implementation findings and verification; they do not replace that design.

## Current implementation

The current code is `src/strive`, with independent run formats and artifact
roots. The pre-vNext kernel has been removed (see "Post-merge cleanup" below).
A local serial supervisor owns effects, reservations, continuation and revision
activation over authenticated journals and immutable objects. Pure replay checks
that history without importing candidate, runtime or benchmark implementations.

Model harnesses are bounded generation services behind a trusted gateway.
BenchmarkAdapter owns workload operations and scoring outside the core. Counter
provides deterministic workflow coverage, and tau2 telecom uses a separately
installed interpreter and retained workload closure. ContinualRefine changes
complete bundles using authorized evidence; comparison is optional.

Linux confinement adds namespaces, seccomp, cgroup limits and bounded scratch.
Host Deno permissions have a narrower claim. Native CLI qualification, installed
tau2 checks and funded campaigns are separate gates. The manifest CLI currently
runs the recorded counter workflow. Fork enactment and private-veto feedback C
remain deferred.

## Documentation and fixture cleanup

- Checked the existing cleanup outline against implementation, contract tables,
  workflow fixtures, container scripts and prior qualification reports. Several
  entry points still described the earlier kernel and required replacement.
- Rewrote architecture, root/package READMEs, charter, roadmap and handoff around
  current responsibilities and honest limits. Added ADRs 0009–0013, refreshed the
  index and marked ADR-0008's implementation description as historical.
- Moved both runtime-consumed hash manifests into `tests/vnext/baselines` and
  updated their three test readers. The historical 21-file manifest remains
  byte-for-byte intact. All 30 current hashes matched before the approved edit.
- Changed only the documentation pointer in `contracts/__init__.py`, regenerated
  that one current-baseline entry and added the initializer to the harness
  test's exact approved changed set. The other four approved paths remain the
  broker, supervisor, verifier engine and manifest. No execution logic changed.
- Consolidated durable findings before removing the superseded design/handoff
  and all requested investigation folders. Removed stale ignore rules and
  refreshed the tau2 guide. The archive remains unchanged.
- Preserved the actual adaptive counts, 49/29/36 across three roots. Three
  development passes mean 147 episodes per trajectory. Fixed-stock remains a
  separate 40-task upstream-actor evaluation.

## Validation

- `uv run mypy --strict`: no issues in 180 source files.
- Full vNext host suite: **487 passed, 24 skipped, 1 xfailed**, 512 collected,
  in 922.17 seconds. The expected failure is deferred `EvaluateFork` enactment;
  host skips retain the Linux/tau2, native-profile, funded-smoke and socket gates.
- All three relocated-baseline tests passed independently. All 30 current hashes
  match, the historical manifest is byte-identical, and the exact historical
  changed set is the five approved files. Only the initializer's hash changed
  during this cleanup; its executable AST is unchanged.
- The requested removed-reference scan and an expanded scan of all removed
  directory names are clean outside the untouched archive. Local documentation
  links and heading anchors resolve; `git diff --check` is clean.
- Generated and parsed the README's counter example and verified vNext CLI help.

The default pytest launch encountered a restricted uv cache; a local cache then
reproduced the known macOS automatic-sync panic. The successful full run used
`UV_CACHE_DIR="$PWD/.cache/uv" UV_NO_SYNC=1 uv run pytest tests/vnext -q` against
the installed environment. No test was changed to accommodate those tool errors.
This result does not claim a fresh dependency sync or Linux qualification.

The sandbox denied the parent repository's Git index lock, so the authorized
files were deleted directly and all changes remain unstaged for the orchestrator.
No commit or PR was created. The temporary cleanup work folder was removed after
its findings were incorporated here and in the permanent documentation.

## Post-merge cleanup (2026-09-16)

With PRs #50–#52 fully merged, `investigations/`, `tau2-egress-counting-fix/`
and the investigation narrative from `live-tau2-budget-proof/` (README, NOTES,
changes.patch, proof/log files) moved to `archive/strive/` at the repo root —
their findings were already folded into this file and the permanent docs, so
only the raw records moved, not the module tree. `live-tau2-budget-proof/`'s
three actual test fixtures (`pilot-5usd.toml`, `budget-stop-5c.toml`,
`prices/openai-2026-09-10.json` — read by `test_live_campaign.py` and
`tests/live/test_budget_stop_live.py`, not just historical record) moved
instead to `tests/vnext/fixtures/budget-proof/`. The legacy pre-vNext
implementation
(`kernel.py`, `substrate.py`, `runtime.py`, `sandbox*.py`, `policy.py`/`policies/`,
`refine.py`, `budget.py`, `operate.py`, `cas.py`, `framing.py`, `codec.py`,
`events.py`, `evaluate.py`, `strategy_runner.py`, `surfaces.py`, `tasks.py`,
`contracts.py`, `model.py`, and their tests) and its dual-mode CLI branch were
removed; the installed `strive` command now delegates directly to
`strive.cli.app`. Removing legacy also removes its `view`/`history`/
`inspect`/`revert`/`repair`/`sandbox` subcommands, which had no vNext
equivalents — any pre-vNext run histories on disk no longer have a CLI to
inspect or repair them.

## Collapse `strive.vnext` into `strive` (2026-09-16)

With the legacy kernel gone, `vnext` no longer distinguished anything from
anything else, so `src/strive/vnext/*` moved up to `src/strive/*` directly
(the old `strive/cli.py` delegator was deleted; `strive/vnext/cli/` took over
the `cli` name and its `__init__.py` re-exports `main` so the
`strive = "strive.cli:main"` entry point is unchanged). Internal relative
imports needed no changes (the whole subtree shifted up by one uniform
level), but two `Path(__file__).parents[N]` computations that reached
*outside* the moved subtree needed their index decremented by one
(`cli/campaign.py`'s `repository` lookup), and a few hardcoded
`"src/strive/vnext"` path strings and `strive.vnext.*` dotted references in
tests, the two benchmark adapters, docs, the Containerfile and
`scripts/verify-in-container.sh` were updated. Left untouched on purpose:
`tests/vnext/` (the test tree keeps its name), and the on-disk format/default
strings that happen to contain "vnext" — `wire.py`'s
`FORMAT = b"strive-vnext-store/1\n"` (a versioned wire-format tag) and the
`artifacts-vnext`/`artifacts-vnext-workflow` default root names in
`store/journal.py`/`cli/app.py` — none of those are naming artifacts of the
package split; they're data-format/runtime-default identifiers, out of scope
for a Python-import-path rename.

## Non-benchmark workload finding + round-count proof (2026-09-20)

Traced whether `ContinualRefine` actually requires scoring/episode structure
(it does not — `refine()` never touches score; `EvidenceSelector` uses episode
only as an opaque key) versus what's actually missing for non-benchmark work
(a real-environment adapter; a generic adapter-agnostic driver; open-ended
loop termination). See [ADR-0014](docs/adrs/0014-non-benchmark-workloads-scope.md)
for the full finding and evidence.

Made the counter fixture's round count configurable (`Session`/`run()` gained
`rounds: int = 2`, default unchanged) instead of a hardcoded 2-task stream.
This surfaced a real bug caught by a Codex stop-hook review before it shipped:
the fixture's comparison plan hardcoded `"horizon": 2`, which
`report/compare.py` checks against `coverage.planned` and would have rejected
any non-default-`rounds` run as a horizon mismatch. Fixed by tying `horizon`
to `rounds`.

Ran the fixture at `rounds=20` (with `model_calls` raised from the default 10
to 30 to get past an early suspension): 19/20 episodes admitted, 18/20
completed, 0.85 observed fulfilment, then safely suspended at `runtime.step`
on the manifest's `wall_seconds=120` budget — real sandboxed subprocess
overhead per round, not an episode-count or scoring ceiling. That suspension
is itself further evidence for the finding: nothing about scaling past 2
rounds broke; the mechanism is bounded only by declared resource budgets.

Also fixed, unrelated but discovered along the way: an earlier `uv sync
--frozen` (verifying the README quickstart) had silently stripped `pydantic`/
`python-dotenv` from the venv, which `adapters/tau2/src` needs at type-check
time (its own runtime uses a separate `--extra telecom` venv). They were only
ever present as transitive dependencies of the now-removed `dspy`. Added both
as explicit dev dependencies in `pyproject.toml` and regenerated `uv.lock` so
`uv sync --frozen` reliably restores them; `uv run mypy --strict` is clean
again (146 files).

## 2026-09-22: Rebuild, M0 (branch `strive-rebuild`)

- **Decision:** rebuild as a usable agent (ADR-0015). A Rust daemon owns the
  trusted parts, and the TS agent host, TUI and Electron app are clients.
  The Python tree was removed; its last state is tag `strive-py-final`.
  Ignored local outputs (`live-results/`, `.venv/`, tau2 retained data) were
  left on disk.
- **UI spike** (throwaway, in `/tmp/strive-ui-spike`, not committed):
  - Electron held 120 fps while streaming and delivered all 2000 tokens.
  - Tauri was capped at 60 fps, used 73% CPU and delivered 1668 tokens.
  - GPUI used the least memory (~100 MB settled) but collapsed to 24–30 fps.
    The cause is frame pacing on ProMotion, not workload: it happened with
    static content too.
  - Electron was chosen.
- **pi-mono check:**
  - `pi-protocol`, `pi-server` and `pi-durable` exist but are "experimental,
    no compatibility guarantees", so they aren't used.
  - `pi-agent-core` has what the host needs: `execute` per tool (becomes a
    daemon RPC), `beforeToolCall` (authorization), a pluggable `streamFn`
    (the daemon gateway) and parallel tools.
- **Build id bug, found by a test:** on macOS a file copy keeps the source's
  mtime, so a size+mtime build id called a copied binary "current". The
  inode is now part of the id. A false "stale" costs only a restart.
- **`.gitignore` pitfall:** bare `src/` ignores every nested `src/`. Leftover
  patterns are anchored with a leading `/`.
- **tmux-driven TUI tests:** sending text and Enter in one `send-keys` call
  looks like a paste to pi-tui, so Enter becomes a newline. Send them
  separately.
- **M0 measurements (macOS, release):**
  - Warm `strive` to first TUI frame: 59 ms p50.
  - Cold daemon start plus a request: 16 ms.
  - Warm `strive status`: 3.1 ms.
  - Binaries: `strive` 1.5 MB; `strive-tui` 64 MB, mostly the embedded Bun
    runtime. The agent host should share that binary.

## 2026-09-23: Lint and agent guidance

- **anti-slop** (dmmulroy/anti-slop at c44ef22) is vendored in
  `tools/oxlint/anti-slop` and runs under oxlint 1.85.0 in `check.sh`.
  - It found 282 spacing issues, which the autofix handled, and 48 semantic
    ones.
  - The useful semantic findings:
    - RPC envelopes had been read through `any`.
    - `(e as Error).message` appeared 8 times; `describeError` replaces it.
    - pi-ai messages were cast where narrowing on `role` or `type` works.
  - Typing `FakeDaemon` handlers by the protocol's `Methods` map caught
    fixtures whose event `type` was widened to `string`.
  - `no-runtime-typeof` uses its `allowInTypeGuards` option, so type guards
    remain the way to parse.
- **Rust agent guidance.** Surveyed zed, uv, ruff, codex-rs, tokio,
  rust-analyzer, jj, helix, biome, turso and tikv.
  - Adopted the lint-enforceable parts:
    - `unwrap_used`, `expect_used`, `panic`, `todo` and `dbg_macro` are denied
      outside tests (codex, uv, ruff).
    - `allow_attributes` is denied, which forces `#[expect]` (biome).
    - `await_holding_lock` is denied (codex).
  - `await_holding_invalid_type` for tokio guards is not adopted.
    `Sessions::writer` holds the map lock across the journal open on purpose,
    so two writers can never open one journal.
  - The rest went into `AGENTS.md` as traps rather than a map, following
    Zed's rules-hygiene advice.
  - Integration-test crates get a crate-level `#![allow]` for panics.
    `allow_attributes` exempts inner attributes, and clippy's
    `allow-unwrap-in-tests` doesn't reach helpers outside `#[test]` functions.
- **Flaky writer-restart test, second cause.** The test made the session
  directory read-only once the call's start was visible on disk. The journal
  renames `head.json` into place before it fsyncs the directory. If the chmod
  lands in between, the sync fails and the commit is reported failed even
  though the head is visible.
  - The gateway then correctly refuses the call with a 500, and the start
    stays open until the session reopens. This is the documented
    conservative overcharge.
  - The test now waits for response headers, which arrive only after the
    start's commit was reported. The suite passed 18 runs in a row.
  - Diagnosis came from adding the client's status and body to the failure
    output. The daemon log alone showed no call ending, which pointed at a
    refusal after the start.

## 2026-09-23: M3 review (Codex), triaged and fixed

Codex returned 18 findings: 12 high and 6 medium. Codex reproduced four
host defects dynamically; it reasoned out the rest statically. Every one
held up. Each fix has a test that fails without it: a mutant, a stash of
the fix, or a run before the fix.

- **Approvals.**
  - A registered host could approve its own effects. It is now refused
    with -32013.
  - An approval could wait forever once its person left, and it held a
    writer sender, so shutdown never finished.
    - That is also why test daemons were found still running hours later.
      A `sample` of one showed shutdown stuck in `pthread_join` on a
      writer thread.
    - Writers now get an explicit `Stop`.
    - Approvals poll whether people are attached and whether the daemon
      is stopping.
    - A daemon whose socket is gone now exits.
- **Interrupts.** The host ignored the abort signal while a tool ran.
  - New `effect/cancel`: a waiting approval is refused, and a running
    command is killed.
  - The host calls it when its abort signal fires.
  - A thrown abort is recorded as interrupted or timed out.
- **Process containment.**
  - `set -m` jobs escaped the process-group kill. The whole process tree
    is now killed, found with `ps` while the command still runs.
  - The output collector is waited on for at most 1s.
  - Linux gets `--unshare-pid`, private `/tmp` and `/run` (for D-Bus,
    systemd, X11 and Docker sockets), and a scrubbed
    `DBUS_SESSION_BUS_ADDRESS`. CI now installs bubblewrap; this is
    unverified until CI runs.
  - macOS `launchctl submit` from inside the Seatbelt profile did not
    escape when tried. LaunchServices (`open`) was not probed, because it
    would open windows on the desktop.
- **Files.**
  - Effects act on the exact path the gate checked. `pinned.rs` walks it
    with `openat(O_NOFOLLOW)`.
  - Reads accept only regular files and stream them.
  - Each write gets its own temporary file.
- **Hosts.**
  - Registration is exclusive (-32014), and only the registered host may
    record or stream (-32015).
  - Registering and closing a connection are serialized, so there are no
    phantom hosts.
- **Transcript.**
  - Prompts are held until their turn starts.
  - Aborted or failed replies get no synthesized tool results.
  - Entries that arrive during startup are replayed.
- **Checkpoints.**
  - A rewind that would overwrite ignored files is refused.
  - Nested repositories are excluded and reported. Codex's finding led to
    a worse one: a nested repository with no commits made every
    checkpoint fail silently.
  - Effects and rewinds share a workspace lock.
  - The undo checkpoint is journaled before restoring.
- **A lesson from the harness.** The first run of the approval tests hung,
  because the tests reproduced the bugs. Test runs are now wrapped in
  `perl -e 'alarm N; exec @ARGV'`, since macOS has no `timeout`.

## 2026-09-23: Codex's review of the fixes, and M4 done

Codex re-reviewed `546a5e9..0e88806`. It judged 8 fixes sound and found 12
gaps, 8 of them high. All 12 were addressed; the macOS one only in the docs.
- **Fixed with a test that fails first:**
  - A host could loosen its own limits through `session/approvals` or
    `session/budget`.
  - A registration rollback could erase `Closed`.
  - A stale person flag on a host that attached before registering.
  - A rewind could destroy a nested repository, or ignored files named
    with different case.
  - Old gitlinks were re-added.
  - Workspace locks were per session, not per directory.
  - An effect cancelled before it ran still ran.
  - Shutdown left commands running.
  - Prompts journaled before `turnStarted` were misordered.
  - Linux Unix sockets outside /tmp and /run were reachable.
- **While fixing ordering:** resuming after a compaction dropped that
  turn's prompt. Compaction now covers only what precedes the turn.
- **Documented, not fixed:** on macOS a detached job can outlive a command
  that exits normally. There are no PID namespaces there.
- **A flake found by looping the suite:** a job forked between the `ps`
  scan and the kill escaped, 1 run in 5. The tree is now frozen with
  SIGSTOP first. 8 clean runs since.
- **Linux, tested for real.** podman's VM shares `/Users` but not `/tmp`.
  - The earlier bubblewrap changes pass there.
  - The socket test first passed on Linux for the wrong reason: its socket
    was in `/tmp`, which the sandbox now replaces. Moving it to
    `CARGO_TARGET_TMPDIR` exposed the escape.
  - It also exposed an MCP EPIPE race.
- **Side effect to remember.** The first `podman run` pulled
  `rust:latest`, and a registry credential helper printed "Opening browser
  to issuer.enforce.dev…", Canva SSO. Later runs use `--pull=never`.
- **Process slip, twice.** Piping `check.sh` through `tail` before `&&`
  let a failed check commit. Both commits were amended after a passing
  check. Commits now run only as `check.sh > log && git commit`.
- **M4 exit criterion.** Real Haiku 4.5 on this repo, $0.5 cap:
  - it answered from AGENTS.md (`scripts/check.sh` and what it runs);
  - it listed the `verify-strive` skill;
  - it called the fake MCP server's echo after TUI approval.
  - The journal holds `echo: strive`. `strive verify` passes on 18
    entries. The cost was $0.0069.
  - The run showed approvals displayed twice; that is fixed.

## 2026-09-23: Codex's third review

The third review covered `0e88806..fa637ec`. It found 15 issues, 10 of them
high, and judged 6 earlier fixes sound. All 15 were addressed; two only in
the docs, since they are known limits of the current design:
- the host isn't sandboxed, so a hostile host could open a second
  connection;
- MCP descendants that `setsid` out of their group survive.

What was fixed:
- **Seccomp filter:**
  - The pipe was inherited by concurrent commands, letting one command
    weaken another's filter. It is now close-on-exec and mapped to fd 3 of
    its own child.
  - `io_uring` could create sockets without the `socket` syscall.
  - Datagram `socketpair` could `sendto` a socket by path. A Linux mutant
    without that rule reaches an outside socket.
- **Fail-open sandbox:** the gate and the execution each built the
  sandbox. The gate now records its decision, and execution refuses if it
  can't honor it.
- **MCP:**
  - writes could block the reader or a call; they now go through a writer
    task, and a stall kills the server;
  - a cancelled tool could keep changing files; a server that ignores a
    cancellation is killed after 2s;
  - dead servers took calls; they restart lazily now;
  - startup held a global lock with no overall bound;
  - tool names could alias.
- **Shutdown:** admission now closes, the cancel sweep repeats, and rewinds
  are counted. If work hasn't settled, the daemon exits rather than
  releasing its lock.
- **Destinations:** writes outside the workspace now lock their destination.
- **Attach race:** attaching while registering is serialized.
- **Compaction replay:** fixed for Codex's interleaving.

On the tests:
- The attach and registration race didn't trigger in 20 pipelined tries,
  because registration always won. The test guards the invariant, and the
  fix is structural.
- The first MCP stall test failed for a harness reason: the fake went deaf
  before the second `tools/list` page was requested. So did the next run:
  the test client's 5s read timeout was shorter than the ~10s stall.

## 2026-09-23: Fourth review, M5 desktop, M6 headless

**Fourth review.** Codex found 9 issues, 4 high. It judged the descriptor,
fail-closed sandbox, attach and admission fixes sound. All 9 were
addressed.
- **MCP:**
  - Every failure path now goes through one terminate path: mark dead,
    kill the group, wait for exit, then fail the calls. A server that
    closed its output but kept writing files was the real gap; the new
    test shows the old code let its write through.
  - Process groups are tracked from spawn, so shutdown kills servers
    still starting.
  - The outbox is bounded.
  - Registering a request and marking the server dead share one lock.
  - Tool names are allocated against the final set.
- **Compaction:** the cutoff is the conversation's acknowledged journal
  seq, not the notification cursor.
- **Forced exit:** it kills the daemon's own process group, taking a
  rewind's git with it.
- **x32 syscalls:** refused on x86-64. Untested locally, since podman here
  is aarch64.
- **Documented:** strive stops a server that stays silent about a
  cancelled call, although MCP allows the silence.

**M5, the desktop app.**
- Electron app, React renderer, Playwright e2e under Node. Under Bun,
  Playwright's Electron launch hangs and its CDP connect fails on
  WebSockets.
- Bugs found on the way:
  - Bun's bundler bakes `__dirname` at the source file.
  - A function returned across `contextBridge` isn't callable.
  - Chromium's `scrollIntoView` now returns a Promise, which React took
    as an effect's cleanup.
- Widgets are served from a `strive-widget:` scheme with their own CSP,
  because a `srcdoc` iframe inherits the app's policy. A probe widget finds
  the parent, the bridge, storage and the network all blocked.
- Streaming over ~1000 transcript lines holds 120 fps (p95 10 ms), so
  there is no virtualization yet.
- Packaged unsigned with electron-builder; `install.sh` installs it.

**M6, headless.**
- `strive run` attaches as an observer, so approvals don't wait on nobody.
  Attached as a person, the test hangs.
- The CLI client now buffers notifications and reads cancel-safely.
- `"sandbox": "off"` is for task containers.
- **Harbor:**
  - The first hello-world trial failed because the bare ubuntu image has
    no CA certificates, so the daemon couldn't build its HTTP client. It
    now falls back to built-in Mozilla roots.
  - Terminal-Bench images are amd64, emulated on this Mac, so binaries are
    built per architecture: a static musl strive and Bun's baseline x64.
  - Results with Haiku 4.5: hello-world scored 1.0 ($0.0035). Terminal-Bench
    2.0 `fix-git` scored 1.0 in 40s: 11 calls, $0.036, via reflog, merge
    and conflict resolution.
  - The run reported 0 cache tokens. That is not missing support: pi-ai
    adds `cache_control` by default. The likely cause, unverified, is that
    these prompts (~2.6-3.5k tokens) are under the minimum Anthropic
    caches for Haiku 4.5, which I believe is 4,096 tokens.

**Process slips worth remembering.**
- My exact-edit helper reindents the first line of a replacement, which
  broke Python twice. `check.sh` now compiles the Harbor agent.
- `podman pull` once printed a Canva SSO "Opening browser" prompt. Later
  pulls didn't.

## 2026-09-23: Codex's fifth review

The fifth review covered the fourth round's fixes, the desktop app and the
headless path. It found 13 issues, 4 of them high, and judged the widget
sandbox, observer attach, sandbox-off gating and CA fallback sound.

The high findings:
- **Cross-session bridge:** the window could act on any session by id.
  Reproduced, then fixed.
- **Widget WebRTC:** STUN packets reached a real UDP listener before the
  fix.
  - The only layer that worked here was removing WebRTC before the
    widget's code runs.
  - A WebRTC IP policy, a dead proxy and the CSP `webrtc` directive each
    failed alone.
  - The `about:blank` bypass doesn't apply: the widget's origin is
    opaque, so a child frame is cross-origin.
- **git outliving a forced exit:** checkpoint git now runs in tracked
  process groups.
- **MCP termination:** accepted as far as the kernel allows. A 10s wait
  follows the kill, and a process that still hasn't exited is logged.

The rest:
- **Fixed with a failing-first test:**
  - absurd MCP request ids;
  - a host dying mid-turn leaving `strive run` waiting;
  - `propose_layout` replaying as "did not run";
  - decided proposals lost across windows.
- **Fixed structurally:**
  - early Ctrl+C is re-sent once the turn starts;
  - desktop startup events are buffered.
  The startup-gap test I wrote passed on the old code, so I dropped it.
- **Harbor:** exit status propagates, with the turn's reason (tried with a
  bad key), and accounting counts cached input.
- **Documented:** what `"sandbox": "off"` doesn't protect inside the
  container; the silent-cancel stop policy.

## Stop-gate review after round 5

Three findings, all fixed:
- **WebRTC from nested frames:**
  - The widget page's `NO_WEBRTC` prelude doesn't reach a nested `srcdoc` frame.
    A per-path probe (direct, `about:blank` child, nested srcdoc) showed the nested one leaking.
  - The window's `setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` stops all three
    by itself (3 runs). It is now the primary layer, and the prelude is a second one.
- **Host cleanup racing queued host records:**
  - Ending an open turn used to read the journal from disk, and could miss a
    `turnStarted` still queued to the session actor.
  - The connection now counts records in flight and waits for them (up to 10s).
    The actor then ends the turn from its own entries (`Cmd::EndOpenTurn`).
  - The new host test didn't reproduce the race on the old code in 60 runs, so
    it stays as a guard only.
- **Concurrent saves erasing decisions:**
  - A read-merge-write isn't atomic across app processes. A test with 6 processes
    × 25 saves lost 100–125 of the 150 decisions on the old code, every run.
  - Each decision is now also a marker file in `decided/`, which is never
    rewritten or removed, so no interleaving of saves can undo one.
  - The layout itself is still whoever saved last.

Stop-gate review of `c29c796`:
- **TURN over TCP still got out:**
  - `disable_non_proxied_udp` still allows TCP. The probe now gives each path a
    TURN/TCP server as well, and the nested srcdoc frame reached it.
  - Fix: main runs a loopback proxy that closes every connection, and points
    the session at it with `<-loopback>`, so loopback isn't exempt.
  - WebRTC's TCP now has only that proxy to go through. 3/3 runs pass.
- **A failed save hid proposals:** decision markers were written before the
  layout, so a failed layout write left an accepted proposal decided but
  without its edit. The layout is now written first. A test injects the failure.
- **Test hygiene:** a failed e2e test left its Electron app and sockets open,
  so `node --test` never exited, and a dozen stale runners had piled up. Apps
  now close in `afterEach`, and the probe closes its listeners in `finally`.

Stop-gate review of `884a994`:
- **The problem:** if a decision's file failed to write after the layout
  landed, the decision existed only in the layout. The next save from a stale
  window merged only decision files, so it dropped the decision.
- **The fix:** every save first gives each decision in the on-disk layout a
  file, repairing an earlier partial save, before it replaces the layout. If
  that repair fails, the save stops. A test injects the failed write and then
  saves from a stale window.
- **What's left:** the failure has to line up with another process's save that
  read the layout before this one's rename. That needs a cross-process lock,
  which isn't worth adding for a UI preference file.

## 2026-09-23: Desktop redesign

The window was a flat log with raw markdown and a per-call cost line after
every model call. It's now modeled on Zeron (`zeronsh/comet`).
- **The transcript** is folded from the journal (`renderer/conversation.ts`),
  not from the TUI's text lines:
  - prompts are bubbles, and replies are markdown (`markdown.ts`, parsed into
    React elements, never HTML);
  - each step's tools collapse into one line ("Ran 1 command · read 1 file")
    that opens into rows with command output and line diffs for edits;
  - approvals are answered inline, where the agent asked; the approvals panel
    lists what's waiting when the conversation is on screen;
  - each turn ends with "Worked for 4.2s · $0.0188".
- **Chrome:** the titlebar is merged into the window on macOS, the composer is
  a floating card with the approval mode and the model inside it, and the
  palette is dark with a violet tint.
- **Scoped `blob/get`:** tool output comes from the content store, which is
  shared by all sessions and addressed by digest alone. The window gets a
  `blob` bridge call that main allows only for digests named in its own
  session's journal. A new e2e test reads its own session's blob and is
  refused another session's; it fails with the check removed.
- Screenshots came from a scripted session with the real host and a fake
  model (harness in /tmp/strive-shot, not committed).

## 2026-09-23: Final Stage 1 review, all areas

Codex (GPT-6 Astra) reviewed Stage 1 in five areas. Its boundary review
was refused twice by OpenAI's cybersecurity filter, so fresh Opus
subagents covered the boundary, plus money and the journal again.
Other second opinions were unavailable:
- GPT-6 Sol and Luna via opencode: blocked by a gateway after a few
  requests;
- Fable 5.1: needs data retention enabled.

Reports are in /tmp/strive-review/out. Where two reviewers overlapped,
they agreed: the symlinked AGENTS.md, keys in the host's environment,
cache_control, remote inputs, the premium tier, and cleanup ending the
wrong turn.

**Fixed, each with a test that fails first unless noted:**
- **Data:**
  - parallel edits of one file were lost; edits and writes now take the file
  - a rewind deleted a nested repository whose directory an older
    checkpoint had saved
  - accepting a proposal before the saved layout loaded overwrote it (untested)
  - a reloaded desktop window lost everything since launch
- **Money:**
  - `cache_control` in an OpenAI tool schema held $0
  - fetched or kept inputs (URLs, file ids, `item_reference`, stored
    prompts) are refused
  - a priority tier or a `context-1m` beta is refused
  - a final stream delta repriced one-hour cache writes as five-minute ones
  - a stream's last event is held back until the call's end is journaled
- **Boundary:**
  - hosts got the daemon's keys in their environment
  - a symlinked AGENTS.md put credentials in the prompt
  - a FIFO skill file blocked registration
  - a session directory swapped for a symlink was followed
  - the macOS sandbox profile could be injected through a path
  - the app now resolves no names (the TURN DNS leak: source-traced, untested)
- **Lifecycle:**
  - turn records are checked against the journal
  - cleanup ends only the departing host's own turn
  - a read error (invalid UTF-8) skipped cleanup
  - summarizing was outside the turn, with no limit and no interrupt
- **Display:** the TUI ran control sequences from replies; a bad
  assistant record crashed every later host's replay.
- **Flaky tests explained:**
  - A child forked while its command was being killed escaped the kill.
    The fix is a real one: the group is killed again after reaping.
  - Two fixtures raced: the UTF-8 host test's requests, and the fake MCP
    server's absurd id.

**Deferred, with why:**
- **Writer recovery after a failed journal write:**
  - it records running effects as interrupted
  - it drops subscribers
  Both need a disk failure. The fix is to fail those connections rather
  than resume quietly.
- **Journal edits:** a torn tail appended by another process while live.
  That needs an external edit.
- **Daemon lifecycle:**
  - idle exit ignores running effects
  - its timestamp isn't reset when the last person leaves a host behind
  - the launcher handshake has no timeout
  - `strive stop` gives up before a slow stand-down finishes
  - stopping doesn't wait for model calls in flight, so they're charged
    their full hold
  All real, all P2. They belong together in one lifecycle pass.
- **Commands outliving their owner:**
  - a command whose host disconnects keeps running after its turn ends
  - on macOS, a command outlives a SIGKILLed daemon
  The first needs effects tied to their host's connection. The second has
  no `--die-with-parent` equivalent in Seatbelt.
- **"Allow for this session":**
  - It still means full-auto; the buttons now say so.
  - Per-command and per-tool rules are a design change.
- **Minor (P3):**
  - reused tool-call ids across turns (replay keys results by call id)
  - a reused callId's cancel flag
  - a non-integer `n`
  - the output cap is forwarded unclamped
  - a failed response store still reports the call complete
  - `GetMode` and `CheckBudget` answer from staged state

## 2026-09-23: Zeron, hands on, and UI libraries

- **Zeron, installed and used:**
  - Zeron (github.com/zeronsh/comet) v0.2.84, the notarized macOS app, ran
    from /tmp and was driven with CGEvent clicks and its own `zeron mcp`
    server.
  - Screenshots are in /tmp/zeron-shots/live.
- **Zeron's code, studied** (/tmp/zeron-study.md):
  - The UI talks to its engine over a localhost JSON WebSocket.
  - It drives Claude through stream-json, Codex through app-server, and
    others through ACP.
  - Its default theme is near-black neutral with a `#8b7cf6` accent.
  - It has no approvals, costs, exit codes or rewind, where strive is ahead.
- **Worth taking, in order:**
  1. stick-to-bottom with a jump pill
  2. a working trailer with elapsed time, and tool groups that open while
     live and close after
  3. code blocks with copy and highlighting
  4. a session sidebar with status dots and titles
  5. a turn or branch diff pane with comments
  6. a message queue while working
  7. a ⌘K palette
  8. attachments and `@` mentions
  9. a prompt rail
  10. notifications
- **Libraries** (/tmp/ui-libraries-study.md):
  - Adopt: use-stick-to-bottom, Shiki (JavaScript regex engine, since our
    CSP blocks WASM), cmdk and remend.
  - Adapt from: Meta's Astryx (`facebook/astryx`: CSP-clean chat
    components) and AI Elements (structure only; it needs Tailwind and the
    AI SDK).
  - Skip: Streamdown (Tailwind, and it parses model HTML) and assistant-ui.

## 2026-09-23: Desktop pass 2

Built from the Zeron study and the library survey, in five commits:
- **Scrolling and the trailer:**
  - use-stick-to-bottom, with a "Jump to latest" pill.
  - A trailer says what the agent is doing (working, writing, waiting for
    you) and for how long.
- **Tool groups:** open while live, closed once the agent moves on, unless
  clicked. Failures are counted in the summary line.
- **Code:**
  - Shiki highlighting with the JavaScript regex engine, since the CSP
    blocks WASM. An e2e test checks the colours in the real window.
  - Code blocks have Copy; streamed markdown is repaired with remend.
  - The palette is near-black neutral.
- **Sessions sidebar:**
  - `session/list` now reports a title and last activity.
  - Switching opens a new connection and closes the old one, so the
    session left behind stops counting the window as a person.
  - A test fails if the old connection stays open.
- **Changes pane (⌘D):**
  - `session/changes` compares a checkpoint with the live tree, staged
    into a temporary index so the checkpoints are untouched.
  - The pane shows highlighted diffs with line numbers, and takes the side
    panels' place while open.
- **⌘K palette (cmdk):** actions, the approval mode, rewinds and sessions.
- **Smaller pieces:**
  - notifications when the window is unfocused
  - a prompt rail
  - long prompts fold
  - Copy on replies
  - workspace paths shown relative to it

A real Haiku run through the app fixed the demo bug in 12.9s for $0.0334.
The streaming, trailer and highlighting looked right.

A correction: `a_cancelled_command_is_stopped`'s child now waits for a
go-file instead of sleeping 1s. Under load the test could take over a
second to cancel, so the child wrote its marker legitimately. That is the
likelier cause of its earlier failures, not only the fork race; the group
re-kill stays anyway. A mutant that removes the freeze and the group kills
fails the test.

**Not built yet, from Zeron's list:**
- **Attachments and `@` mentions:** these need a workspace file-search
  method and image input.
- **A queue of prompts sent while working:** prompts journaled mid-turn
  already wait for the next turn, but there's no queue UI. The journal
  can't un-send one.
- **A context-usage ring:** needs the context window in the renderer.
- **Bundled Geist fonts.**

## 2026-09-23: M8, the learner (host side)

- **Shape:** `host.ts` keeps the turn machinery (queue, turn records,
  interrupts, time limit, compaction, resume) and takes an `AgentMode`:
  a system prompt, tools, a summary prompt, and hooks. `kind: learning`
  picks `learnerMode` (`learner.ts`). The gateway model setup moved to
  `gateway.ts`, shared by both.
- **Prompts:** `learnRequested` is a turn prompt like `userMessage`. Its
  text names the previous request's time ("active since …"), so
  `PromptReader` reads entries in journal order, live and on resume.
- **Resume:** the host can journal only turns, replies and proposals, so
  the read tools' output isn't in the journal. On resume their calls get
  "this output isn't kept; call it again", and a `propose_change` with
  no `proposalMade` gets "nothing was recorded". A recorded proposal
  replays as its id plus the journaled static gate, so a resumed learner
  sees what a live one saw (unless the gate landed after the live 5s
  wait).
- **A race the tests caught:** a reply's tool calls run in parallel, so
  the three-a-run limit must be counted before `host/record` is awaited,
  not after. Counted after, four proposals in one reply recorded four.
- **Paging:** an effect's start and result are separate blocks. Merged,
  a page break between them showed the result twice.
- **Gap:** the daemon gives the learner a skill's name, description and
  path, not its text (`AgentConfig.skills`, `contextLoaded.skills`).
  Reading the file would be a file effect. `read_artifact` says so, and
  the prompt says not to propose changes to a skill it can't see. M7
  could send skill texts in a learning session's `AgentConfig`.
- **Needs M7 to be real:** `host/register` returning `kind: learning`,
  `host/record` accepting `proposalMade`, the static gate's
  `gateFinished`, and `.strive/memory.md` among `instructions`. The
  tests play these with `FakeDaemon`; `FakeDaemon.push` sends a
  notification outside any reply (interrupts, late entries).

## 2026-09-23: M7, proposals in the daemon

Built against ADR-0016. The learner (M8) is another agent's work; here
the tests act as it, registering over RPC and recording `proposalMade`.

- **Choices:**
  - Learning sessions are left out of `session/list` unless it asks for
    `kind: learning`. `strive sessions`, continue and the desktop's
    sidebar never show them. `strive verify --all` asks for both.
  - A project's learning session is the oldest one for its real path.
    `learning/open` finds or creates it under one lock.
  - `learning/run` is people only, like approvals. A prompt, an effect or
    an MCP tool in a learning session is refused.
  - The gate's pure parts are a library crate, `strive-learning`, so
    mutation testing covers them. The daemon adds the path on disk and
    the evidence.
  - `before` is the file as the learner was shown it, not as it is when
    the proposal lands. The learner's `host/register` gets its memory and
    skills whole (`learnedFiles`), and `contextLoaded.learned` journals
    their digests. A file edited while the learner worked is never
    written over.
  - A stale accept still returns ok: it journals the decision, and the
    status says stale. `strive review ID accept` exits 1 and says so.
- **Protocol additions** (all optional fields):
  - `SessionListParams.kind`
  - `ProposalMade.before` and `ProposalState.before`
  - `AgentConfig.learnedFiles`, with `LearnedFile`
  - `ContextLoaded.learned`
- **Tests:**
  - `crates/strived/tests/learning.rs` runs against the real daemon, one
    test per rule and refusal.
  - `crates/learning/tests` covers the text checks and the fold.
  - A crash between a proposal and its gates is built with
    `strive_journal` directly: the journal such a crash leaves. The next
    `proposal/list` runs the missing gates.
- **A race in two gateway tests, explained and fixed:** the
  client-leaves tests gave up on their request after a fixed 300 ms. With
  the suite under more load (this milestone adds a few dozen daemons), the
  request could still be on its way, so no call started and there was
  nothing to close. They now leave once `modelCallStarted` is journaled.
- **Known limits:**
  - A command a work session runs can change the file between the
    compare and the write. Agent writes and edits can't: they wait.
  - The weakening phrases are a list. They catch plain instructions, not
    paraphrases. The judge (M9) is where meaning gets checked.
- **Worktree note:** this worktree's path is long enough that sockets
  under `CARGO_TARGET_TMPDIR` pass macOS's 104-byte limit
  (`the_sandbox_blocks_unix_sockets_outside_it`). `check.sh` ran with
  `CARGO_TARGET_DIR=/tmp/m7t`, with `target` symlinked there for the TS
  tests.

## 2026-09-23: Desktop pass 3, the conversation first

Used first: scripted sessions against a fake model at 1280, 1000, 860 and
720 px, with the palette, changes pane, expanded tools and a waiting
approval, a session with no key, and a real Haiku run. Harnesses and shots
are in /tmp/ui-shot (not committed; before/ and after/).
- **What was wrong:**
  - The side column took a third of the window and repeated the
    conversation.
  - At 860 px the changes pane was drawn over the conversation without
    hiding it.
  - The model chip wrapped at narrow widths and couldn't pick anything.
  - The conversation's drag handle floated over the first line of text.
  - A missing key showed up only as raw provider JSON after a prompt.
- **Layout:**
  - The default workspace places only the transcript. The other panels
    exist but aren't placed, so drags and agent proposals keep working.
  - ⌘K shows or hides each panel, and shown panels have a hide button.
  - Spend is a meter in the composer's footer. Each prompt offers Rewind on
    hover, which asks first.
  - A saved layout carries its own base, so people who saved one keep it.
- **Model picker:** `model/list` and `session/model` (journaled as
  `modelSet`, used by host registration).
  - The model can be chosen only before the first prompt, since a host may
    start on it then. After that the picker says switching mid-session
    isn't supported and offers a new session.
  - The real Haiku run picked Haiku over a Sonnet default through the chip:
    12.2s, $0.0286.
- **Onboarding:** the empty state says where the agent works, what the
  approval mode lets it do, the budget and how to undo.
  - With no key for the model it gives the `strive auth` command, and the
    window checks again on focus.
  - Failed turns read the provider's message instead of its JSON.
- **Narrow windows:** below 900 px the sidebar opens over the conversation.
  Container queries size the pane, side panels and rail by the space they
  actually have.
- **Look:** Geist and Geist Mono, vendored as two variable woff2 files
  (140 KB) with the OFL. The `geist` npm package pulls in Next.js as a
  peer.
  - Also: one token set with radii by role, focus rings, and short
    ease-out motion that is off under reduced motion.
- **Packaging:** `electron-builder --dir` (install.sh's step) builds a
  working app. The packaged binary ran a fake-model session with both fonts
  loaded from the asar.
- **Environment traps:**
  - This worktree's path is long enough that
    `the_sandbox_blocks_unix_sockets_outside_it` hits `SUN_LEN`.
    `CARGO_TARGET_DIR=/tmp/ui-target` (with `target` symlinked there) fixes
    it. `env!` bakes the old path in, so touch the tests to rebuild.
  - Two one-off failures in the gate were
    `a_client_that_leaves_while_the_provider_stalls_closes_the_call` and a
    `WouldBlock` (5 s read timeout) in `a_started_host_gets_no_provider_keys`.
    The first didn't reproduce in 40 reruns under load, and other agents
    were running strive suites on the machine at the time. It gives the request
    300 ms to reach the gateway before dropping it. Under IO load that may
    not be enough, so nothing is journaled to close. That's a guess, not
    shown.
  - A panicking test can leave its daemon running. Two were stopped by PID.
- **Not done:**
  - Switching models mid-session: the host would have to re-register.
  - A sticky model choice for new sessions.
  - Setting a key from the window: `auth/set` stays off the bridge, so a
    compromised renderer can't swap the user's key.
  - A checkpoint timeline in the changes pane: rewind lives on prompts and
    in ⌘K.
  - Light theme.

## 2026-09-24: Stage 2's loop on a real model

The three branches merged cleanly after conflict resolution:
- M8, the learner (`babac84`);
- M7, the daemon side (`0fda53e`);
- desktop pass 3 (six commits).

The learner reads memory and skills from `learnedFiles`, exactly as on
disk. Sessions see memory under a "Reviewed memory" label, and that label
must not end up inside a proposal.

**Real run (Haiku 4.5, CLI only, about $0.06).** The setup: a repo whose
root holds deliberately failing example tests (`fixtures/`), where the
real suite is `bun test src`.
1. The first session ran `bun test` at the root and hit the failing
   fixture.
2. In the second, the user corrected it.
3. `strive learn` proposed one memory rule, citing entries in both
   sessions, with the prediction that future sessions run `bun test src`
   first. The static check passed, and it cost about $0.02.
4. `strive review 16` showed it; `accept` wrote `.strive/memory.md`.
5. A third session, given the first one's prompt, ran `bun test src` first
   and said it did so because of the project memory. The prediction held.

**One flaw.** The learner told the two sessions' story in the wrong order,
even though `list_sessions` said "newest first". The list is now in the
order the sessions started, numbered, with a test.

**Two more flaky tests.**
- `a_client_that_leaves_while_the_provider_stalls` failed under load. A
  client gone before the headers are sent is noticed only at the next
  write, and the fake provider wrote nothing for 20s. It now pings, as
  real providers do.
- The TUI's `/rewind` test is reported to fail about 1 in 5 runs. It's
  still to be looked into.
