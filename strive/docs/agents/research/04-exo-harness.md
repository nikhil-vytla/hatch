# 04 — exo (exoharness)

## Provenance

- **Repo:** https://github.com/exoharness/exo (MIT license, `LICENSE`)
- **Commit examined:** `8f7886661e41957a1d4909c1538cc720c9bbd740`
  ("discord: give every message create an enforced nonce (#196)", 2026-08-03)
- **Retrieved:** 2026-08-06, cloned to `/tmp/strive-research/exo` (shallow,
  depth 50; HEAD SHA is exact)
- **Availability caveats:** the repo is public and this is the correct project
  (an agent harness for recursive self-improvement) — *not* `exo-explore/exo`,
  the distributed-inference project. All findings below were verified against
  source and checked-in docs at the SHA above; the codebase is ~53k lines of
  Rust across four crates plus a TypeScript harness layer, with 248 Rust
  `#[test]`/`#[tokio::test]` functions and ~145 TypeScript test cases, run in
  CI (`.github/workflows/ci.yml`, `integration.yml`). The message-format
  dependency "Lingua" is from braintrustdata, and tracing goes through a
  Braintrust SDK (`crates/executor/src/braintrust.rs`), suggesting Braintrust
  affiliation; not verified beyond the code. Nothing in this report is from
  the README alone.

## Source-supported facts

**What exo is.** A "systems approach to recursive self improvement": a
complete agent harness (tools, adapters, scheduler, sandboxes) whose defining
property is that the agent has full read/write access to its own source code
and runtime logs, plus tools to rebuild, restart, snapshot, and rewind itself
(`README.md`, `docs/RSI.md`). The one thing the agent must not erase is the
append-only event log — "a canonical history of what it's tried to prevent
getting stuck in recursive loops" (`README.md:31-33`, `docs/RSI.md:39-46`).

**Layering (the "exoharness" concept).** `docs/spec.md` splits a harness into
two layers:

- The **exoharness** — a trusted, non-semantic substrate owning agents,
  conversations, sessions, turns, append-only events, versioned artifacts,
  sandboxes, bindings, and secrets. It deliberately *cannot* call an LLM.
  Implemented in `crates/exoharness/` (traits in `types.rs`, filesystem
  implementation in `basic.rs`, JSONL protocol in `protocol.rs`/`server.rs`,
  HTTP transport in `http/`, `docs/exoharness-http.md`).
- The **executor** — owns semantics: prompt assembly, model calls, tool loop,
  compaction/memory policy. Implemented in `crates/executor/` with three turn
  runners: a basic LLM loop, an "RLM" loop (`rlm.rs`, JS-VM-based), and a
  TypeScript harness host (`typescript.rs`) that runs a persistent Node
  process per harness module and speaks line-delimited JSON over stdio
  (`docs/design/exoharness-arch.md`).

The default agent, "Exo", is a TypeScript harness module
(`examples/exo/harness.ts`) composing prompts (`examples/exo/prompts/me.md`,
`.exo/exo-profile.md`) and tool registrations on top of that substrate.

**Event log.** Events are append-only, one JSON file per event named by
UUIDv7 id (`append_events_to_conversation`,
`crates/exoharness/src/basic.rs:3884-3936`), with sortable-timestamp ordering
and an optimistic-concurrency head check (`ensure_conversation_head`, which
rejects stale turns with "turn is stale and cannot be resumed",
`basic.rs:3938-3985`). Event kinds include `session_started/ended`,
`turn_started/ended`, `messages`, `tool_requested`, `tool_result`,
`artifact_written`, `sandbox_created/started/stopped/snapshotted`,
`thread_forked`, and namespaced `custom` events
(`crates/exoharness/src/types.rs:275-320`). Host components write into the
same log via `custom` events: `host_reboot`, `adapter_runner_started`,
`adapter_runner_draining`, `rebuild_and_restart_exo` outcome records
(`examples/exo/docs/SELF-CONTROL.md` §2, `examples/exo/SELF.md:113-121`).
A single per-process async write lock serializes writes; subscribers are
in-memory only (`docs/design/exoharness-arch.md` "Storage Implementation").

**Conversation fork ("time travel").** `ConversationHandle::fork` copies all
events up to an optional `up_to_inclusive` event id into a new conversation,
re-iding every event, and also copies bindings, secrets, artifacts, and
sandbox metadata (`crates/exoharness/src/basic.rs:2376-2440`). `docs/spec.md`
("Time travel") states the design intent: the entire agent state is a version
of the event log, so any point can be rewound or forked.

**Sandboxes and snapshot/rewind.** Sandboxes are conversation-scoped records
(image, mounts, network policy, idle timeout, latest snapshot id) with
pluggable backends: Docker, Daytona, E2B, Sprites, Vercel, AWS AgentCore, and
a local-process bridge (`crates/exoharness/src/sandbox.rs`,
`sandbox_provider/mod.rs`). Snapshots capture the container filesystem
(Docker: `docker commit -p` + `docker save`) into harness storage as
`manifest.json` + `payload.bin`; restore boots a fresh container from the
saved image, and a snapshot from one backend can be restored on another
("teleport", Docker → Daytona) (`docs/sandbox-snapshots.md`, tests
`crates/cli/tests/snapshot_round_trip.rs`, `teleport_docker_to_daytona.rs`).
Explicit non-goals: not a process/memory checkpoint, not a conversation
rewind, no snapshot GC (`docs/sandbox-snapshots.md` "What this is not",
"Known limits"). Network access is a per-sandbox `SandboxNetworkPolicy`
(`sandbox.rs:72-82`).

**Self-modification path.** The repo is mounted into the sandbox at
`/workspace/exo`; the agent edits its own code with the `shell` tool, then
calls the model-visible `rebuild_and_restart_exo` tool
(`examples/exo/guardian-tools.ts`). That tool durably records an update
intent (`.exo/guardian-updates/<id>.json`, written atomically via
temp-file+rename, `guardian-tools.ts:81-165`), spawns a detached deferred
process so the current turn can finish, then a host-side "guardian"
supervisor (`examples/exo/scripts/exo-service-guardian`) runs `cargo build`
(`exo-service-guardian:116-118`) and restarts scheduler/adapter services with
a graceful drain protocol (restart marker files; runners claim the marker,
finish in-flight work, and exit; unresponsive runners are process-tree-killed
after a wait) (`SELF-CONTROL.md` §1). The rebuild outcome (succeeded/failed,
exit code, tool `reason`) is appended to the event log. A checked-in "self
map" (`examples/exo/SELF.md`) is injected each turn via `EXO_SELF_MAP` so the
agent can navigate its own code before changing it.

**Trusted core, by policy.** `docs/RSI.md:44-46` states the exo-harness "is
the only part of Exo which cannot be modified by the agent", but footnote 2
concedes this is *policy, not enforcement*: "The system technically allows
it, but to provide safer standard usage, it's disallowed on the default
configuration." The repo mount includes `crates/exoharness` itself.

**Memory.** `remember`/`forget` tools back a single agent-scoped JSON
artifact (`memory/exo-memory.json`); the whole store is injected into every
prompt (deliberately not embedding retrieval), with hard caps of 200 entries
and 600 chars per entry (`examples/exo/memory-tools.ts:20-130`,
`SELF-CONTROL.md` §2). Skills (SKILL.md format) are a second durable surface
stored as versioned agent artifacts; only names/descriptions are injected per
turn, bodies load on demand (`SELF-CONTROL.md` §5,
`docs/design/skills-arch.md`).

**Tools.** Two-layer architecture: TypeScript definitions are what the model
sees (registered fresh each turn); execution either stays in TypeScript or
delegates to a Rust `execute_tool` dispatch
(`crates/executor/src/harness_tool.rs`; ~38 match arms including
`schedule_sandbox_task`, `snapshot_sandbox`, `rewind_sandbox`). Tool schemas
are validated (name charset/length, `additionalProperties: false`)
(`docs/design/exoharness-arch.md` "Tool API"). Large tool results are
compacted: preview text in the message history, full output written to
versioned artifacts under `tool-results/...`.

**Scheduler and adapters.** Executor-level services, not substrate concepts.
The scheduler runs recurring or one-shot sandbox tasks on a fixed grid with
explicit missed-fire policies (drop / one catch-up / fire all)
(`docs/EXO-BASICS.md` §Scheduler, `crates/executor/src/scheduler_runtime.rs`,
`scheduler_store.rs`). Adapters (ExoChat, IRC, WhatsApp, Signal, Discord,
Slack, agent-cli) are long-running host worker processes with their own
durable stores, health fields (`last_connected_at_ms`, `last_error`) and
telemetry event history (`list_adapter_events`). Both wake conversations
through a per-conversation wakeup lock and the executor `send()` API
(`docs/design/exoharness-arch.md` "Scheduler/Adapter Integration",
`crates/executor/src/conversation_wakeup.rs`).

**Secrets and budgets.** Secrets are encrypted at rest with AES-256-GCM under
a master key from Apple Keychain, a 0600-permission file, or a static test
key (`crates/exoharness/src/secrets.rs`), scoped root/agent/conversation with
local-scope override, and can be mounted into sandboxes without the LLM
seeing them (`docs/spec.md` "Binding and secret"). The only execution budget
is a configurable per-turn tool round-trip cap (`assertRoundBudget`,
`typescript/harness/index.ts:407-418`). Token usage and latency are recorded
per message; dollar cost is computed in "userspace" from the LiteLLM price
database, and the design doc explicitly flags that usage is *self-reported by
the agent-side process and therefore not trustworthy as a ledger*
(`docs/design/cost-tracking-design.md`, `crates/cost/`).

**Self-verification and rollback (state of practice).**
`examples/exo/docs/SELF-CONTROL.md` §8 is candid: verification "exists as
practice and primitives rather than as a single tool" — snapshot/clean-git
before a change, run `cargo`/`pnpm` checks in the sandbox, rebuild/restart,
observe the reboot wakeup and event log; roll back via `git revert`,
`rewind_sandbox`, `manage_tool`, `disable_adapter`. Named gaps in the same
doc: no sandbox *cloning* (try a change in a copy while the original runs),
no canary path ("run the changed build against a cloned sandbox or forked
conversation and compare behavior before adopting it on the live instance,
instead of validating on the only copy of itself"), and cloning/migration of
the whole agent is "not yet built" (§7) — the README's "manage a lineage of
clones" is aspiration; the existing building blocks are conversation `fork`,
sandbox snapshots, and a proposed `cloned_from` custom event
(`SELF-CONTROL.md:176`).

## Analysis dimensions

### Runtime, task, environment, and state models

Addressed extensively. Hierarchy: agent → conversation → session → turn →
events (`docs/spec.md`). Four handle types (`ExoHarness`, `AgentHandle`,
`ConversationHandle`, `TurnHandle`) with turn-scoped writes preserving turn
ownership in the log. Environments are pluggable sandbox backends with a
warm-container cache keyed by `SandboxKey`. There is no discrete "task"
abstraction with expected outputs — tasks are either user turns or scheduled
sandbox commands with a `reportPrompt`; nothing defines success criteria.

### Observation, trajectories, traces, memory, persistence

Addressed; this is exo's strongest area. Every message, tool request/result,
artifact write, sandbox lifecycle change, and host lifecycle action lands in
one append-only per-conversation event log the agent can query back
(`list_conversation_events`), with UUIDv7 ordering, cursor pagination, and
kind filters. The durable conversation deliberately does not equal the prompt
— executors send derived slices while the raw log stays queryable
(`docs/spec.md` "Execution model"). Memory is a capped, fully-injected JSON
artifact; skills are lazily-loaded artifacts; the state-survival matrix in
`SELF-CONTROL.md` §2 documents exactly what survives sandbox rewind vs
service restart vs rebuild.

### Trusted/immutable vs evolvable surfaces

Addressed, with a crucial caveat. Trusted: the exoharness substrate (state,
events, secrets, sandboxes) and the append-only property of the log.
Evolvable: everything else — prompts, tools, adapters, scheduler, executor
code, even the Rust harness runtime — because the whole repo is mounted
read-write in the sandbox. The boundary is *policy enforced by prompt and
default configuration, not by mechanism* (`docs/RSI.md` footnote 2). Contrast
with strive, where trusted surfaces are outside the evolvable artifact's
reach by construction.

### Recursive decomposition, subagents, context management

Mostly not addressed by source as implemented. Multi-agent orchestration and
cloning policy are listed under "Ongoing Work" (`README.md:252-257`); the
substrate supports multiple agents and conversation fork, but there is no
subagent spawning or task decomposition mechanism in the default Exo agent.
Context management: full history replay per turn with tool-result compaction
into artifacts; compaction policy is explicitly delegated to executors via
custom events (`docs/spec.md` "Event").

### Candidate generation and self-modification

Addressed as unconstrained code editing. The agent generates changes by
editing its own mounted source with `shell`, then activates them with
`rebuild_and_restart_exo` (build = the only automatic gate; the guardian runs
`cargo build`, not tests). There is no diff/patch schema, no proposal object,
no bounded-change discipline — a change is whatever the model wrote to disk.
Prompt changes follow the same edit→commit→rebuild path (`SELF-CONTROL.md`
§6).

### Evaluation, selection, promotion, rollback, lineage

The weakest dimension, and the docs say so themselves. There is no evaluator,
no acceptance rule, no incumbent-vs-candidate comparison, and no automated
promotion anywhere in the code. "Validation" is the agent choosing to run
`cargo`/`pnpm` checks plus the build gate; adoption is committing to git;
selection is the agent's own judgment. Rollback is real but manual-per-layer:
`git revert` for code, `rewind_sandbox` for filesystem, snapshot-backed
restart events recorded in the log. Lineage exists for conversations (fork
copies events and records `thread_forked`) and for updates (update ids +
reasons in the event log), but agent-level lineage is unbuilt
(`SELF-CONTROL.md` §7-8).

### Sandboxing, secrets, permissions, budgets, recovery

Addressed. Real container isolation (Docker et al.) with per-sandbox network
policy and mounts; snapshot/rewind/teleport across providers. Secrets
encrypted at rest, scope-resolved, mountable into sandboxes without model
visibility. Permissions are coarse: the agent either has a tool or does not;
no per-action approval flow in the default agent. Budgets: tool round-trips
per turn only; cost tracking is telemetry, explicitly not an attested ledger.
Recovery is strong operationally: graceful drain markers, deferred restarts,
reboot notices that wake conversations so the agent announces its own return,
missed-fire policies for scheduled work.

### Online adaptation vs offline optimization

Purely online. Exo is a long-lived agent that adapts in place — edits itself,
rebuilds, restarts, and continues the same conversation history. There is no
offline optimization loop, no benchmark suite driving changes, no
population. (`README.md` "long-lived agents"; "Autonomous self-maintenance"
is future work.)

### Harness adaptation vs model-weight learning

Harness adaptation only, explicitly: "we're focused on recursive improvement
of the agent and not the agent and the underlying model" (`docs/RSI.md`
footnote 1). Model choice is a binding; weights are untouched.

### Genuinely self-improving vs merely persistent/configurable

The honest reading from source: exo is a *self-modifying, fully persistent*
system with an audit trail, but not yet a *validated self-improving* one. It
maximizes the mutation surface (any code, any prompt, any tool) and the
memory of attempts (the log), while the improvement judgment — did the change
make things better? should it be kept? — is left entirely to the model
in-context. `SELF-CONTROL.md` §8's own gap list (no canary, no clone-and-
compare) concedes that changes are validated "on the only copy of itself."
Whether behavior compounds into improvement depends on model quality, which
is the project's explicit Bitter-Lesson bet (`docs/RSI.md:21-26`).

### Mechanisms suitable for a robust, long-lived harness

Verified in code and directly reusable as patterns:

- Append-only event log with UUIDv7 ids, typed kinds, cursor queries, and an
  optimistic head-check for concurrent writers (`basic.rs:3938`).
- Host lifecycle events written into the *same* log as agent events, so "was
  I restarted, when, and why?" is answerable from one place.
- Turn handles: writes tagged with session/turn ids; idempotent `finish()`.
- Tool-result compaction to versioned artifacts (bounded prompt, lossless
  record).
- Durable-intent + detached-execution + journaled-outcome for self-restart
  (`guardian-tools.ts`): the mutation record exists before the mutation runs.
- Drain markers and per-conversation wakeup locks for graceful restart and
  serialized external triggers.
- The state-survival matrix as a documentation artifact (`SELF-CONTROL.md`
  §2).
- Scoped bindings/secrets with local override and at-rest encryption.
- Snapshot payloads as opaque tagged blobs (`SnapshotKind`) so the substrate
  never interprets environment state.

## Interpretations

(Inferences, not statements from the source.)

1. **Exo and strive are complements, not competitors.** Exo built the
   substrate strive's charter calls stages 5-6 (durable memory, online
   adaptation, real sandboxing, recovery) while skipping the thing strive
   built first: the evaluate→diagnose→propose→validate→accept loop. Exo has
   no acceptance rule at all; strive has no durable runtime. Exo's own gap
   list (canary validation, clone-and-compare) is literally strive's core
   loop.
2. **The policy-only trust boundary is a deliberate philosophical stance,
   not an oversight** — maximum evolvability now, betting smarter models make
   guardrails less necessary. For strive's charter (safety, conservative
   acceptance, allowlisted surfaces) this is the anti-pattern to learn from:
   it shows what full evolvability buys (the agent really can add a
   Rust-backed tool end to end) and what it costs (no way to bound the blast
   radius of a bad self-edit except rollback-after-the-fact).
3. **"Prevent getting stuck in recursive loops" is a distinct failure mode
   strive hasn't named.** Exo's justification for log immutability is not
   audit — it's that a self-modifying agent that rewinds state *will repeat
   failed experiments unless the record of attempts survives the rewind*.
   strive's ledger already has this property, but strive's diagnose stage
   does not yet consume rejected-generation history to avoid re-proposing
   failures.
4. **Separating "state rollback" from "history rollback" is the load-bearing
   idea.** Exo rewinds the sandbox (world state) without rewinding the log
   (knowledge). strive's rollback (activating an ancestor generation)
   similarly keeps the ledger. Exo generalizes this to every layer with a
   per-layer rollback mechanism, and documents which layer survives which
   reset.
5. **The self-reported-usage caveat generalizes.** Exo's cost doc admits the
   agent reports its own token usage because model calls happen in agent-side
   code. Any budget or score computed inside the evolvable surface is
   gameable; strive's evaluator living on the trusted side of a process
   boundary is the right call and should stay that way.
6. **Two immutable logs, not one.** Exo treats git as a second append-only
   history (for code) alongside the event log (for behavior). strive
   currently journals strategy source into its own ledger, which is
   equivalent, but the pattern — every evolvable surface needs *some*
   immutable history that mutation cannot erase — is a good invariant to
   state explicitly.

## Hypotheses to test in strive

1. **Rejected-lineage awareness reduces wasted cycles.** Feed the diagnoser/
   proposer the ledger's rejected generations (weakness, patch, outcome) and
   measure whether repeat proposals of failed patches drop, per exo's
   "see what it already tried" claim (`docs/RSI.md:44-46`).
2. **Durable-intent journaling makes risky stage transitions crash-safe.**
   Adopt exo's pattern (write a queued update record before acting, journal
   the outcome after) for strive's accept/activate step; test by killing the
   process between decision and retention and verifying recovery from the
   ledger alone.
3. **Head-check concurrency control is enough for a single-writer loop.**
   Exo's `expected_head` optimistic check is far lighter than locks; test
   whether strive's ledger needs it once background evaluation or parallel
   candidates appear.
4. **Environment snapshot/restore beats fresh-subprocess-per-run once tasks
   get stateful.** strive's tasks are pure functions today; when agentic
   tasks with filesystem state arrive (charter stage 4), test whether an
   exo-style snapshot/rewind of a container beats rebuilding state per
   evaluation, and whether "candidate runs in a restored clone of the
   incumbent's environment" is a workable validation isolation model — the
   canary path exo names but never built.
5. **Event-log-as-prompt-substrate.** Exo shows the durable log and the model
   context can be decoupled (compaction into artifacts). Test whether strive's
   diagnose stage scales better when trace evidence is stored complete but
   summarized/queried, rather than passed whole.

## Mechanisms: early prototype vs mature harness

**Adopt now (cheap, matches strive v0's shape):**

- Durable intent → detached action → journaled outcome for accept/rollback
  operations (exo `guardian-tools.ts` pattern).
- Host/lifecycle events in the same ledger as loop events (strive: journal
  controller start/stop/crash so restarts are visible to diagnosis).
- A written state-survival matrix: which strive state survives process
  restart, ledger rollback, artifact deletion (`SELF-CONTROL.md` §2 as
  template).
- Expose rejected-generation history to the proposer (anti-repetition).
- One shared codec between typed objects and ledger rows — exo's "the store
  round-trips bytes; schema is event data" discipline maps onto the
  HANDOFF.md tech-debt item about ad-hoc dicts.

**Adopt at stage 3-4 (model-in-the-loop and real tasks):**

- Tool-result/trace compaction to artifacts with previews in context.
- `expected_head` optimistic concurrency on the ledger.
- Scoped bindings/secrets with encryption; secrets mounted into sandboxes
  but invisible to the model (needed the moment a model adapter has a key).
- Per-turn round-trip and token budgets enforced on the trusted side.

**Adopt at stage 5-6 (durable memory, hardened harness):**

- Pluggable sandbox backends behind one trait, snapshots as opaque tagged
  payloads, cross-provider restore.
- Graceful-drain restart protocol and wakeup serialization for long-running
  services.
- Conversation/run fork as the mechanism for counterfactual evaluation
  ("replay from event N with a different candidate").

**Do not adopt:** policy-only trust boundary (exo's footnote 2); validation-
by-build-success; whole-store memory injection (fine for exo's 200 facts,
wrong for trace evidence); agent-authored changes activated without an
empirical comparison gate.

## Implications for strive

1. **Keep the trusted boundary mechanical, not conventional.** Exo
   demonstrates the end state of "trusted by configuration": the agent can
   technically edit the substrate. strive's evaluator/ledger/controller must
   remain outside the candidate's write reach by construction (separate
   process, read-only mounts when sandboxing hardens), and the charter's
   allowlist should stay enforced in code (`decide.py` refusing artifacts
   outside declared surfaces), not in prompts.
2. **The ledger should absorb *harness* lifecycle, not just loop lifecycle.**
   Add journaled events for controller start/stop, crash-recovery, and
   config-hash at startup, so "why did behavior change?" is answerable when
   the cause is a restart rather than a generation (exo's
   `host_reboot`/`adapter_runner_started` pattern).
3. **Design the composite-generation problem with exo's per-layer rollback
   in mind.** exo rolls back each surface with a different mechanism (git /
   sandbox rewind / tool registry / adapter disable) and documents survival
   semantics per layer. strive's planned multi-surface generations
   (HANDOFF.md risk 4) should give every evolvable surface its own artifact
   id + activation record so per-surface rollback stays journaled and
   independent, with a composite generation referencing them.
4. **Plan the fork primitive early.** exo's conversation `fork(up_to_
   inclusive)` (copy events, re-id, record provenance) is the substrate for
   counterfactual replay and A/B validation. strive's equivalent — "fork the
   run state at generation G and evaluate candidate X against incumbent Y
   from identical evidence" — is cheap to design into the ledger schema now
   (parent pointers already exist) and expensive to retrofit.
5. **Score and budget computation must never move into the evolvable
   surface.** exo's cost-tracking doc is a worked example of what happens
   when telemetry is produced by the untrusted side: it becomes advisory.
   When strive adds model adapters, journal token usage from the trusted
   adapter wrapper, not from strategy or proposer code.
6. **Name the anti-looping requirement.** Add to strive's diagnoser contract:
   proposals must be checked against the ledger's prior generations
   (same-weakness, same-patch) before validation spend — exo's core
   architectural justification for immutable history, applied to strive's
   loop.
7. **Interface stability lesson.** exo keeps one small substrate API (four
   handles) stable while three different executors (basic, RLM, TypeScript)
   and many products (CLI, scheduler, adapters) compose it. This validates
   strive's charter bet that narrow typed stage interfaces are what let
   implementations grow from stubs to model-backed components without
   rewriting the loop.
