# Handoff to Astra — clean-slate rebuild of `strive`

**You (GPT‑6 Astra) are leading a non‑backward‑compatible redesign and rebuild of
`strive`.** You own the design and the code. This document is your mission brief;
it was prepared by a Claude Code session that set up the branch and guardrails.
There is no backward-compatibility requirement — you are free to tear out and
replace as much as you judge right, provided the result is durable, verifiable,
resumable, and secure (see "Invariants" below).

## Where you are

- Repo: `/Users/nikhil/personal/hatch` (a monorepo of independent projects).
- Your target project: `strive/` (Python, `uv`-managed, requires Python ≥3.12).
- **Branch: `strive-astra`** — do all work here. It was cut from
  `strive-vnext-phaseB`, which holds an in-review PR (#51). **Do NOT touch,
  rebase, or force-push `strive-vnext-phaseB` or `main`.** PR #51 must stay
  intact; your rebuild is a separate line of work with its own future PR.
- Commit on `strive-astra` as you go with clear messages. Do not open/merge a PR
  until the human asks.

## What `strive` is today (grounding — read before designing)

strive = "durable mechanisms for model-led adaptation": a policy-neutral,
revision-native substrate that lets a policy apply/observe/checkpoint/revert
EXACT composite changes to allowlisted surfaces, with comparative evaluation as
an OPTIONAL mechanism a policy requests — never a universal gate.

Read, in order:
- `strive/README.md` — the idea and the CLI.
- `strive/docs/ARCHITECTURE.md`, `strive/docs/ROADMAP.md`, `strive/docs/adrs/`,
  and `strive/docs/HANDOFF.md` — the current design + rationale.
- `strive/docs/archive/` — the superseded promotion-era design (context only).
- `strive/src/strive/` (~23 modules) — notably `substrate.py` (event/CAS store +
  pure verifier), `kernel.py` (resumable policy kernel), `sandbox*.py`
  (secure candidate execution), `operate.py` (CAS-backed operation-plan
  mechanism), `policy.py` + `policies/continual_refine.py` (the continual,
  model-led refinement policy), `runtime.py`/`contracts.py`/`codec.py` (typed,
  versioned, content-addressed records).
- `strive/NOTES.md` — the running log of the last several build rounds; useful
  for what was hard and why. You may start a fresh section rather than append.

Current gates (keep these green as you rebuild, or replace them with equivalents
you defend): `uv run pytest`, `uv run mypy` (runs `--strict`), plus the
installed-wheel CLI smoke (`tests/test_packaging.py`) and the fresh-interpreter
test (`tests/test_substrate_only.py`). Bring up the environment with `uv sync`;
exercise the CLI with `uv run strive …`.

## Invariants to preserve (the point of strive; keep these properties, not the code)

1. **Durable + exactly resumable.** Model-led change is journaled so a crash mid-
   operation reconciles deterministically (no duplicated effect or spend); a
   resumed run reconstructs the same state.
2. **Verifiable.** State and effects are content-addressed and checked by a
   pure/closed verifier; forged/inconsistent records fail closed.
3. **Secure floor.** Model-authored code runs only under a mechanically-secure
   sandbox; the framework never trusts model output for integrity/budget.
4. **Policy-neutral + model-led.** The substrate does not decide whether a change
   is "good"; a policy does. Preserve immediate model-led adaptation and keep
   optional comparative evaluation (`EvaluateFork`) as a policy choice — do NOT
   introduce Pareto search or a universal promotion gate.
5. **Behavioral evidence gates.** Only valid, comparable, policy-visible
   operational evidence drives adaptation/review; infrastructure failures and
   hidden/held-out data can never steer the model.

You may radically change HOW these are achieved (schemas, module boundaries,
execution model, even the substrate) — just do not regress the properties.

## Your workflow

1. **Ground + SOTA research (do this first).** Skim the design above, then survey
   the current (Sept 2026) state of the art for self-improving / continual-
   refinement agent systems and the substrate patterns behind them. Leads worth
   checking (not conclusions): GEPA; ADAS / meta-agent-search; DSPy optimizers
   (MIPRO); Darwin-Gödel-machine-style self-modifying agents; durable-execution /
   event-sourcing substrates (Temporal-style, append-only + CAS). Extract what a
   vNext strive should adopt, discard, and add. Cite sources.
2. **Propose the design + open questions, and get a human go/no-go BEFORE any
   destructive teardown.** Write the proposed non-backward-compatible architecture
   (components; how each invariant above stays satisfied; what gets torn out) and
   your top open questions to `strive/docs/ASTRA_DESIGN.md`. Ask the human to
   approve before you start deleting/replacing — the teardown is the irreversible
   step. Ask questions liberally throughout; do not guess on consequential calls.
3. **Rebuild iteratively, staying green.** Land the redesign in reviewable
   milestones. After each: `uv run pytest`, `uv run mypy`, and the wheel/fresh-
   interpreter smokes; a `uv run strive …` smoke where relevant. Keep the tree
   green (or clearly mark WIP). Update `README.md`/`docs/`/`NOTES.md` to the new
   design as you go.

## Guardrails (please honor)

- Work only on `strive-astra`; never force-push; never touch `strive-vnext-phaseB`
  or `main`. Keep PR #51 intact.
- Confirm with the human before the first teardown and before any action that is
  hard to reverse.
- Keep the security floor and the invariants above; if you want to relax one,
  raise it as an explicit design question first.

## Note on running you as `gpt-6-astra`

Codex CLI is 0.153.4 and Codex is now authenticated with an **OpenAI API key**
(`provider: openai`), so `gpt-6-astra` runs (verified: a probe returned READY at
`model: gpt-6-astra`). Select it per run with `-m gpt-6-astra`; API-key usage
bills at API rates. NOTE: this replaced the prior ChatGPT-account login globally
— to restore ChatGPT login later, run `codex login`. (`gpt-6-astra` is rejected
on ChatGPT-account auth, which is why the API key is in use.)

— End of handoff. Start with step 1; write your design to
`strive/docs/ASTRA_DESIGN.md` and wait for go/no-go before tearing anything out.
