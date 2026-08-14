# ADR-0007 — The pluggable sandbox boundary and the model-capability lane

Status: accepted and implemented in Stage 3C.2B, made end-to-end
authoritative in Stage 3C.2B.1 (`strive.sandboxes`,
`strive.sandbox_backends`, `strive.sandbox_launcher`,
`strive.sandbox_guards`, `strive.capability`).

## Stage 3C.2B.1 — making secure execution and capability evidence trustworthy

The 3C.2B slice shipped the boundary but left seams: execution was still
scattered across direct `run_strategy` calls; the deno runner executed the
candidate in the SAME namespace as the payload and trusted serialization;
`resource_limited` was not part of "secure"; provenance did not pin exact
runtime digests; the Linux spike reported available+secure with a raising
`run`; and capability trials sent a repeated seed-0 while calling it
"seeded." 3C.2B.1 closes all of these:

- **One execution service.** `CandidateExecutor` is the single kernel-owned
  path; run, promptgate, visible-context, experiments, compare, replay,
  audit, promotion, and capability all execute through it. `run_strategy`
  is called only inside `process-fault-only@1` and its tests. A
  fault-only executor REQUIRES `trusted=True`, so untrusted (model-authored)
  code on the fault-only boundary fails closed.
- **Injected immutable catalog.** Registration is no longer an import-time
  mutable global: `strive.sandbox_backends.DESCRIPTORS` (name + factory) are
  assembled into a `BackendCatalog` (`default_catalog()`), resolved by exact
  name@version, fail-closed. A reusable `conformance_violations` suite
  checks every backend's self-consistency.
- **Hardened protected protocol.** The candidate runs in a SEPARATE
  namespace holding only builtins; only `input_text` enters the sandbox
  (case id, split, expected value, and the rest of the suite stay
  parent-side). The result envelope is built OUTSIDE the candidate namespace
  with a serialization reference captured BEFORE the candidate ran, so
  rebinding `json.dumps` cannot hijack it. The parent assigns case ids by
  position and validates result count and exact per-result shape (a non-bool
  int or null; no extra/missing/duplicate fields; no protocol mutation), so
  forged ids and spoofed outcomes are rejected. Frame/global inspection
  yields only the candidate's own input — nothing sibling or secret.
- **Resource limiting is part of "secure."** `resource_limited` joins the
  secure floor. `deno-pyodide@1` launches Deno through
  `strive.sandbox_launcher`, which applies POSIX rlimits (CPU seconds, open
  files, processes, single-file size, and a coarse RLIMIT_AS ceiling) to the
  Deno process, plus a parent wall-clock hard-kill and an absolute suite
  deadline. The memory ceiling is honestly documented as a coarse
  whole-runtime bound (the WASM baseline is large; RLIMIT_AS is unreliable
  on macOS).
- **Authoritative provenance.** `SandboxProvenance` (v2) pins exact
  component digests (Deno version, Pyodide marker, DSPy version, runner-code
  sha256, backend-config digest). Each validator pins the boundary it
  actually used — the prompt validator carries its own sandbox provenance
  and cannot borrow the task candidate's. The activation gate checks
  provenance decodes, is versioned, is self-consistent about its secure
  claim, and AGREES across a decision's bundles (one bounded boundary per
  decision). Replay uses the recorded backend or reports it unavailable —
  never re-validating a Pyodide-contained candidate in plain CPython.
- **The Linux spike is honestly unavailable.** `linux-landlock-seccomp@1`
  reports no enforced capabilities and is ALWAYS unavailable until its full
  ruleset and leak-vs-closed tests land; it never claims available+secure
  with a raising `run`.
- **Trustworthy capability trials.** Each trial's seed is propagated into
  every `ModelRequest` (`LoopConfig.model_seed`), and the adapter's seed
  support is recorded honestly; a run persists one immutable `manifest.json`
  pinning per-trial request/prompt/completion/revision/evidence/sandbox/
  budget/outcome refs; a PREREGISTERED `CapabilityCriterion` (min trials,
  min clean-acceptance, interval lower bound > 0) decides the verdict, so a
  lone success among many never reads as `supported`; and `resume=True`
  reuses completed trials without duplicate model spend.

Exit claim: every model-authored execution path uses one mechanically
bounded backend; protected cases expose only input text; activation/replay
require exact sandbox provenance; capability trials use real recorded seeds
and reproducible manifests.

## Stage 3C.2B — the original slice

## Context

Through Stage 3C.2A.1 the only candidate-execution boundary was
`python -I` fault containment (`strive.sandbox`): a separate process with a
wall-clock kill, scrubbed environment, and POSIX rlimits — but no
filesystem confinement and no network denial. The README and ARCHITECTURE
said so plainly, and the loop refused lifecycle authority for
model-generated code (`unsafe_model_code` → generation-native only). That
is safe but permanently blocks the thing Stage 3C.2B exists to enable:
executing REAL model-written candidates and gathering genuine capability
evidence. Before comparing evolution algorithms, we need a boundary that
can contain untrusted code locally and a lane that separates deterministic
pipeline fixtures from repeated model-capability trials.

## Decision

**A trusted, pluggable `SandboxBackend` boundary.** Each backend is named
and versioned (`name@version`), reports the capabilities it MECHANICALLY
enforces on this host (never a promise), and produces per-execution
`SandboxProvenance`. The registry resolves a backend by exact name and
FAILS CLOSED: a requested backend that is unknown or unavailable raises
rather than handing back a weaker one. There is **no silent downgrade**.

Capabilities are a closed vocabulary: `filesystem_confined`,
`network_denied`, `subprocess_denied`, `env_scrubbed`, `resource_limited`,
`fresh_per_case`. A backend is `secure` iff it enforces the
secure-execution floor (all but `resource_limited`, which the shipping
secure backend delegates to the runtime).

**Three backends.**

- `process-fault-only@1` — today's subprocess boundary, renamed honestly.
  Its report names what it does NOT enforce (filesystem, network,
  subprocess). Retained for author-written fixtures and trusted code only;
  it is never `secure`.
- `deno-pyodide@1` — the shipping SECURE LOCAL backend, via DSPy's
  `PythonInterpreter` (Deno + Pyodide WASM). Default-deny: the candidate
  runs in a WASM virtual filesystem that cannot name a host path, with no
  `--allow-net`, no `--allow-env`, and no `os.fork`/subprocess (emscripten
  has no processes). A FRESH interpreter per execution means candidate
  state cannot persist across cases. A parent-side wall-clock watchdog
  SIGKILLs the deno process on overrun, so a candidate cannot hang the
  controller.
- `linux-landlock-seccomp@1` — a spike adapting NOOA's Apache-2.0
  `guards.py` (unprivileged Landlock path-beneath + seccomp-BPF socket
  denial + rlimits, self-installed post-fork, fail-closed `check_enforceable`
  probe). Available only on a probe-confirmed Linux kernel; on any other
  host it reports UNAVAILABLE and the registry refuses it.

**Protected evaluation runs each protected case in a fresh sandbox**
(`run_protected_suite`, `strive.protected`): held-out / regression /
adversarial / audit cases each get their own boundary, the candidate
receives ONLY `input_text`, and the parent retains case id, split, expected
output, and the rest of the suite. No repo, CAS, ledger, journal, task
definition, credentials, home directory, or host socket is reachable.

**Sandbox provenance is pinned into the evidence.** `EvaluationManifest`
(v3) gains `sandbox_provenance_ref` alongside the resolved-harness and
execution-record refs; the activation gate decodes it and verifies its
backend is versioned. Evidence from different backends is therefore
distinct, and replay can demand the recorded backend or report it
unavailable. **Lifecycle/canary authority is granted for model-generated
code only when the backend that executed it was `secure`** — the loop's
`unsafe_model_code` branch now falls through to the native lifecycle path
under a secure backend and stays generation-native only without one.

**The model-capability lane** (`strive.capability`) runs REPEATED, SEEDED
real-model trials (through the existing OpenAI-compatible adapter, including
local vLLM/Ollama-compatible endpoints) with candidate code executed inside
the secure backend, and reports honest AGGREGATE evidence — acceptance rate,
clean (regression-free) rate, failures, and a `supported` / `inconclusive`
/ `negative` verdict. The scripted `FakeModelAdapter` remains the
deterministic CI control, labeled `fixture`/`inconclusive` unchanged; a
single trial or a fixture is NEVER capability evidence (`trials >= 2`
required for a verdict).

## Rejected alternatives

- **Making `deno-pyodide@1` the default backend.** Each boot is ~1.4s; the
  fault-only subprocess stays the default so the deterministic suite is
  fast and unchanged, and the secure backend is opt-in for real model runs
  and the adversarial tests.
- **Silent fallback to a weaker backend when the requested one is
  unavailable.** Rejected outright — it would let a "secure" request run on
  the fault-only boundary. The registry fails closed.
- **Containers/VMs now (RLM's Docker backend; exo's snapshot/teleport).**
  Deferred: the WASM boundary is a genuine local security boundary with no
  daemon dependency; container backends slot behind the same protocol later.

## Sources: borrowed / rejected / deferred

- **Borrowed** — NOOA (note 06): the self-installed Landlock+seccomp+rlimit
  guards, the fail-closed `check_enforceable` probe, and the leak-vs-closed
  test shape (Apache-2.0, attributed in `sandbox_guards.py`). Flex/DSPy
  (note 01): `PythonInterpreter` (Deno+Pyodide) as the shipping secure
  local backend. exo (note 04): one isolation interface behind which
  backends vary. RLM (note 05): the Docker/remote backend shape for the
  deferred container tier.
- **Rejected** — RLM's celebrated `run_code` escape hatch; any boundary
  that is guardrail-only (NOOA is explicit that its AST validators are not
  the boundary).
- **Deferred** — container/VM backends; GPU/accelerator-bearing sandboxes;
  the full Linux ruleset construction (the spike stops at the fail-closed
  probe since deno-pyodide is the shipping boundary).
