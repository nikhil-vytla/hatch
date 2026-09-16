"""The one task model.

A task is public material the agent may read plus sealed material that decides
whether it succeeded. Benchmarks differ only in what fills those two slots, so
this module names no benchmark: no dataset ids, no container paths, no
condition names.

`Task` is a structural protocol rather than a base class. Every benchmark
already has a natural problem model, and inheritance would force those models
to agree on fields they do not share — which is how `specs.py` ended up
pinning `Literal["SWE-bench/SWE-bench_Verified"]` into code that three
benchmarks import.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .types import DigestText, NonEmptyText, SourceId, StrictModel


class AgentContract(StrictModel):
    """What an agent must be told for its work to be gradeable at all.

    A verifier that parses `FINAL_ANSWER: 42` is useless against a model nobody
    told to write `FINAL_ANSWER: 42`. That is not hypothetical: a full GSM8K
    round shipped without ever stating the contract, and the whole run graded
    against a format the agent was never given. Scripted test agents emitted it
    anyway, so nothing offline could see the gap.

    So the contract is data owned by the benchmark next to its verifier, and
    `VariantSet` refuses to hold a condition whose turns do not carry
    `instructions` verbatim. Forgetting to state it stops being a bug a reviewer
    might catch and becomes a state that cannot be built.
    """

    instructions: NonEmptyText
    required_markers: tuple[NonEmptyText, ...] = ()
    fenced_output_tolerated: bool = True


@runtime_checkable
class Task(Protocol):
    """One problem, addressed by the digests the experiment preregisters.

    `public_digest` must cover exactly the material an agent may see, and must
    not move when sealed material changes — otherwise the public/sealed split
    is unenforceable. `verifier_digest` pins the grading authority so a run
    cannot quietly be graded against a different one.
    """

    @property
    def task_id(self) -> SourceId: ...

    @property
    def public_digest(self) -> DigestText: ...

    @property
    def verifier_digest(self) -> DigestText: ...

    @property
    def agent_contract(self) -> AgentContract: ...
