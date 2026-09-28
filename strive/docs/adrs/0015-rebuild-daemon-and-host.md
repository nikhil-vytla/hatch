# ADR-0015: Rebuild strive as a usable agent on a Rust daemon

Status: accepted (2026-09-22). M0 (skeleton) implemented. Supersedes the
Python implementation described by ADRs 0009–0014, which is kept as history
under the git tag `strive-py-final`.

## Context

strive had rigorous mechanisms but no product. Running it required a
hand-authored multi-table manifest, the CLI was wired to a Counter fixture, and
the "actor" was a sandboxed step function rather than a coding agent. The
harnesses people actually use for continual learning (exo, Prime Agent,
Hermes, Letta Code) are daily drivers first. You install them with one command
and start them in any repository without a config file, and learning is on by
default. Research use is the same binary run headless.

Three findings shaped the decision:

- **Formats have converged.** Skills are SKILL.md, memory is AGENTS.md, tools
  are MCP and editors speak ACP. strive should adopt these rather than
  define its own.
- **Gated learning is the open gap.** Shipped products write memory and skills
  ungated or behind human approval only. None runs a comparative, budgeted
  gate in an evaluator the candidate can't touch. That gap is strive's
  reason to exist.
- **Harness desktop apps converge on one daemon with many clients** (Codex
  app-server, opencode server, Goose, T3). A UI spike on 2026-09-22 compared
  Electron, Tauri and GPUI on the same workspace document. Electron alone held
  120 fps while streaming and delivered every token. Tauri was capped at
  60 fps with the highest CPU. GPUI had the smallest footprint but collapsed
  to 24–30 fps from frame pacing.

## Decision

1. **One per-user Rust daemon, `strived`, owns everything that must be
   trusted.** That covers the session journal and CAS, the budget ledger, the
   model gateway and credentials, file and shell effects inside the OS sandbox,
   and checkpoints. The `strive` command starts or attaches to it. An exclusive
   lock file decides ownership, and a build id makes an upgraded binary
   replace a stale daemon.
2. **Everything model-driven runs as a client.** The agent host runs the loop
   (TypeScript on Bun, built on pi-mono's `pi-ai` and `pi-agent-core`, pinned
   and wrapped). Its tool calls are daemon RPCs and its model calls go through
   the daemon gateway, so the loop and its extensions can't bypass budgets,
   the journal or the sandbox. This is the authority separation of earlier
   ADRs, now enforced by a process boundary.
3. **The protocol is JSON-RPC 2.0**, newline-delimited over a private Unix
   socket. Methods are declared once in `strive-proto`, and both the Rust
   types and the TypeScript bindings are generated from that declaration. A
   drift check fails the build when they disagree.
4. **Clients are thin renderers.** They are a TUI (`pi-tui`) for
   `cd repo && strive` and an Electron desktop app. Layout is a declarative
   workspace document that users rearrange and agents edit through reviewable,
   reversible operations. No Node APIs run in the UI path, so another renderer
   (GPUI, Tauri) remains possible.
5. **Integrity is on by default and out of the way.** Budgets, the journal and
   the sandbox need no configuration. Power users reach them through
   `strive log`, `strive verify` and `/budget`.
6. **Learning has modes** (`off`, `suggest`, `gated`, `auto`) per artifact kind
   and scope. The default is `suggest`: the gate runs and a human approves.

## Consequences

- Nothing from the Python implementation is migrated. These principles
  survive: authority separation, policy-neutral adaptation (0008), a
  confinement floor (0012), budgets settled by reservation, and append-only,
  verifiable records.
- There are two languages. The Rust side stays small and boring: storage,
  money, sandbox and network. Generated bindings keep the seam honest.
- The Bun-compiled TUI is ~64 MB, most of it the embedded runtime. The agent
  host should share that binary rather than ship a second runtime.
- The staged roadmap is in [ROADMAP.md](../ROADMAP.md).
