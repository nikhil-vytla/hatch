# Parallax synthesis kernel

Phase D adds one executable vertical slice from a pinned GSM8K record to an
admitted, content-addressed family. It builds static, matched no-change, and
evolved-intent arms from frozen local inputs. It also executes the
`ConversationRun` projection and scores the final response with the source
domain's native answer equivalence.

## Caller API

```python
from pathlib import Path

import parallax
from parallax import EvolvingIntent, Gsm8k

source = Gsm8k.item(
    dataset="openai/gsm8k",
    revision="e53f048856ff4f594e959d75785d2c2d37b678ee",
    split="test",
    item_id="test:0",
    question="...",
    answer="#### 72",
)
family = parallax.build(
    source=source,
    strategy=EvolvingIntent.frozen(Path("proposal.json")),
)

async def model(messages):
    return "#### 72"

result = await parallax.run(family.arm("evolved"), agent=model)
```

The callback receives the full immutable conversation as a tuple of
`ConversationMessage` records. It may return a string directly or an awaitable
string. Parallax invokes it once per scheduled turn and grades only the final
response.

## Lifecycle and module ownership

The immutable record flow is:

`SourceTask -> ProposalBundle -> SynthesisPlan -> RenderedTask ->
AdmissionCertificate -> RuntimeSpec -> Verdict`

Three modules own the implementation:

- `parallax.gsm8k` parses pinned source records, normalizes scalar authorities,
  extracts fenced or final numeric answers, and decides native equivalence.
- `parallax.evolving_intent` parses frozen proposal provenance and compiles the
  closed `StaticPlan | IntentPlan | CheckpointPlan` union. `Reveal`, `Revise`,
  and `Switch` replay against typed state before the source question is copied
  into the terminal turn.
- `parallax.kernel` renders exact public and sealed payloads, admits the family,
  writes locked artifacts, and runs the closed
  `ConversationRun | WorkspaceEpisode | CheckpointSequence` union.

The kernel imports `canonical_bytes`, `digest_value`, and `task_id_for` from
`parallax.ids`. It imports `GradeOutcome` from `parallax.grading`. No second
identity or grading-outcome implementation exists.

## Frozen input and plans

The checked-in proposal format records:

- upstream revision;
- generating model and parameters;
- prompt digest;
- raw response digest or raw sealed evidence;
- seed;
- initial intent state;
- typed events and their exact messages.

There is no runtime generation function. The compiler derives the evolved
precursor turns from those events and appends `source.question` itself as the
terminal anchor. Replay rejects a changed anchor, mismatched event state, a
semantic change in the matched control, or a turn count outside the budget.

The static arm has one complete source turn. Matched and evolved have identical
turn counts and output-token budgets. Matched uses a fixed no-change schedule.

## Identity and sealing

Each arm has canonical `public.json` and `sealed.json` files. Their digests feed
`ids.task_id_for`. Public data contains only:

- arm and budget;
- opening turn;
- pinned dataset, revision, split, and item ID;
- source and verifier commitments.

Future turns, frozen proposal contents, the terminal source question when it is
not the opening turn, and answer authority stay sealed. The family record holds
all three arms and their common source, verifier, and proposal commitments.

Admission is atomic. A family is returned or written only when these named
checks pass:

- `source_verifier_parity`;
- `terminal_anchor_replay`;
- `matched_evolved_budget`;
- `public_leakage`;
- `oracle_success`;
- `wrong_answer_failure`;
- `deterministic_locked_rebuild`.

## CLI and locked replay

The narrow TOML format uses local path references:

```toml
[source]
kind = "gsm8k"
path = "gsm8k.json"

[proposal]
path = "proposal.json"

[build]
output_tokens_per_turn = 256
```

Build a family:

```shell
parallax build experiment.toml --store artifacts/
```

This writes `artifacts/<family-id>/` and `family.lock` beside the experiment.
The directory is assembled under a temporary sibling and published with an
atomic rename. An existing content-addressed directory must contain the same
bytes.

Replay from the lock:

```shell
parallax build --locked family.lock --store replay/
```

Locked replay reads only the source and proposal files named in the lock,
checks their byte digests, rebuilds the family, and checks every artifact file
digest before publication. It does not parse the experiment, access a network,
or invoke a model.

## Verification

The checked-in fixture uses `openai/gsm8k` test item 0 at revision
`e53f048856ff4f594e959d75785d2c2d37b678ee`. The focused suite covers identity
changes, public leakage, arm shapes, tampered anchors, answer parsing, oracle
and wrong-answer grading, synchronous and asynchronous execution, network-free
locked replay, deterministic bytes, and CLI reruns.

The focused suite passed 15 tests and the complete local suite passed 65 tests.
Ruff lint and format checks passed on every Phase D Python file. A real CLI
build and locked replay both produced family
`5ebc593aee75327d17e2a9d01c2e8f86752566990c7eafeaee5c2dcb55469cf7`,
and recursive byte comparison reported no difference. A repository-wide Ruff
format check also identified 19 pre-existing or unrelated unformatted Python
files. They were left untouched.

## Deliberate limits

`WorkspaceEpisode` and `CheckpointSequence` are typed placeholders and raise
`NotImplementedError` on execution. `CheckpointPlan` is also a minimal
placeholder. This matches the Phase D scope. The first callback API is narrower
than a provider adapter, but the requested `await parallax.run(..., agent=model)`
call works for caller-provided synchronous and asynchronous functions.

The caller sketch's `Gsm8k.item("test:42", revision="...")` lookup is not
implemented. `Gsm8k.item` accepts the complete pinned record, while
`Gsm8k.load` reads that record from a local fixture. Resolving a dataset item by
ID would add a network or dataset-cache boundary that this deterministic slice
does not need.

Existing compile, grade, export, variant, and SWE-bench APIs were not migrated
or removed.
