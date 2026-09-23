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
