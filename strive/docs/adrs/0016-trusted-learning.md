# ADR-0016: Trusted learning (Stage 2)

Status: accepted. The protocol types are in `crates/proto`; the daemon and
the learner are built against this document.

## Context

Stage 1 made strive a usable agent: every step is journaled, money is
reserved before it's spent, commands run sandboxed, and the files can be
rewound. Stage 2 makes it learn from use. What shipped products and
research show (see the plan, "What the frontier tells us"):
- **Learning happens in context:** memory files and skills, not weights.
- **Monolithic rewrites and self-feedback drift:** an agent editing its own
  instructions unchecked degrades them (ACE, SkillLearnBench).
- **Checks inside the candidate's reach get disabled:** DGM removed its own
  hallucination checks.
- **What makes a proposal trustworthy:** evidence from raw traces
  (Meta-Harness), a falsifiable prediction checked later (AHE), and
  per-change history with scoped rollback (SkillHone).

strive's wedge: every learned change is a reviewable proposal with its
evidence and prediction, checked by the daemon (outside the learner's
authority), and applied or undone only by a person.

## Decision

### The learner is the host of a learning session

- **One learning session per project** (per work directory): a session like
  any other, marked `kind: learning` in its `SessionStarted` entry.
  `learning/open {cwd}` finds or creates it. Work-session lists leave it out.
- **Its agent host runs the learner.** `host/register` returns
  `AgentConfig.kind = learning`, and the host switches from the coding agent
  to the learner: another system prompt, other tools.
- **Everything else is reused:**
  - model calls go through the gateway and count against the learning
    session's budget;
  - it has one host, subscribers, interrupts, time limits;
  - the journal makes its history tamper-evident.
- **The learner has no effect tools.** It reads:
  - work sessions of the same project, through `session/read` and `blob/get`;
  - the current memory and skills, which come in its `AgentConfig`
    instructions and skills.

  It can't change a file or run a command. Its only output is a proposal.

### A request is a prompt

- **Asking:** `learning/run {cwd, sessions?}` journals `LearnRequested` in
  the learning session and starts its host.
- **The learner's turn:** the host takes `LearnRequested` like a
  `userMessage`, as the prompt of a turn. It reads the named work sessions,
  or those it hasn't studied yet: work sessions of the project whose
  entries are newer than the last `LearnRequested` it handled.
- **Proposals:** it records each proposal as a `ProposalMade` host record,
  and ends the turn.

### A proposal is a whole file

- **What it names:**
  - an artifact: `memory` is `.strive/memory.md`; a `skill` is
    `.strive/skills/<name>/SKILL.md`, inside the project;
  - the file's whole new `content`;
  - a one-line `summary` and a `rationale`;
  - `evidence`: sessions, entry seqs, a note;
  - a `prediction`: a falsifiable claim.
- **Why whole files:** memory and skills are small, and a whole file can be
  checked, shown as a diff, and undone exactly.
- **Its id is its entry's seq** in the learning session.
- **Loading:** `.strive/memory.md` is loaded as an instruction file after
  AGENTS.md/CLAUDE.md, labeled as reviewed memory. Skills are already loaded
  from `.strive/skills`.

### Checks: the daemon's, in a cascade

The daemon journals a `GateFinished` for each check it runs.
1. **`static`** (M7, in the daemon, run on `ProposalMade`), cheap and
   certain:
   - **Path:** the artifact resolves inside the project's `.strive/`
     (skill names are 1–40 of `[a-z0-9-]`).
   - **Size:** memory ≤ 16 KiB, a skill ≤ 32 KiB.
   - **Form:** a skill starts with `---` frontmatter naming itself and
     describing when to use it.
   - **Secrets:** API-key and private-key patterns, and anything from
     strive's credentials.
   - **Hidden text:** invisible or direction-changing characters (zero-width,
     bidi controls, tag characters) anywhere a person reads the proposal.
   - **Weakening strive:** instructions to bypass approvals or the sandbox,
     to change strive's own state or settings, or to ignore the user;
     pipe-to-shell installs; role tags posing as a system or model turn. Fullwidth letters are read as ASCII.
   - **Evidence:** it must name sessions that exist in this project.
2. **`judge`** (M9): a model the learner doesn't control scores the
   proposal against work sessions the learner wasn't shown. It runs in the
   daemon's own call, under the learning session's budget, with a fixed
   rubric. A fail blocks acceptance; a skip (no key, no held-out sessions)
   is shown as such.
   [ADR-0017](0017-judge-gate.md) records how it is built.
3. **`replay`** (M10): tasks mined from past sessions with checkable
   outcomes are run again with `strive run`, with and without the change.
   Three runs each, and the difference is reported.

A proposal is `ready` when every check that ran passed or was skipped, and
`failed` when one failed. Only a `ready` one can be accepted.

### A person decides; the daemon writes

- **Only a person decides:** `proposal/decide {cwd, proposal, accept|reject}`
  is refused for the learning session's host, as approvals are.
- **Applying:** on accept, the daemon checks the file is still as it was
  when the learner read it, i.e. as it was when the proposal was made
  (`ProposalMade`'s entry time; the daemon keeps the file's digest from
  then).
  - If so, it writes the new content with a pinned write and journals
    `ProposalApplied {before, after}` (digests into the content store).
  - If not, the proposal is `stale`: nothing is written, and the learner
    can propose again against the current file.
- **Rolling back:** `proposal/rollback` restores `before` (or removes a file
  that didn't exist) if the file is still `after`, and journals
  `ProposalRolledBack`.

### Surfaces

- **`strive learn [--session ID]...`** requests a run and shows it as
  `strive run` shows a turn, then lists what was proposed.
- **`strive review`** lists proposals with their status.
  - `strive review <id>` shows the diff, evidence, prediction and checks.
  - `strive review <id> accept|reject|rollback` acts on one.
- **The desktop** gets a "Learned" pane that lists the same (M8b).

## Milestones

- **M7 Proposals** (daemon):
  - the learning session and `learning/open`/`learning/run`;
  - accepting `ProposalMade` host records from a learning session's host
    only;
  - the static gate, `proposal/list`/`decide`/`rollback`, apply with
    stale-detection, loading `.strive/memory.md`;
  - `strive review`, and `strive learn`'s request and display.
- **M8 Learner** (host):
  - learning mode in `packages/host`: the system prompt, and the
    `list_sessions`, `read_session` and `propose_change` tools;
  - evidence selection within a token budget;
  - tests against the real daemon with a scripted model.
- **M8b Desktop:** the Learned pane.
- **M9 Judge gate.**
- **M10 Replay gate:** mining tasks with checkable outcomes.
- **M11 Predictions checked, and drift:**
  - predictions checked against later sessions;
  - a watch for quality that peaks and then declines;
  - rollback scoped to what regressed.
- **Triggers:** end of session, every N turns, and idle-time consolidation.
  These come after M8, behind the `learning` setting (`off`, `suggest` by
  default, `gated`, `auto`).

## Consequences

- **The learner can't reach its own checks:** they run in the daemon, and
  the learner has no effect tools. This is the DGM lesson.
- **Every change can be traced:** its evidence (seqs in authenticated work
  journals), the checks it passed, who accepted it, and how to undo it are
  all in the learning journal.
- **Learning costs money like anything else:** it has the learning
  session's budget and shows up in `strive log`.
- **Memory is a project file:** `.strive/memory.md` can be committed and
  shared, or ignored. strive neither commits it nor adds it to `.gitignore`.
- **A work session can't skip review:** its `write` and `edit` of memory or
  a skill ask a person in every approval mode, and the macOS sandbox denies
  commands writes there (Linux: where the files exist; `sandbox: off`: not
  at all). An editor or git still can, and `strive review` lists such a file
  as changed outside review.
