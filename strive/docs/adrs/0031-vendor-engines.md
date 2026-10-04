# ADR-0031: Vendor engines: Claude Code and Codex run a session's turns, gated by the daemon

Status: accepted (2026-10-03). The Claude Code engine is built (see "As built"); Codex, strict mode and isolation are not. Stage 3 ("Reach").

## Context

strive's own loop (pi-agent-core in the host) runs every session. Stage 3
plans vendor engines: a session whose turns Claude Code or Codex run, with
strive's budgets, journal, learning and review around them. Then "how does
strive compare to Claude Code?" becomes an experiment in which the engine
is the only thing that changes.

We surveyed how serious embedders do this (NOTES, 2026-10-03):
- Zed and its ACP adapters, Vibe Kanban, Happy, Crystal, Sculptor and
  Terragon;
- Harbor and Prime Intellect's verifiers;
- the Claude Agent SDK and Codex's app-server.

They converge:
- **The vendor runs its own tools.** Zed's Claude adapter replaced Read,
  Write, Edit and Bash with tools served by the editor from Sept 2025 to
  Feb 2026, then reverted: the model behaves best with the tools it was
  trained on. No current orchestrator replaces them all.
- **The host gates every call** through the vendor's structured channel:
  the SDK's `canUseTool`, Codex's app-server approval requests, ACP's
  `request_permission`. The strongest, Prime's verifiers, make every call
  ask (`permissions.ask: ["*"]`) and add a `PreToolUse` hook that fails
  closed. Codex otherwise asks only when a command leaves its sandbox.
- **Isolation** comes from git worktrees (desktop apps) or containers and
  VMs (cloud services and benchmarks).
- **Cost and traces** come from pointing the vendor's model endpoint
  (`ANTHROPIC_BASE_URL`, `model_providers.*.base_url`) at a proxy. The
  vendor's own cost figure is an estimate.

## Decision

### An engine is a session's, chosen when it starts

`session/create` takes `engine`: `native` (the default), `claude-code` or
`codex`. `sessionStarted` records it, so a resumed session keeps its
engine, and `strive --engine claude-code`, `strive run --engine` and the
desktop's new-session menu choose it. The engine runs in the session's
host, in place of pi-agent-core. The host stays untrusted: it holds no
keys and decides nothing.

### Through the vendor's official channel

- **Claude Code:** the Claude Agent SDK (`query()`), in the TS host. Its
  own session is resumed by its id, which the journal keeps.
- **Codex:** `codex app-server` (JSON-RPC over stdio), started by the host.
- **Neither:** a PTY or screen-scraping. ACP adapters are one hop more,
  and the vendors' own channels are what the adapters sit on.

### The model calls go through strive's gateway

The vendor's base URL is the session's gateway URL (`strive gateway`), so:
- every model call is reserved against the session's budget before it's
  sent;
- the exact request and response bytes are journaled.

No embedder in the survey has this. They read the vendor's own estimate
after the fact. The vendor's built-in limits (`maxBudgetUsd`, max turns)
are set too, but only as a second line.

### The vendor runs its tools; the daemon gates every call, failing closed

Each tool call, reads included, asks the daemon before it runs:
- **Claude:** permissions `ask: ["*"]` and `canUseTool`. The host forwards
  each call to a new `effect/observe` and answers with the daemon's
  decision.
- **Codex:** its approval requests, plus a `PreToolUse` hook, because Codex
  asks only when a command leaves its sandbox.
- **For both:** a `PreToolUse` hook that runs `strive hook pre-tool`
  against the daemon refuses the call if the daemon doesn't answer, so a
  host that dropped the callback still can't let a call through.

The daemon decides as it does for its own effects:
- the approval mode;
- "What shapes a session" (guarded files ask a person in every mode);
- strive's hooks (ADR-0028);
- safe mode;
- a person, when one is asked.

Its decision is journaled before the vendor runs anything.

### Journaled as observed, and labelled as such

A vendor tool call is an effect with a new record kind, `observed`:
- **what's recorded:** the engine, the tool's name, and its input (by
  digest);
- **sequence:** `effectStarted`, then `effectCleared` if allowed, then
  `effectFinished` with the output a `PostToolUse` hook reports;
- **the label:** reviews, the learner's view and `strive log` say
  "observed", because strive didn't perform it.

Crash reruns (ADR-0030) never apply to observed effects.

### Sandboxed by the vendor; files guarded by strive's checkpoints

- **Claude:** the SDK's `sandbox` setting, on. It uses the same Seatbelt
  and bubblewrap as strive's.
- **Codex:** `workspace-write`, with no network.
- **Checkpoints:** strive still takes one before each prompt. It snapshots
  the whole worktree, so the vendor's edits are in it, and `/rewind`, forks
  and the changes view work unchanged.

### Learning carries over

A vendor session's journal has the prompts, replies, tool calls and their
outcomes, so the learner studies it like any other, and review works
unchanged. What's learned reaches the vendor through what it already
reads:
- `AGENTS.md` and `CLAUDE.md` it reads itself;
- strive's memory and path rules are appended to its system prompt (the
  SDK's `systemPrompt.append`, Codex's instructions);
- skills are offered where the vendor has them.

### Later: a strict mode

For when one authority over effects matters more than fidelity:
- the vendor's tools are switched off (`tools: []`, Codex `shell_tool =
  false`);
- strive's own are offered as an MCP server, or through Codex's
  `dynamicTools`;
- every effect is then strive's own, and only observed effects are gone.

It's a setting, off by default, because of Zed's experience.

### Isolation: designed for now, built later

A session runs in a *place*, today the person's directory. The engine and
the effect gate don't assume which. Worktrees, containers and VMs come in
a later ADR. Each changes only where the vendor (or strive's own effects)
runs and what checkpoints snapshot, not how calls are gated or journaled.

## Which parts should hold up for future agents

As agents run longer, more autonomously and more of them at once, some
parts of this design gain value and others lose it.

**Gain:**
- **The model-endpoint proxy.** Whatever the harness, it calls a model API
  over HTTP. Budgets enforced before the call, exact traces and evals all
  hang off it, so it is strive's most durable lever, for any engine.
- **Isolation as the real boundary.** When a person can't approve each
  call of a day-long run, safety moves from prompts to boundaries: a
  worktree, container or VM the agent can wreck freely, with a snapshot to
  return to. Per-call gating stays, but as policy (guarded files, hooks,
  network) rather than a person's click.
- **Journal, checkpoints and forks.** Review after the fact, rollback and
  "try it again from here" matter more as fewer steps are watched live. A
  fork plus a worktree (or container) is the natural unit of parallel work:
  many agents from one point, each in its own place, compared afterwards.
- **Waits that outlive the process.** A long run's permission request, or
  a child agent's request for more budget, should be a journaled pending
  decision that a person answers later, even after a restart. The run
  stays parked meanwhile, rather than holding a connection open.
  tardigrade's deferred durable promises do this (NOTES). strive's
  approvals are journaled but wait in memory today.
- **Bounded recovery.** An unattended session that keeps crashing should
  park as blocked after a budget of recovery attempts with no progress,
  and not be restarted forever (tardigrade's watchdog).
- **Fidelity to the vendor's tools.** Models are trained more and more on
  their own harness's tools. Replacing them fights that training, so
  observe, gate and isolate ages better than replace.

**Lose:**
- **Per-call human approval** as the main control: too slow for many long
  runs. It narrows to the calls policy flags.
- **Screen-scraping and PTY wrappers:** brittle across vendor releases.
  Structured channels (the SDK, app-server, ACP) are where vendors invest.
- **Exactly-once effects inside the vendor's tools:** strive can't promise
  this for tools it doesn't run. For long runs, the snapshot of an
  isolated place (container checkpoint, VM snapshot, worktree commit)
  becomes the unit of recovery instead.

So the plan is ordered by how long each part lasts: the gateway and
journal first, then gating, then isolation, with strict mode for
high-assurance work.

## As built: Claude Code (2026-10-03)

Built as decided, with these differences:
- **The engine is its own event,** `engineSet`, journaled by the daemon
  after `sessionStarted`, not a field of it. A native session journals
  nothing, so older journals read the same.
- **The fail-closed backstop is in the host, not a hook.** Claude Code runs
  `PreToolUse` hooks before its permission check, so a hook can't tell
  whether the daemon cleared the call. Instead, a tool result for a call
  the daemon never cleared fails the turn, unless it is the error result
  Claude Code gives for a call the daemon refused. The daemon's journal shows the
  gap either way: an observed effect is started before it can be cleared.
- **The sandbox must still ask.** By default Claude Code runs a sandboxed
  command without asking (`autoAllowBashIfSandboxed`), past `canUseTool`.
  The host turns that off, and refuses unsandboxed retries.
- **Outputs come from the SDK's tool-result messages,** reported with
  `effect/report`, not from a `PostToolUse` hook. A second report of one
  call is refused.
- **None of the person's Claude settings apply** (`settingSources: []`),
  and its transcripts live in the session's directory (`CLAUDE_CONFIG_DIR`),
  so it resumes its own session. Web search is off: it runs at the
  provider, and the gateway refuses it.
- **How the daemon gates a call:**
  - reads, writes and edits go through the same gate as strive's own;
  - a command follows the approval mode alone, since it runs in Claude
    Code's sandbox, not strive's;
  - plans, to-dos and subagents are allowed, because a subagent's own
    calls are gated one by one;
  - any other tool, such as a web fetch, asks unless the mode is full-auto.
- **Which Claude Code runs:**
  - `STRIVE_CLAUDE_CODE`, if set;
  - otherwise the one the SDK pins, when the host runs from source;
  - otherwise the `claude` on the path. The installed `strive-tui` doesn't
    bundle Claude Code's 229 MB native binary.
- **Not built yet:** the desktop's and ACP's engine choice, the vendor's own
  budget limit as a second line, forks of an engine session (its own
  transcript isn't forked), Codex, strict mode and isolation.

## Consequences

- A strive session can be run by Claude Code or Codex with the same
  budgets, journal, checkpoints, forks, learning and review. The only
  difference is that tool calls are observed, not performed.
- strive can compare engines on the same tasks (Harbor, the eval) with
  everything else held fixed.
- The vendor CLIs and SDKs become pinned dependencies, and their protocols
  change often. The SDK and app-server are the stable surfaces, but expect
  upkeep.
- Until isolation lands, a vendor engine has its own sandbox and strive's
  gate, not strive's sandbox.
