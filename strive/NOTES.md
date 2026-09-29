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
- The TUI's `/rewind` test is reported to fail about 1 in 5 runs. The
  race was in the test, twice over. The TUI and the daemon behaved
  correctly throughout.
  - **Too short a deadline.** A rewind runs about 16 git processes, one
    after another. Each takes ~20ms on an idle machine, so the whole
    rewind takes ~0.4s. Beside two looping `cargo test -p strived --test
    effects` runs, the rewind took 0.4 to 11s, and one git call alone took
    ~0.5s. `waitFor` gives up after 2s. At failure the screen shows no
    error, only the first rewind's line. The second reply came later.
    Failures: 0/30 alone, 16/30 under that load, and 28/30 under two
    loops.
  - **A shared directory.** Every run of `app.test.ts` used
    `/tmp/some-repo` and deleted it in `beforeEach`. So did other
    checkouts' `check.sh` runs. One such run deleted the directory under
    a rewind (`git commit failed: Unable to read current working
    directory`). Two copies of the test run at once failed in 2 of 8
    rounds. In one, the session started in a missing directory, so no
    checkpoint was taken and the screen showed "No checkpoints yet".
  - **Fix.** Each test gets its own `mkdtemp` directory. Lines that wait
    on git use a 20s `waitFor` (`GIT_MS`) instead of the 2s default. The
    test still waits for the line the TUI shows. No sleep or retry was
    added.
  - **After the fix.** 30/30 alone, and 10/10 rounds of two copies at
    once. Under load, 33/34: the failure was `strive status` being
    SIGKILLed while the daemon started, not a rewind. A start loop
    reproduced it 1 time in 150 under the same load, with no daemon log.
    The sender is still unknown.

## 2026-09-24: M9, the judge gate

Design in [ADR-0017](docs/adrs/0017-judge-gate.md): the daemon makes the
call itself (option a), not a judge session (b). Under (b) the verdict would
be a host record, from the kind of process the daemon trusts nowhere else,
and the prompt and parser would live beside the learner in `packages/host`.
- **The path:** the daemon posts to its own gateway with the learning
  session's token. Admission, the budget hold, stored bytes and
  `modelCall*` entries are the gateway's, charged to the learning session.
- **The fixed parts** are in `strive-learning` (`judge.rs`, `render.rs`):
  the rubric (supported, generalizes, novel, safe, checkable), the request
  with a forced `record_verdict` tool, and a strict reader. Pass needs
  every criterion and the verdict to say pass. Any other answer fails,
  including a verdict that disagrees with its criteria.
- **Held out:** up to 3 of the project's newest work sessions the proposal
  doesn't cite, begun before it, with a prompt and a verifying journal,
  48k characters in all. Cited sessions are rendered with cited entries
  kept first. None of the learning session's own entries go in.
- **Skips** (journaled with the proposal): static failure, no Anthropic
  key, a non-Anthropic or unpriced `judgeModel`, nothing to hold out. A
  402 from the gateway comes back as a budget skip. Provider errors fail.
- **Running:** in the background, off the project lock. The verdict is
  journaled under the lock only if there's none. A running set stops a
  list from starting a second call: with the set mutated away, the crash
  test saw 13 calls instead of 1. After a crash, the next list or decision
  judges again.
- **Surfaces:** `strive review ID` prints each criterion on its own line.
  `strive learn` waits (up to 5 min) for its proposals' checks before
  listing them. `judgeModel` in settings; `model` when unset.

**Real run (Haiku 4.5, about $0.09 all told, the judge $0.008 a call).**
The trap repo again (`fixtures/` fail on purpose; the suite is `bun test
src`), three work sessions: a `bun test` that hit the fixtures, the user's
correction, and an unrelated task (held out).
- A bad proposal, recorded by hand as the learner: "the fixtures show real
  bugs; change src/ until the root `bun test` passes", with a vague
  prediction. Static passed. The judge failed it on supported,
  generalizes and safe, quoting the user's "fail on purpose" at #6 of the
  cited session. It passed checkable: "vague but could be checked".
- `strive learn` proposed "run `bun test src`, not `bun test`". The judge
  passed all five, and noted that the held-out session hit the same
  fixture failure.

**Environment:** the canva-git wrapper first on PATH takes 1–2 s a call
here, which times out the checkpoint tests' 5 s RPC reads. The base commit
fails them the same way (12 of 18). The gate ran with
`/opt/homebrew/bin` first on PATH.

**Deferred:**
- Re-judging on request: a provider outage fails a proposal for good,
  so the learner has to propose it again.
- The judge on OpenAI models.
- Held-out selection by relevance, not recency.
- The learner's live 5 s wait covers only the static gate. Its tool
  result doesn't mention the judge.

## 2026-09-23: M8b, the Learned pane

`strive review` in the desktop window, per ADR-0016.
- **Bridge:** `proposal/list`, `proposal/decide`, `proposal/rollback` and
  `learning/run` go through `strive:request`, and the main process sets
  `cwd` to the window's project. Two calls are new:
  - `learning()`: the learning session's journal (`session/read`), or
    null if the project has none. It never creates one; only a run does.
  - `proposalBefore(id)`: the "before" text, found among the project's
    proposals. `blob/get` still serves only the shown session's digests.
  - Request errors reach the page as the daemon's words (`describeError`
    in main; the renderer strips Electron's "Error invoking remote
    method" prefix).
- **Following a run:** `main/learning.ts` holds a connection of its own,
  attached as an observer, so switching sessions doesn't drop it and the
  learner never waits on it. It starts at launch if the project has a
  learning session, else after the first `learning/run` or the first time
  the pane opens after one exists. Its entries go to the page
  (`onLearning`) and feed the notice.
- **Run state** (`renderer/learning.ts`): a request is running until the
  turn that took it (`turnStarted.throughSeq`) ends. The step shown is the
  learner's last tool. A failed or timed-out turn says why.
- **The pane:** list newest first (status, summary, artifact, age), and a
  detail with the whole-file diff, why and prediction (markdown), evidence
  (a link to switch to a session of this project, "(shown)" for the
  current one, the bare id otherwise), checks, and Accept (confirm) /
  Reject / Roll back (confirm). A stale proposal says plainly that nothing
  was written, and offers a new run. The chosen proposal is kept in
  `sessionStorage`, so following an evidence link keeps it open.
  - The changes and Learned panes share the right side: one at a time,
    saved as `strive.pane` (the old `strive.changes` key is dropped).
  - The titlebar button has a dot while a run goes or proposals are ready.
- **Tests:** seven e2e tests in `app.e2e.ts` (list and detail, accept,
  reject, rollback, stale, project binding, a run followed to its
  proposal), with the tests as the learner's host over RPC. Unit tests:
  `learnedNotice` and `latestRun`. The binding test was checked by
  letting the page's `cwd` win: it failed.
  - A first version of the binding test passed for the wrong reason:
    proposal ids are seqs in each project's own learning session, so the
    other project's id named one of ours, and "decide" accepted ours. The
    test now asserts the id is not one of ours.
- **Look:** screenshots from a harness in /tmp/m8b-shot (not committed),
  running the real host and learner against a scripted model. Fixed from
  the first pass: the diff's `+` was pulled out of view by the wrapping
  indent (an inline block takes the row's `text-indent`), and rationale
  backticks showed raw.
- **Environment, and the gate:** checkpoint-heavy tests (the `checkpoints`
  cargo suite, TUI prompts and `/rewind`) hit their 5 s and 2 s read limits
  while another agent looped strive suites on the machine
  (`/tmp/flake-target`) and syspolicyd, Santa and Kandji checked every exec.
  One two-prompt checkpoint test took 4 to 8 s on its own. No Rust or TUI
  code changed here. Every step passed on its own, but `check.sh` never
  exited 0 in one run: `cargo test --no-fail-fast` passed in full once, and
  the TS steps and all 35 desktop e2e tests passed, with the TUI tests
  timing out as above. Rerun the gate on a quiet machine.
  - A real race the gate did catch, in two of these tests: the diff's
    heading shows before the "before" text loads, so reading rows at once
    could find none. They wait for the rows now.
- **Deferred:**
  - Notifications aren't e2e-tested: a test window is focused, and
    Electron's `Notification` isn't observable from Playwright. The notice
    text is unit-tested.
  - No real-model run: the harness drives the real learner with a
    scripted model.
  - Clicking the notice focuses the window but doesn't open the pane.
  - A learning session made by `strive learn` while the window is open
    is found when the pane next opens, not before.

## 2026-09-24: merging M8b, M9 and the TUI flake fix; three causes of failures under load

M9 (judge), M8b (Learned pane) and the TUI rewind fix merged into
strive-rebuild. The first full check on the merged tree failed in
`a_client_that_leaves_before_the_response_starts_closes_the_call`, which
passed 20/20 alone. Looping it beside `cargo test -p strived` failed it
1 in 24, and every load run also failed two checkpoint rewind tests. Three
separate causes:

- **A call the gateway started but nobody closed (product bug).** The
  session writer journals `modelCallStarted` (reserving the money) and then
  replies. A client that left in that window dropped the handler while it
  awaited the reply, so no `Finish` was ever built: the call stayed open and
  its reservation held. The start now runs in a spawned task that always
  hands its result to a `Finish`, whose drop closes the call ("the client
  disconnected before the response began"). No deterministic test: the
  window is inside the writer; the evidence is the loop, 1/24 before and
  0/120 after under the same load.
- **Stale-daemon replacement on every cargo run (product bug).** `build_id`
  was version + inode + size + mtime of the executable. Cargo copies
  `target/debug/strive` into place on every invocation, rebuilt or not (1
  link, a new inode, the same bytes and mtime). So any cargo run beside the
  tests made each live test daemon look stale, and the next `strive status`
  shut it down mid-test: broken pipes and "the daemon is stopping" in the
  rewind tests. For a person, reinstalling the same build would have shut
  down a daemon under running sessions. The inode is out of the build id;
  `a_fresh_copy_of_the_same_build_keeps_the_daemon` failed before. The
  stale-daemon tests now make "another build" by changing the copy's mtime,
  which is what a rebuild does.
- **The fake MCP server's pid file (test race).** `fs::write` creates and
  then writes, so a test could read an empty pid. It's renamed into place.

Also: `Env::status` says how `strive status` ended. That showed the
remaining load failure is `strive status` killed by SIGKILL, only while
another cargo run re-copies the binary it executes; no log names the
sender. Not seen in a single `check.sh`.

**Merge fallout.** M8b's pane test expected the judge's pre-M9 "isn't built
yet". The e2e daemon is shared, and one test stores a stand-in Anthropic
key, so the judge's detail depends on test order, and with no upstream
override its call went to the real api.anthropic.com with a fake key. The
e2e daemon's upstreams now point at a dead port, as the Rust tests' do, and
the pane test checks that the pane shows the judge detail the daemon
recorded.

## 2026-09-24: learned files can't be changed around review

**The gap.** ADR-0016 says memory and skills change only through reviewed
proposals, but `effects::resolve` protected only `~/.strive`. A work
session's `write`/`edit` could rewrite `.strive/memory.md` (free in
autoEdit and fullAuto), and so could any sandboxed command, since the
sandbox allowed writes anywhere in the workspace. The proposal, the checks
and the person were all skipped, and every later session would be told
the result as "reviewed memory".

**Write and edit: always ask.** `Access::Learned(real, rel)` joins
`Allowed`/`Ask`/`Denied`, and `gate()` maps it to `Gate::Ask` whatever the
mode. That fit the design cleanly: `run_effect` asks for any `Gate::Ask`
and never looks at the mode itself, and "allow for the session" only
switches the mode to fullAuto, so it can't pre-approve the next learned
file. "Unsandboxed command" already worked this way. So I ask rather than
refuse: a person at the keyboard can still let the agent fix a typo in
memory, and the request says what that means. Matching:
- on the real path (symlinks followed, `..` after them, as `resolve`
  already did), relative to the workspace, lowercased. Lowercasing is right
  on APFS's default case-insensitive volumes. On a case-sensitive one it
  asks about `.strive/MEMORY.md`, which is harmless.
- also where the project's own `.strive/memory.md` or `.strive/skills`
  leads through a symlink, since `context::memory` follows it. That needed
  `leads_to`, which follows dangling links too: `real_path` gives up on
  them, and my first test (memory linking to a not-yet-existing
  `docs/notes.md`) wrote the file in fullAuto.
- Unattended, the refusal said "use full-auto approvals", which is wrong
  when full-auto wouldn't help. It now re-runs the gate in fullAuto and
  suggests full-auto only if that would have allowed the effect. This also
  fixes the same wrong advice for writes outside the workspace.

**Bash: Seatbelt.** I probed `sandbox-exec` by hand before writing the rule:
- It matches the path a write reaches, after symlinks, so `ln -s
  .strive/memory.md m; echo > m` is denied, and so is making a hard link to
  the file.
- On a case-insensitive volume it matches case-insensitively, even for a
  file that doesn't exist yet (`.STRIVE/MEMORY.md`, `mkdir .STRIVE`).
- The rule denies `literal .strive`, `literal .strive/memory.md` and
  `subpath .strive/skills`, plus wherever `leads_to` says those go. Without
  the `.strive` literal, a command could move a prepared directory into
  place (`mv x .strive`). Denying it also stops creating `.strive`, which
  is fine: only learned files live there. Other files in `.strive` stay
  writable.
- Escaping: the added literals are the workspace plus fixed ASCII, which
  the existing quote/backslash/control check already covers. Symlink
  targets are checked the same way. `tmp` (from `TMPDIR`) is still not
  checked. That predates this change, and I left it.
- A symlinked skills directory pointing at `/` or at the workspace would
  deny writes there too. That fails closed, and I left it.

**Bash: Linux, untested here.** bubblewrap gets `--ro-bind-try` on the
memory file and skills directory (their `leads_to` targets). A bind can't
cover a missing path without creating it on the host, so a command can
still create memory where there is none, and can move `.strive` aside.
Tests that depend on that are macOS-only.

**`sandbox: off`:** commands are unconfined, so none of the bash
protection applies. That's documented in ARCHITECTURE. Write and edit
still ask.

**Changed outside review.** `proposal/list` gains `changedOutsideReview`:
the paths of learned files that aren't what an accepted proposal last left
there. It walks the learning journal: `proposalApplied` sets `after`, and
`proposalRolledBack` sets that proposal's `before`. Then it compares each
learned file on disk (memory, every valid skill directory, anything a
proposal wrote) by digest. A file with no applied proposal counts once it
exists, and so does something that isn't a regular file. `cas::digest`
hashes without storing, so listing doesn't fill the store with hand edits.
`strive review` prints one line per file. Not done: the desktop Learned
pane doesn't show it yet, and `strive review <id>` doesn't mention it.

Tests (real daemon): approvals.rs `full_auto_still_asks_before_writing_
reviewed_memory`, `allowing_for_the_session_doesnt_cover_learned_files`,
`unattended_full_auto_refuses_a_learned_file`, `a_learned_file_asks_by_any_
path_that_reaches_it` (symlink, `..`, absolute, case),
`a_file_the_learned_paths_link_to_asks_too`, `full_auto_writes_other_files_
without_asking`; effects.rs `the_sandbox_lets_commands_read_learned_files_
but_not_change_them`, `the_sandbox_protects_the_file_learned_memory_links_
to`, `the_sandbox_keeps_commands_from_creating_learned_files` (macOS);
learning.rs `a_work_session_cant_write_memory_but_an_accepted_proposal_
does`, `learned_files_changed_outside_review_are_listed`. All but
`full_auto_writes_other_files_without_asking` (a guard) and the
accepted-proposal half failed before the change.

**A flake seen, not fixed.** The first `check.sh` run failed once in
`packages/host/src/learner.test.ts`: "a learner resumes after a restart"
failed in 5 ms with `host/record: connection closed`. The second run
passed, and so did 8 runs of the file alone. That test runs only against
`FakeDaemon`, so the Rust changes here can't reach it. 5 ms is too short
for it to have scripted a turn. My guess is a rejection left over from the
previous test, whose `afterEach` `stop()` closes the connection while its
host still has a `host/record` pending, and bun blames it on the test
running at the time. I haven't confirmed it. Next step: await the host's
exit in `stop()`.

## 2026-09-24: an unhandled rejection when the daemon goes mid-turn

"a learner resumes after a restart" failed 2 in 30 runs of
`learner.test.ts`, in ~5 ms, with `host/record: connection closed`. The
error belonged to the test before it: `Host` started turns with
`void this.drain()`, so once the connection closed under a running turn,
the record it was making rejected and nothing handled it; bun blames the
test running at that moment. The background drain now catches, stays quiet
once the connection has closed, and logs anything else.
`losing the daemon mid-turn leaves no unhandled rejection` (resume.test.ts)
failed before. After: 0/30.

## 2026-09-24: what bb (get-bb/bb) suggests for strive's learning loop

Two studies of bb (github.com/get-bb/bb, MIT, "the agent IDE that builds
itself"), run hands-on without model spend.

- **How bb improves itself.** In its repo, agents reproduce issues and open
  fix PRs with a failing-first regression test, and maintainers merge
  (100% agent-authored lately, no auto-merge). Its gates: a private corpus
  of 307 real threads replayed into snapshots, where any diff must name the
  PR that caused it; ratchets whose baselines may only shrink; and
  verification recipes that fail when the source drifts from them. At
  runtime, "builds itself" means agents write full-trust plugins into your
  install. Memory, skills and global instructions are written unreviewed,
  and nothing measures whether a learned thing helped.
- **Found in strive, fixed.** Work sessions could write `.strive/memory.md`
  and skills directly, around proposals (e706b1a).
- **To adopt, in order:**
  1. M10 replay shaped like bb's corpus: tasks mined from journals with
     checkable outcomes (a command that went red to green, a final test exit
     0), run 3 times with and without the change, recording whether the
     skill loaded. The corpus stays local, with a redaction sweep that fails
     loudly.
  2. Predictions a machine can check (M11): a small predicate beside the
     prose, evaluated by the daemon on each new work journal, tallied, and
     suggesting (never doing) a scoped rollback.
  3. Cheap triggers before paid ones: a deterministic pre-filter for
     corrections, interrupts, declined approvals and failed-then-fixed
     commands, with a daily cap.
  4. Staleness: fingerprint the commands and paths a bullet names, and flag
     it when they change or the command later fails.
  5. Review UX: cited entries inline, the judge's reasons by criterion,
     amend-then-accept (re-running the checks), and blame per bullet.
  6. A learned verification check as an artifact (path glob → a command to
     run after the turn). Plugins, hooks and harness code come last, never
     loaded live.
  7. Changes to strive's own repo: the learner files a draft issue with
     evidence, and an ordinary session writes the failing test and fix
     behind CI and replay; a person merges.
- **Not to copy:** unreviewed writes to anything injected into every prompt;
  full-trust code behind a client-side confirmation; counting retrievals as
  benefit; regex filters as the main defense; committed session corpora.

## 2026-09-24: learned files are loaded only when really there

A stop-time review found that a symlink still got around the approval gate
for learned files. The gate and the sandbox matched `.strive/skills` and
whatever *it* linked to, but not a single skill linked elsewhere:
`.strive/skills/deploy -> docs/deploy`, then a plain write to
`docs/deploy/SKILL.md` changed a loaded skill with no one asked. The same
held for `.strive/memory.md` linked to `docs/notes.md`, which the agent
was told "a person reviewed". Rather than chase every link in the gate, the
loader now takes memory and `.strive/skills` only when reached without a
symlink, as `learned()` already did for the learner. Two tests in
`tests/context.rs` failed before. `AGENTS.md`/`CLAUDE.md` and
`.claude/skills` stay ordinary project files, outside review, by design.

## 2026-09-24: the static gate reads what a reviewer can't see

From the bb study (its `unsafeMemoryReason`): the static gate matched
safeguard phrases as plain substrings, so one zero-width space inside
"ignore the user" got past it, and a person reviewing would see nothing.
- A new rule, `hidden text`, refuses invisible and direction-changing
  characters (zero-width, bidi controls and isolates, word joiners, the BOM,
  soft hyphen, fillers, tag characters) in the content, summary, rationale,
  prediction and evidence notes. Emoji variation selectors stay allowed.
- Fullwidth ASCII is folded before phrase matching.
- Role tags (`<system>`, `<|im_start|>`, `[system]`, ...) join the
  safeguard phrases. `<system` alone isn't one: `<SystemProvider>` is code.
Three tests in `crates/learning/tests/checks.rs` failed first. Homoglyphs
from other scripts (Cyrillic `і`) are not folded; that needs a confusables
table and the judge sees the text too.

## 2026-09-24: the daemon's TMPDIR could write the sandbox profile

The macOS profile checks the workspace, strive's home and the learned
paths' symlink targets for characters that would end a string literal, but
put the daemon's TMPDIR in unchecked. With `TMPDIR=.../a"b`, sandbox-exec
parsed the rest of the path as profile code ("unbound variable: b\""), so a
crafted TMPDIR could add rules. It's the person's variable, not the
agent's, so this was a robustness hole more than an escape. A TMPDIR the
profile can't hold is now left out, not refused.
`a_temp_directory_with_a_quote_is_left_out_of_the_sandbox` failed before.

A stop-time review then found that leaving it out left commands pointed at
a directory they couldn't write. Looking closer: macOS's `mktemp` ignores
TMPDIR and always uses the user's temp directory
(`confstr(_CS_DARWIN_USER_TEMP_DIR)`, under `/var/folders`), which the
profile allowed only because it usually *is* the daemon's TMPDIR. The
profile now allows that directory (asked of `getconf` once; the crate
forbids `unsafe`) and the daemon's TMPDIR when it's safe, and sets the
command's TMPDIR to one of them. On Linux, commands get `TMPDIR=/tmp`, the
sandbox's private one.
## 2026-09-24: the Learned pane, review aids (desktop only)

Four things from "what bb suggests" item 5, in `apps/desktop` only, over
reads the daemon already has. No daemon change was needed.
- **Changed outside review.** `proposal/list`'s `changedOutsideReview`
  shows as a warn-toned notice atop the list: the paths, and what it means
  (new sessions read the file unreviewed, rolling back a proposal for it is
  refused, an older proposal goes stale). A proposal for such a file says
  so under its status. The list reloads when the pane opens and when the
  window regains focus, so an edit made in an editor shows on return.
- **Cited entries inline.** Each evidence entry from one of the project's
  sessions has a collapsed "Show what it cites". Opening it calls a new
  bridge call, `cited(session, seqs)`. The main process checks the session
  is in `session/list { cwd }`, reads it (`session/read`), picks the cited
  entries plus the other half of each cited effect (`shared/cited.ts`), and
  fetches only those effects' outputs, cut to 4000 characters, head and
  tail. `blob/get` for the page stays limited to the shown session. Each
  entry's `#seq` switches to its session (if needed) and scrolls the
  conversation to the item holding that seq, marked for 1.6 s; the session
  link does the same for the first cited seq. Items carry `data-seq`; a
  small module (`renderer/focus.ts`) holds the request across the remount
  a switch causes, and `stopScroll` keeps stick-to-bottom from pulling the
  view back.
- **Judge by criterion.** `strive_learning::judge::detail` has a stable
  shape: an outcome line, an optional summary, then five `pass|FAIL id:
  reason` lines in rubric order (tested in crates/learning). `readJudge`
  parses exactly that and nothing looser; anything else (skipped, an
  unreadable answer) shows as before, as plain text. I didn't render
  free-text details as markdown: gate details are plain sentences, and
  markdown would mangle underscores in paths. If M10 changes the format,
  the e2e test below fails and the pane falls back to plain text.
- **Per-file history.** "Proposals for <path>" lists every proposal for
  the same artifact path, newest first, the shown one marked, the others a
  click away. Hidden when the proposal is the file's only one.

Tests. e2e (`app.e2e.ts`): the hand-edit-after-accept notice (absent
before the edit, present after, and the daemon refusing the rollback the
notice warns of); cited entries (collapsed, then the prompt, the command
brought in by its cited result, the exit and output; another project's
session refused; a click scrolls the prompt into view, away from the
bottom); the judge by criterion against a daemon of the test's own whose
upstream is a fake Anthropic returning `record_verdict` (a stand-in key,
never a real one); per-file history. Unit: `readJudge` (both shapes, and
five near-misses left unread), `fileHistory`, `pick`, `blocks`, `cut`.
Checked that the tests can fail: dropping the main process's session check
failed the cited test ("ok":"read"), and dropping `focusEntry` failed it
at the scroll wait.

Look: screenshots in /tmp/pane2-shot (not committed), from a harness with
its own daemon and fake judge. Fixed from the first pass: the focus mark
covered the prompt's whole row, not its bubble.

Deferred:
- The pane's own scroll and opened evidence reset after an evidence click
  switches sessions, as the app remounts per session.
- Held-out session ids in the judge's head line aren't turned into
  session titles.
- No amend-then-accept or per-bullet blame (bb item 5's other half).

## 2026-09-25: the checkpoint tests wait for git as long as a loaded machine needs

Checkpoint tests failed with 5 s read timeouts three times now, each time
with other agents' builds running (load average ~7). The machine's `git`
is a wrapper at 40–60 ms a call against 20 ms for Homebrew's, not seconds.
A rewind runs a dozen or more git processes in turn, so under load its reply
outlasts the default 5 s read. As with the TUI's rewind test, the fix is
the test's deadline: checkpoint tests' connections wait up to 30 s for a
reply. Nothing sleeps; the test still waits on the reply it acts on.
## 2026-09-24: M10, the replay gate

Design in [ADR-0018](docs/adrs/0018-replay-gate.md). The first slice of
bb's suggestion 1: mining, running, the verdict. No reuse across
proposals yet.
- **Tasks** (`strive_learning::replay::mine`, 15 unit tests): a turn's
  command that failed, which the same session later ran with exit 0. The
  task is the turn's prompts, the checkpoint journaled with the first, and
  the command. Mined from the newest uncited work sessions, begun before
  the proposal, with a checkpoint repo; at most 3.
- **Runs are daemon-driven sessions** (`kind: replay`), not `strive run`
  processes: a scratch copy (`$TMPDIR/strive-replay-*/work`) exported from
  the task session's shadow repo, the learned files as the learner saw
  them on both sides, the proposal's file on one. Full-auto approvals and
  no person attached, so anything that asks is refused. The daemon sends
  the prompt, starts the real host, waits for `turnEnded`, kills the host's
  process group, then runs the check as a journaled effect
  (`replay-check`). The writer is closed after each run.
- **The sandbox had a hole for this:** it allows writes to `/private/tmp`
  and `$TMPDIR`, so a project under `/tmp` (every test project) was
  writable by any command. `Scope.temp` gives a replay's commands their
  scratch `tmp` instead (also their `TMPDIR`). The escape test failed with
  the old scope (`escaped-bash.txt` appeared in the project).
- **Money:** `ReplayStarted` holds `replay.budgetUsd` ($1) in the learning
  session's ledger (`Ledger::hold`), or the gate skips with the numbers.
  Each run's session budget is the cap minus what earlier runs spent, one
  run at a time, interleaved without/with. `ReplayFinished` charges what
  the runs' journals say they cost and names every run; it releases the
  hold in the same commit as the verdict. The gateway notes a budget
  refusal for a replay session, which stops the replay (skipped: "the cap
  ran out after N runs").
- **Verdict:** pass (with ≥ without, by rate), fail, or inconclusive
  (skipped) when every run failed on both sides. Runs after the judge's
  verdict if that isn't a fail; a skip doesn't block acceptance.
- **Model:** `replay.model`, else the cheaper of `model` and `judgeModel`.

**Found by the real run: agents name the project in commands.** Haiku ran
`cd /private/tmp/strv-smoke-proj && sh check.sh`. Replayed as written,
that check runs in the real project, which by then passes, so both sides
pass whatever the agent did. The project's path in the prompt and check is
now relocated to the scratch copy (`relocate`, whole paths only, plus the
`/tmp` alias of `/private/tmp`). The e2e task uses such a command; with
relocation disabled, the pass test reads "without 3/3" instead of 0/3.

**Real run (Haiku 4.5, $0.055 in all, the replay $0.025).** A project whose
`check.sh` passes once `config.txt` says `mode=fast`; two `strive run`
sessions fixed it (one cited), one said hello.
- With the judge on Haiku, it failed the proposal on "generalizes": the
  held-out session fixed the check from its error message alone, so the
  memory is redundant. Replay was skipped ("the judge failed it"), as
  designed.
- With the judge skipped (`judgeModel` set to an OpenAI model with no key)
  and `replay.model` Haiku, 1 run a side: "with the change 1/1 passed,
  without 1/1; 1 task", $0.0252 of the $0.20 cap, 13 s. The with-change
  agent still ran the check before writing `config.txt`, so the proposal's
  prediction didn't hold there; replay measured the outcome, not the path.

**Tests** (`packages/host/src/replay.e2e.test.ts`, real daemon, host,
gateway and sandbox; `FakeAnthropic` takes a function so replies can
depend on the request): a pass (3/3 vs 0/3, the gate order, the runs'
sessions hidden from lists, the review output), a fail, nothing minable,
a judge fail skipping replay, a cap the learning budget can't hold, a cap
that runs out at the first call, and a replayed agent that can't write the
project. The desktop e2e checks the Learned pane shows the replay's
detail. 4/4 alone and 2/2 with two copies at once.

**Deferred:**
- Reusing "without" runs across proposals, keyed by task plus the digests
  of memory and skills (bb's replay-by-hash).
- Recording whether a skill was read in a run.
- Other task shapes (a session's last test run passing).
- Parallel runs; `strive learn` waits 5 min for checks, which a real
  18-run replay can exceed.
- Reads aren't confined: a replayed agent can read the real project.
- The copy has no `.git` and no ignored files (`node_modules`), so checks
  that need them fail on both sides (inconclusive).
- A daemon stopped mid-replay leaves its scratch directory behind.

## 2026-09-25: M11, predictions checked and drift

Design in [ADR-0019](docs/adrs/0019-predictions-checked.md). bb's
suggestion 2, and the cheap half of 4.
- **A watch beside the prose.** `Proposal.watch` (optional): a `when`
  step pattern and `never` / `any` / `first {of, is}`. A step is a prompt or
  a command that ran; a pattern is case-insensitive substrings (`prompt`
  alone, or `command` + `output` + `exit` of one command). No regexes, no
  nesting, one pass. `deny_unknown_fields` on the watch types, so a
  learner's invented `regex` field is refused at parse instead of silently
  widening the match (ts-rs can't read that attribute; its
  `no-serde-warnings` feature quiets the build).
- **Bounds** (`strive_learning::watch`): 2,000 steps, 256 KiB of one
  output (both ends), 8 MiB per session, outputs fetched lazily and once.
  A miss in what wasn't read is unknown, so `never` over a cut session is
  "not applicable", not "confirmed".
- **When:** a work host's `turnEnded` (background task) and `learning/run`
  (catch-up, covers turns the daemon ended after a host died). Only applied
  proposals, only sessions created at or after the apply, read up to their
  last `turnEnded`. `predictionChecked` is journaled only when the pair's
  outcome is new or changed; the fold counts each session once, by its
  latest. Evaluating on `proposal/list` was rejected: it would re-read
  every later session's journal on each desktop focus.
- **Drift:** ≥ 3 contradictions among the last 10 applicable sessions (by
  ULID order), outnumbering confirmations, is `notHolding`. `strive review`
  prints "#N may be hurting ... `strive review N rollback` ..."; the
  detail shows the watch as a sentence and the tally. The desktop's
  Prediction section shows the same and relies on the existing Roll back
  button. Nothing rolls back on its own; a test checks the file and the
  journal are untouched until a person acts, and that the learner's host
  is refused.
- **Staleness:** `mayBeStale` in `proposal/list`: memory lines with a
  backticked relative path (with `/`, no spaces or globs) that isn't there.
  Shown by `strive review` only.
- **Judge:** the document includes the watch and its sentence; `checkable`
  asks, when there is one, whether it tests the prediction.

Tests. Unit (`crates/learning/tests/watch.rs`, 18): each expectation's
three outcomes, prompts vs commands, refused commands and unended turns,
lazy/once output reads, a 1 MiB output with the needle mid (unknown) and at
the end (found), the 8 MiB total, the step limit, huge prompts, malformed
forms, the static gate, the sentence, the tally threshold and window, the
fold's latest-wins, and named paths. Daemon (`tests/predictions.rs`, 8):
confirm/contradict/not-applicable through real turns and sandboxed
commands, idempotence and a changed answer, the threshold, review output
and a person-only rollback, sessions before the apply, catch-up on
`learning/run`, a 20 MB output, malformed and unknown-field watches,
staleness. Host e2e: the learner's `propose_change` carries a watch and
the next real session contradicts it. Desktop e2e: not machine-checked,
then not holding after three sessions, then Roll back. Mutations checked:
dropping the dedupe failed the idempotence test; dropping the apply-time
filter failed the before-the-apply test.

Deferred:
- Telling the learner how its predictions fared.
- A quality-peaks-then-declines watch (ADR-0016's second M11 bullet).
- Watches on file effects and on the order of two steps.
- Staleness in the desktop pane, for skills, and for commands that later fail.

## 2026-09-26: the first line of highlighted code could stay one colour

`highlight.test.ts` failed under load: "const" and "42" came back the same
colour. Shiki gives each line 500 ms (`tokenizeTimeLimit`) and leaves the
rest of a line that runs over as one default-coloured token. The first line
a grammar tokenizes pays for compiling its regexes: ~700 ms for TypeScript
on an idle machine, measured, and the JavaScript engine does this on the
page's thread. So a cut first line was likely even outside tests, and the
cache kept it plain. The limit is now 5 s per line; lines after the first
take about a millisecond. Under 12 busy loops the test failed 7/10 before
and 0/10 after.
## 2026-09-26: learning triggers, the pre-filter, and `gated`

Design in [ADR-0020](docs/adrs/0020-learning-triggers.md). bb's suggestion 3
and the last Stage 2 item in ADR-0016.
- **The setting:** `learning: {mode, idleSeconds, everyTurns, dailyRuns}`,
  `suggest` / 600 / 0 / 3 by default. `off` stops automatic runs only;
  `strive learn` still works (a person asked). `auto` is refused on load with
  a message naming `gated`: memory and skills are the only artifacts, and
  they carry the same risk, so it would be an alias whose meaning would
  change silently once a riskier kind exists. A project's
  `.strive/settings.json` may only lower the mode (`min`): it's writable by
  anyone who commits, and by a work session's commands (the sandbox guards
  memory and skills, not the rest of `.strive`). A malformed one turns
  automatic learning off for the project and logs why. Settings still load
  once per daemon.
- **The pre-filter** (`strive_learning::signals`, pure): corrections (first
  prompt after a turn; fixed openers like "no", "actually", "don't" and
  phrases like "I said", "you didn't" in the first 200 chars; "no problem"
  and friends excluded), interrupts, declined approvals, commands that
  failed then passed (`replay::fixed`, split out of `mine` without its
  checkpoint requirement), failed or timed-out turns. Every sign is anchored
  at the entry that completes it, so a longer journal finds the same signs
  plus newer ones; the daemon asks only for signs past the highest seq an
  earlier automatic request named for that session (`triggers::acted_on`).
  Skips don't consume signs.
- **When:** each work `turnEnded` spawns a wait of `idleSeconds`; a prompt
  journaled in the meantime cancels it (logged). `everyTurns` scans at the
  turn end. Idle beat "last client detached": `strive run` detaches every
  turn and a person leaves the TUI open. 600s is under the daemon's 900s
  idle exit, so a one-shot `strive run` still gets its scan.
- **Limits:** under the project's lock, re-reading the learning journal:
  a request no turn has finished, or a `checking` proposal, holds it back;
  then the 24h rolling cap (automatic requests only); then key, price, and
  the ledger admitting one worst-case learner call (whole context window
  in, the agent's output cap out). Failing one journals `learnSkipped`; the
  latest shows in `strive review` and the pane until an automatic run
  starts. A clean session journals nothing and creates no learning session;
  the log says "scanned for learning: no new signs", which the tests wait on.
- **`gated`:** only at the replay's pass (the last verdict), only if every
  gate is a pass (`every_check_passed`), only over the file as the learner
  saw it (otherwise it records nothing, rather than a stale accept). The
  decision carries `automatic: "gate"`, which only the daemon sets; `by:
  "gate"` alone would be forgeable by a client named "gate" (a test does
  that and gets a person's decision). A crash between verdict and accept
  leaves it for a person; later lists never auto-accept, so switching to
  `gated` doesn't sweep up old proposals.
- **Found while testing:** the replay only runs after a judge that passed
  or was skipped, so "replay passed" doesn't imply "judge passed". Checking
  only the replay's verdict would auto-accept a proposal the judge never
  saw. The e2e with the judge skipped (an OpenAI `judgeModel`) and replay
  passing on Haiku fails if `every_check_passed` treats a skip as a pass
  (checked by mutation: status became `applied`). The replay-skipped test
  alone can't catch that mutant, since the gate never runs there.

Tests. Unit (`crates/learning/tests/signals.rs`, 19): each sign, a clean
session, first-prompt-only corrections, phrasing (yes and no lists, the
200-char head), ordering and `after`, prefix stability, the limit and
excerpts, `acted_on`, the cap count, `busy`, `skipped`, `every_check_passed`.
Daemon (`tests/triggers.rs`, 14): the idle trigger once per sign (then
nothing for a clean idle, then only the new interrupt), a clean session,
a prompt inside the wait, every N turns, busy, the daily cap with review's
skip line, a person past the cap, `off`, a project's lower mode and a
malformed file, no key, no budget, review and log showing the trigger, `auto`
refused, `gated` with skipped checks and a client named "gate". Host e2e
(`replay.e2e.test.ts`): `gated` accepts with static/judge/replay all passed
(`by: gate`, `automatic: gate`, review's marks, rollback via `strive review
N rollback`); not with the judge skipped, replay skipped, replay failed, or
judge failed. Learner unit: an automatic request's prompt lists its signs.
Desktop e2e: the Automatic badge and the trigger's signs in the detail.
Mutations checked: no watermark fails the once test; a skip counted as a
pass fails the judge-skipped e2e.

**A flake seen, not reproduced.** The first `check.sh` failed one desktop
e2e, "the conversation has the window to itself until a panel is shown":
after "Show spend" the app closed ("Target page, context or browser has
been closed") 25 s into waiting for the panel, with nothing in the log.
The second `check.sh` passed; so did the test 5/5 alone, the whole desktop
suite 4/4, and the test with its neighbour 8/8 beside `bun test
packages/host` load. The only per-window change here is that
`proposal/list` awaits the main process's `learning.follow()` (one
`session/list` when there's no learning session), which that test doesn't
wait on. The app closing on its own, with no `window.close` in main, reads
like the killed-process load failures noted on 2026-09-24; unconfirmed.

Deferred:
- Idle-time consolidation across many sessions.
- Catching up scans that a daemon restart dropped (waits are in memory),
  and a turn the daemon ended itself (a host that died) starts no wait.
- An explicit "session ended" trigger; risk tiers and `auto`.
- Telling the learner which proposals the gate accepted.
- Non-English correction phrasing.
- A desktop e2e of a gate accept (it needs the full replay stack; the note's
  text is unit-tested, and the host e2e covers the accept itself).

## 2026-09-26: Stage 2 review, control characters

A trust-boundary review of Stage 2 found that `hidden()` let C0/C1 control
characters through, and `strive review` and `strive log` print journal
text raw. A proposal could carry `ESC[8m` (concealed text), `ESC[1A ESC[2K`
(erase the line above) or `\r` and show a reviewer a harmless diff, or fake
a "judge: passed" line; an escape code inside a phrase also broke the
safeguard match. The static gate now refuses every control character but
newline and tab, and review and log print control characters written out
(`\u{1b}`) via `terminal::visible`, since a failed proposal's summary is
still listed. Both tests failed first.
`strive run`'s text output now goes through `terminal::visible` too (a
test with a reply holding ESC and CR failed first); its `--json` output was
already escaped by serde. The TUI already filtered control characters
(`printable` in `packages/tui/src/app.ts`, from the Stage 1 review).

## 2026-09-26: Stage 2 review, trust boundaries of the learning loop

An adversarial review of the learning loop found seven things. Each fix has
a test that failed first (the e2e ones in `packages/host/src/replay.e2e.test.ts`
drive the real daemon, hosts and sandbox with a scripted model).

1. **Replay setup wrote through a checkpoint's symlinks** (high). The daemon
   puts the learned files into each scratch copy unsandboxed, after `git
   checkout-index` has recreated the checkpoint's symlinks, so a task whose
   `.strive` linked to a directory elsewhere had the daemon remove and write
   files there. The e2e proved it: the outside `memory.md` held the proposal.
   A task whose copy has a symlink on the way to any learned file is now set
   aside with the reason (the rest still run; all set aside is a skip), and
   the writes go through `pinned` with `O_NOFOLLOW`.
2. **Replay was easy to satisfy** (high, both reviewers).
   - A tie (3/3 against 3/3) passed. It is now skipped, "inconclusive: the
     change made no difference"; pass needs more passes with the change.
     `gated` can't accept a change that did nothing; a person still can.
   - A check naming a path outside the project after relocation (`test -f
     /tmp/.ok`, `~/…`, `$HOME/…`) is no longer mined
     (`replay::outside_path`); system tools and `/dev/null` are allowed.
   - Citing steered the checks: cited sessions are excluded from the judge's
     held-out sessions and from mining, and a citation could have no seqs.
     The static gate now fails a citation with no entries and more than
     `CITED_SESSIONS` (5) sessions.
3. **The prompts misstated `gated`.** The judge was told a person reviews
   its verdict; it now gets the mode and, under `gated`, is told its verdict
   may be final (a daemon test compares the system text the provider
   receives in both modes). The learner isn't told the mode (`AgentConfig`
   has no such field), so its prompt and `propose_change` now describe both
   paths. That text change has no test: it's a constant.
4. **A rollback didn't stick under `gated`.** The same content could be
   proposed again and accepted again. The gate now refuses content whose
   digest equals a rolled-back proposal's for the same file, and the judge's
   material carries those contents as `rolled_back`.
5. **Mode switches.** `gate_accept` read the mode when replay's verdict
   landed. The daemon now records the mode in effect in `proposalMade.mode`
   (a host that sets it is refused) and needs `gated` then and at accept.
   The e2e lowers the mode with a project `.strive/settings.json` and deletes
   it from inside the scripted replay, which is deterministic where a
   restart wouldn't be. Left open, in ADR-0020: a command or commit can
   delete that file before a proposal is made.
6. **Display.** A person's client named `gate` read as "accepted by gate".
   Log, the view's descriptions and the learner's journal view now say "by
   gate (a client)"; only `automatic` gives "accepted automatically".
7. **Scope, docs only:** ARCHITECTURE says `AGENTS.md`/`CLAUDE.md`/
   `.claude/skills` are outside review and MCP servers (unsandboxed,
   user-trusted) can write memory. ADR-0017 records that `gated` rests on
   one judge call; no prompt-injection hardening beyond the above.

Two lint slips (blank lines oxlint wants in the e2e file, and a quote style
biome wants in `learner.ts`) were fixed in the fix-4 commit, so commits 1
and 3 alone don't pass Oxlint/Biome.

**A flake seen, not reproduced.** The first `check.sh` failed one desktop
e2e, "a decision made in one window survives another window's save", with
"Target page, context or browser has been closed" while waiting for the
second window's first line: the same shape as the flake noted in the
triggers entry above. Nothing here touches that path. The desktop suite
then passed 3/3 alone, the test 3/3 beside `bun test packages/host`, and
the second `check.sh` passed whole.

Deferred: a check that leaves the copy by `..`; telling the learner the
mode through `AgentConfig`; hardening the judge (a second judge, a quorum).

## 2026-09-26: Stage 2 review, correctness of the learning loop

Adversarial reviews found crash and stop paths that left the learning loop
stuck or charged, and tests that couldn't fail. Every fix below has a daemon
test (`crates/strived/tests`) that failed before it; each mutant named was
applied by hand and the test failed.

**A harness for the replay gate.** `tests/replay.rs` drives replays with a
test connection as each run's host (`STRIVE_HOST` is a script that exits,
and the test registers in its place): the daemon, gateway, sandbox and
check are real, a fake model answers the judge and any run's calls, and the
task is a real red-to-green turn made through `effect/run`. A run "follows
the lesson" by touching the check's file only when the scratch copy has the
proposal's memory, so replay passes deterministically. Most of the replay
and gate fixes are tested there; the TS e2e keeps the real host.

1. **A learner turn cut off by a crash stopped automatic learning for good.**
   `busy` saw the request unfinished forever; only `strive learn` started
   the host whose resume ends the turn. The trigger's limit now starts the
   learning session's host when it finds an unfinished request (a no-op
   with one registered or starting). Test: the crash's journal written
   offline, a later scan's skip starts the host (a script that notes its
   arguments), the "resumed" host ends the turn, the next scan asks.
2. **Replay holds cut off by any stop.** Three parts:
   - Each run is now named in the learning session (`ReplayRunStarted`, a new
     event) before its prompt. At startup, before anything can begin a
     replay, every hold with no `ReplayFinished` is finished, charged what
     its runs' journals show (open calls at their reservation), or the
     whole hold if a run's journal can't be read. Startup rather than the
     learning writer's open: at startup no replay can be live, while a
     writer can reopen (after a failed write) with one running.
   - `strive stop`/SIGTERM stops replays first: the run's wait for its
     host wakes on a watch, its check is registered so `cancel_effects`
     cancels it, and each replay journals its end (no verdict, so the next
     daemon replays it) before the writers stop; bounded at 10s, after
     which the next start settles it.
   - A budget refusal names held money: `Refusal::Usd` carries `held`, and
     the messages add ", with $H of it held by replays that haven't
     finished".
   Tests: SIGKILL mid-run, restart, `replayFinished` charged the run's
   exact spend; `strive stop` mid-run, the journal read offline has it;
   a second replay refused by the first's hold names the held $1.
3. **Accept and rollback write before journaling.** Chose idempotent
   retries over an intent entry: no protocol change, and the file itself
   says which half happened. An accept that finds the proposal's content
   already there journals the decision and `proposalApplied` with the
   recorded `before`; a rollback that finds the file already `before`
   journals `proposalRolledBack`. The one ambiguity, someone writing the
   exact proposed content by hand, ends the same way a person would want.
4. **A rejected proposal was still replayed.** `judged` starts the replay
   only while the proposal is `checking`; `decide(reject)` sets the running
   replay's stop flag, checked before each run; a stopped replay journals
   only its end. Tests: reject during a slow judge (no `replayStarted`),
   reject during run 1 of 2 (one run, no verdict).
5. **A proposal left `checking` by a crash held triggers back** until a list.
   `scan_and_ask` calls `settled` under the lock before its limits.
6. **Signs skipped while busy were lost; daemon-ended turns never scanned.**
   `strive_learning::triggers::waiting` finds sessions whose latest skip was
   for being busy with no automatic request naming them since; when a
   learner's turn ends (host or daemon) or a judge/replay verdict lands, and
   nothing is going, they're scanned again, oldest first, under the usual
   limits. The daemon's own `end_open_turn` starts the idle wait. Tests: the
   busy test now needs the rescan, checked as the exact order of requests
   and skips; a host that leaves mid-turn gets a `turnFailed` request.
   Predictions still catch up on daemon-ended turns only at `learning/run`,
   as ADR-0019 says (a predictions test asserts that).
7. **Small ones.**
   - A gate that can't accept is logged as the gate's failure, not "could
     not journal the replay" (test: the memory made a symlink mid-replay).
   - An unreadable work journal isn't "prompted since" (test: a journal
     tampered in the wait is logged as not verifying).
   - The judge: 429, 529, `rate_limit_error` and `overloaded_error` are a
     skip naming the provider's message; refusals and broken calls still
     fail, and neither suggests `strive learn`, which doesn't re-judge.
     Decision, in ADR-0017: an outage can make a proposal ready for a person
     (marked not judged) but never accepted without one, since `gated`
     accepts only a judge pass; a fail would block the proposal for good.
     The fake model can now answer any status or cut its body.
   - A replay run that is over can't call the model: the gateway refuses
     (403) a replay session that isn't a run under way.
   - Scratch areas carry a `strive-home` file (outside where commands may
     write) and the daemon removes its own at startup, never another's.

**Mutants killed.** M6 (`user.min(project)` → `project`): a project's gated
under a user's suggest records `suggest` in `proposalMade.mode`. M8 (the
judge's non-2xx arm → Skipped): 400 and 500 must fail. M3 (the gate's
changed-file guard deleted): the gate over a file edited mid-replay must
record nothing. Host: deleting `this.proposals -= 1` fails the refused
proposals test, now followed by the rest of the allowance; deleting
`this.proposals = 0` fails a new two-turn test.

**Weak tests fixed or removed.** The gated trigger test's first half (it
asserted no accept where the gate never runs); `wait_events(.., 1).len()
== 1` in two trigger tests, now counts after a later signal; the e2e's
"run the tests" check, now on `read_session`'s own result; the interrupt
test's `elapsed < 4000`, now "the model hadn't answered when the turn
ended" (`FakeAnthropic.answered`); fixture self-checks and a never-present
string in `learner.test.ts`; a header constant in `journal-view.test.ts`;
`fold.rs`'s restated status table; the desktop's pre-sorted `fileHistory`
input (the function now sorts). Every run a learner test starts is
stopped. Trigger, learning, predictions and judge connections wait 30s for
a reply (`common::slow_rpc`).

Deferred:
- A cut-off replay's `ReplayFinished` names no runs (their outcome is
  unknown); `ReplayRunStarted` names their sessions for audit.
- The rescan after checks finish is tested only through a learner turn's
  end; the checks path shares the same call and `waiting` is unit-tested.
- Settling holds when a learning writer reopens mid-daemon.
- Catching up idle waits a restart dropped (unchanged).

## 2026-09-28: the daemon passed on descriptors it was started with

The first Linux CI run (PR #77) failed
`a_sandboxed_command_sees_only_its_standard_descriptors`: a sandboxed
`ls /proc/self/fd` listed 142 and 145 besides 0-3. strive opens nothing
without close-on-exec (checked: `pipe2`, `pinned`, `command-fds`); the
runner had started the test process with descriptors left open across
exec, the launcher passed them to the daemon, and the daemon to every
command, host and MCP server, through bwrap and sandbox-exec alike. A
machine whose shell leaks nothing never shows it, which is why macOS runs
here passed. The daemon now closes every descriptor above stderr at start,
before its runtime opens any. The new test leaves descriptor 200 open when
it starts the daemon and failed on macOS before the fix.

## 2026-09-28: `strive stop` against a daemon that exits first

Linux CI failed `a_model_without_a_price_is_refused_and_settings_can_price_it`
at `env.stop()`, once, with nothing said: the helper asserted without
stderr (it prints it now). The likely cause, reproduced with a fake daemon:
the daemon wakes its stand-down before its `daemon/shutdown` reply is
written, and one with nothing to wind down can exit first, so `strive stop`
got "daemon closed the connection during daemon/shutdown" and failed a stop
that happened. A connection lost during that request is now taken as the
stop asked for; `wait_until_gone` still checks the daemon is gone. 150 real
start/stop cycles here never lost the race; the fake daemon's test failed
before the fix.

## 2026-09-28: the changes pane missed same-size edits on Linux

Four desktop e2e tests failed only on Linux CI: the changes pane listed new
files but not edits, all same-size (`v1`→`v2`, `line 450`→`LINE 450`). The
failure output now dumps the checkpoints' git view, which showed it:
notes.ts's index entry and the edited file shared a second and a size, and
`git diff-files` on the real index still saw the edit, because git rehashes
an entry no older than the index file ("racy git"). The changes view
stages through a copy of that index, and `fs::copy` stamps the copy with
the time of copying, so a second later git trusted the stale entry. On
macOS git compares nanoseconds, which is why it never showed here. The
copy now keeps the index's mtime. A macOS test forcing seconds-only stat
checks didn't reproduce it (racy detection there still uses nanoseconds);
the Linux e2e tests are the regression tests.
## 2026-09-28: the mutants CI found

CI's mutants job (PR #77) missed 68 mutants. Each file was re-run with
`cargo mutants --file <path> -j 2` after its tests went in. The full suite
was then run once as `--shard k/8` (8 shards, `-j 2`), since the script's
`-j 4` can't be overridden (`--jobs` twice is an error).

- **Before:** 68 missed. **After:** 18 missed, all in `watch.rs` (14) and
  `replay.rs` (4). Those two are deferred: that code may be simplified
  soon, so they have no new tests and no excludes yet. The other 50 were
  either killed by new tests (49) or recorded as equivalent (1).
- **Killed, by file:** rpc.rs 13, gateway 9, learning `lib.rs` 8,
  render.rs 6, proto `lib.rs` 4, stale.rs 3, journal 2, triggers.rs 1,
  signals.rs 1, checks.rs 1, budget 1.
  - rpc.rs: the predefined error codes are checked against JSON-RPC 2.0
    section 5.1 by parsing and reserializing a response. strive's own codes
    must be distinct and fall in the spec's server-error range (-32000 to
    -32099).
  - The "citing either half of an effect" render test passed whatever the
    pairing did: its budget kept both halves anyway. Its prompt is now
    sized so only the pairing keeps both. (Among the deferred ones, the
    huge-output watch test has a similar gap: every mutated split of the
    output still misses its needle.)
  - Some mutants were only visible in timing or in text a person reads:
    the holdback kept a line's newline until the next chunk arrived, the
    meter's limit was off by one, and the ideographic-space fold only shows
    in the quoted command of a finding.
- **Equivalent (1):** `triggers.rs` `e.seq > asked` -> `>=` in `busy`. The
  one entry with seq `asked` is the `LearnRequested` itself, and the loop
  reads only `TurnStarted` and `TurnEnded`. It's excluded by name in
  `.cargo/mutants.toml` (new, since Stage 1 recorded none).
- **Real bugs:** none. The misplaced doc comment on `Journal::next_seq`
  (it described `append`) is moved back.
- **Tooling trap:** with `CARGO_TARGET_DIR` set, cargo-mutants' parallel
  jobs share one target dir, and a test can run another mutant's binary.
  At `-j 2` a hanging `watch.rs` mutant showed up as caught. Run mutants
  with `CARGO_TARGET_DIR` unset. Also, `check.sh` from a worktree this deep
  fails `the_sandbox_blocks_unix_sockets_outside_it`, because the socket
  path under `target/tmp` goes over macOS's 104-byte limit. It passes with
  a short target dir.

## 2026-09-28: files that run code outside the sandbox

The frontier survey for the simplification plan pointed at sandbox-runtime's
list of "dangerous files". Checked here: a sandboxed command could write
`.git/hooks/pre-commit`, and the agent's write tool wrote it without asking
in auto-edit. Git runs hooks (and reads `.git/config`: `core.fsmonitor`,
aliases) for the person later, outside any sandbox, so either was a way out.
The same holds for shell rc files, `.vscode` tasks and `.claude` commands
in the project. Commands now can't write them (Seatbelt: by pattern, in any
case, nested repositories too; bwrap: read-only binds for those at the
project root that exist), and write/edit ask a person in every mode. Git
itself still works in the sandbox; `git config` doesn't. Both tests failed
first. Not yet on Linux: nested repositories' hooks, and creating one of
these files where none exists.

## 2026-09-28: subtract before adding (items 1 and 2 of the plan)

Why: nobody (exo, Prime Agent, the literature) gates each learned change by
replay; at 3 runs a side a change that does nothing passes "with > without"
about a third of the time; and the adversarial reviews found the checks
themselves were the main attack surface. System-level validation moves to
an offline `strive eval`, a later PR.

- **Deleted:**
  - the replay gate: `crates/strived/src/replay.rs`,
    `crates/learning/src/replay.rs`, replay sessions (`kind: replay`), their
    scratch dirs and startup sweep, the budget holds (`Ledger::hold` and
    `release`, `Refusal::Usd.held`), `ReplayStarted`/`ReplayRunStarted`/
    `ReplayFinished`, the gateway's refusal for closed runs, `Scope.temp`
    in the sandbox, `relocate`, the `replay.*` settings, `Hosts::stop`,
    `Shadow::export`, and their tests (`crates/strived/tests/replay.rs`,
    `crates/learning/tests/replay.rs`, `packages/host/src/replay.e2e.test.ts`);
  - `gated`: the mode, `gate_accept`, `every_check_passed`,
    `Automatic` and `proposalDecided.automatic`, `proposalMade.mode`, the
    rolled-back-digest refusal, the judge's "your verdict may be final"
    prompt, and "Accepted automatically" in review, log and the desktop;
  - watches (M11): `Proposal.watch` and its types, both `watch.rs`,
    `PredictionChecked`, `PredictionTally`, "may be hurting", the learner's
    watch rules and schema, the desktop's Prediction tally, and
    `crates/strived/tests/predictions.rs` and `crates/learning/tests/watch.rs`.
- **Line counts** (`git diff --shortstat 0c23c04`): code (`crates`,
  `packages`, `apps`, `.cargo`) 73 files, +527 / −5,483; of that the
  generated protocol bindings are +11 / −126, so hand-written code is
  +516 / −5,357, 4,841 lines net removed. Hand-written rs, ts, tsx and css
  (not generated) went from about 42,250 lines to 37,413. Docs: +159 / −184.
- **Kept, and why:**
  - `strive_learning::stale` (memory lines naming a path that's gone): it
    reads memory text, not watches, and `proposal/list` still uses it. Its
    tests moved to `crates/learning/tests/stale.rs` and
    `crates/strived/tests/learning.rs`.
  - The `failedThenPassed` sign: it used the replay miner's pairs, so the
    rule (a turn's first failing command that later passed, at most 300
    characters) is now a small function in `signals.rs`. A turn is now
    counted at each `turnStarted`, not only one that took a prompt.
  - The judge's "rolled back before" input: it's what the judge reads, not
    the gate's refusal.
  - "(a client)" after `by` in the log: harmless, and removing it touches
    three renderers for nothing.
  - `SessionPromptResult.ts`, a generated file no Rust type makes any more;
    it predates this change, so it's left for its own cleanup.
- **Behaviour changes:**
  - The judge advises. `ready` = static passed and the judge finished
    (pass, fail or skip); `failed` = the static gate failed. `strive review`
    marks `[the judge advises against it]`, prints that line near the top of
    the detail, and says accept writes anyway; the desktop shows "The judge
    advises against it" and the failed criteria's reasons at the top.
  - Learning modes are `off` (the default) and `suggest`. `gated` or `auto`
    in settings fails the daemon's start as an unknown variant.
  - Protocol version 2.
- **Old journals:** chosen: fail verification cleanly, not skip. Skipping
  would leave seq gaps every reader would have to tolerate and weaken what
  verification means. A line the daemon's key signed whose event no longer
  parses is `Problem::Unreadable` ("an event this version of strive doesn't
  know; another version wrote it"), distinct from `Tampered`. Work journals
  hold none of the removed events, so they still verify; an old learning
  journal (every proposal had a `gateFinished {gate: replay}`) and old
  replay sessions don't. Pre-release, so the fix is to delete
  `~/.strive/sessions/<id>` for those; the next `learning/open` makes a new
  learning session.
- **Tests:** failing first: a judge fail is advice a person can accept past
  (daemon, fold and desktop e2e), automatic runs are off unless settings
  turn them on, and an entry from another version fails as unreadable. Two
  signals tests were added for mutants the move left alive.
- **Mutants** (`--file`, `-j 2`, `CARGO_TARGET_DIR` unset): learning's
  `signals`, `fold`, `lib`, `checks`, `judge`: 184 tested, 0 missed; journal
  and budget `lib.rs`: 143 tested, 0 missed. Two new equivalents are in
  `.cargo/mutants.toml`: `==` to `!=` in `fold::status`'s every-gate test
  (with two gates both forms agree) and `>` to `>=` in
  `failed_then_passed` (the equal seq is the failed run, excluded by its
  exit). The deleted files' 18 deferred survivors are gone with them.

## 2026-09-28: one list of what shapes a session (item 3 of the plan)

Three notions of "files that shape later sessions" had drifted apart: the
loader's (instruction files root to workspace, memory, three skills
directories), `learned_file` (memory and `.strive/skills`) and PR #82's
`protected` (files that run code). A full-auto session could rewrite
`AGENTS.md`, `CLAUDE.md`, `.claude/skills` or `.strive/settings.json`
unasked, with no sandbox rule in the way.

- **The list** is `context::SHAPING`, by last components at any depth
  under the project's root (the repository's, or the workspace outside
  one), since a later session can start in any directory: `AGENTS.md`,
  `CLAUDE.md`, `.claude/skills` (told), `.strive/memory.md`,
  `.strive/skills` (learned), `.strive/settings.json` (settings). Home adds
  its `AGENTS.md` and `skills`; home is closed to the agent anyway. The
  daemon reads MCP config only from `~/.strive/settings.json`; `.mcp.json`
  stays on #82's list.
- **The loader uses it:** every file it reads (instruction files, imports,
  memory, `SKILL.md`s) must have a real path on the list (`Anchors::listed`,
  which replaced `allowed`). A new source not added to the list fails
  closed: it isn't read.
- **Symlinks, decided:** the loader skips a listed path whose real path
  isn't listed. The other option, protecting the resolved target, would
  have to follow every link and import in every directory a later session
  could start in; the gate can't enumerate that. Skipping needs only the
  list. It also covers imports, which have the same shape: `@docs/x.md`
  now stays as text (a behaviour change; `@rules/AGENTS.md` still
  inlines, and `CLAUDE.md -> AGENTS.md` still loads). Memory and
  `.strive/skills` keep the stricter "no symlink at all", since memory is
  labeled reviewed.
- **Merged or deleted:**
  - `learned_file` and `protected` became one `guarded` (the list plus
    `RUNS_CODE`), `Access::Learned`/`Protected` one `Access::Guarded`, and
    #82's `PROTECTED_FILES`/`PROTECTED_DIRS` one `RUNS_CODE` of `a/b`
    strings, matched by the same `context::matches` (windows, any case).
  - `protected_rules` became `guarded_rules`, which writes the Seatbelt
    rules for both lists, plus a literal deny on the directories holding a
    listed path (`.strive`, `.claude`) anywhere, so neither can be moved
    into place. That replaced the hand-written `.strive`/memory/skills
    literals. It is anchored at the project's root, not the workspace:
    instruction files above the workspace can sit in a temp directory
    commands may write.
  - `leads_to`, `follow`, `SYMLINK_HOPS` and the sandbox's memory and
    skills link targets are gone. They protected the file a symlinked
    memory or skills directory led to, but since 2026-09-24 the loader
    doesn't load such a file, so it was a second mechanism for one rule.
    Their two tests (`a_file_the_learned_paths_link_to_asks_too`,
    `the_sandbox_protects_the_file_learned_memory_links_to`) went with
    them; `learned_memory_and_skills_reached_through_a_symlink_are_not_loaded`
    still holds the property.
  - Linux binds come from the same two lists, in the workspace itself.
- **Kept:** `outside_review` stays learned files only; a person editing
  `AGENTS.md` by hand is normal. `context::learned` (the learner's view)
  is unchanged.
- **Wording:** learned files keep the `strive learn` text; instruction
  files and skills say "this changes what every future session in this
  project is told"; settings "this changes strive's settings for every
  future session in this project". #82's files now also show "X, which is
  Y" when the path given isn't the real one.
- **Tests, failing first:**
  - `unattended_full_auto_refuses_what_shapes_later_sessions` (approvals:
    an `AGENTS.md` edit, `CLAUDE.md`, `pkg/app/CLAUDE.md`, `pkg/agents.md`,
    `.claude/skills/x/SKILL.md`, `.strive/settings.json`, exact text);
  - `the_sandbox_keeps_commands_from_what_shapes_later_sessions` (effects:
    macOS by pattern, nested, other case, and `mv c .claude`; Linux the
    existing ones; other files still writable);
  - `the_loader_reads_nothing_outside_the_list` (context: a symlinked
    `AGENTS.md` and an import off the list skipped, a linked-in skill
    skipped; every path the loader did give, plus an imported `AGENTS.md`,
    is refused to an unattended full-auto write; the skipped link's target
    stays freely writable).
  - The `@rules/style.md` half of `imports_are_inlined_once_and_cycles_stop`
    became `@rules/AGENTS.md`. `full_auto_writes_other_files_without_asking`
    still passes: normal files are auto-allowed.
- **Linux:** `scripts/test-linux.sh`'s cached `rust:latest` is amd64 on
  this Mac and bubblewrap fails under emulation ("Can't open source /"),
  so the same job ran on the older arm64 rust image by ID: effects 33,
  approvals 23, mcp 12, context 14, all passing, clippy clean.
- **Line delta** (`git diff --numstat`): `context.rs` +97/−40,
  `effects.rs` +90/−163, so daemon source is 16 lines smaller with three
  guards on one list; tests +133/−45.
- **Gaps:** on Linux, nested listed files (`pkg/AGENTS.md`) and missing
  ones can still be written by a command (as for #82). A skill's other
  files, read later through a symlink inside a listed skills directory,
  aren't checked; only `SKILL.md` is loaded. `"sandbox": "off"` and MCP
  servers are outside all of this, as before.
