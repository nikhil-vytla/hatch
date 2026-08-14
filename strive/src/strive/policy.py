"""The policy boundary (Strive vNext, Phase A).

A policy is the model-led adaptation program. ONE active orchestrating
`AdaptationPolicy` owns timing and lifecycle decisions for a run;
`SurfaceStrategy` objects analyze immutable views and PROPOSE changes
(including coupled multi-surface proposals) but can never mutate state.

Policies receive IMMUTABLE views and emit KERNEL COMMANDS — they never
touch the event store or CAS directly. The kernel executes commands,
journals their intent and result, and content-addresses policy state, so a
restart resumes without repeating completed model calls or side effects.

The command vocabulary is small and closed:

- `RequestRefinement` — ask the model (via a pinned prompt) for a typed
  proposal; the kernel performs and journals the model call.
- `ApplyChange` — apply an exact composite change to harness state.
- `EvaluateFork` — request an OPTIONAL comparative observation of a
  candidate state against the current one (a mechanism, not a gate).
- `ScheduleTrigger` — ask to be re-invoked later (timing).
- `ConfirmChange` / `RevertChange` — annotate or exactly undo an applied
  change.
- `StopAdaptation` — end the run.

Comparative evaluation is thus something a policy may REQUEST
(`EvaluateFork`), never a universal activation prerequisite.

Catalogs are INJECTED and IMMUTABLE (name → factory descriptors); there is
no import-time registration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Generic, Protocol, Sequence, TypeVar

from strive.substrate import CompositeChange, HarnessState, SubstrateView

Config = TypeVar("Config", contravariant=True)
State = TypeVar("State")

# -- immutable views policies/strategies receive --------------------------------------------------


@dataclass(frozen=True)
class RunView:
    """The immutable read a policy/strategy is handed each step: the current
    composite state, the journal head it was taken at, and the ordered event
    entries (read-only). No handle to mutate anything."""

    task_id: str
    state: HarnessState
    state_ref: str | None
    seed_state: HarnessState  # the pinned initial state (stable across resume)
    head: str
    entries: tuple[object, ...]
    seed: int

    @staticmethod
    def of(task_id: str, seed: int, view: SubstrateView) -> "RunView":
        return RunView(
            task_id=task_id,
            state=view.state,
            state_ref=view.state_ref,
            seed_state=view.seed_state,
            head=view.head,
            entries=view.entries,
            seed=seed,
        )


# -- kernel commands (closed vocabulary) ----------------------------------------------------------


@dataclass(frozen=True)
class RequestRefinement:
    """Ask the kernel to run the model under a pinned prompt role and decode
    a strict typed proposal. The kernel performs and journals the model
    call, so a restart after completion does not repeat it."""

    command_id: str
    prompt_role: str
    context_ref: str  # CAS ref of the model-facing context payload


@dataclass(frozen=True)
class ApplyChange:
    """Apply an exact composite change to harness state (head-checked). The
    policy stages NEW surface content in `content_blobs` (ref → content),
    where each ref is the pure content address (`strive.cas.hash_text`) the
    change's `after_ref` points at; the kernel puts and verifies each blob
    before applying, so policies never touch CAS directly."""

    command_id: str
    change: CompositeChange
    content_blobs: dict[str, str] = field(default_factory=dict)
    expected_head: str | None = None


@dataclass(frozen=True)
class EvaluateFork:
    """Request an OPTIONAL comparative observation: evaluate a candidate
    composite state (a fork) alongside the current one and record the
    observation. A mechanism a policy may request — never a gate the kernel
    imposes."""

    command_id: str
    candidate: CompositeChange
    content_blobs: dict[str, str] = field(default_factory=dict)
    detail: str = ""


@dataclass(frozen=True)
class ScheduleTrigger:
    """Ask to be re-invoked later (the policy owns timing)."""

    command_id: str
    after_seconds: float
    reason: str = ""


@dataclass(frozen=True)
class ConfirmChange:
    """Annotate a previously-applied change as confirmed."""

    command_id: str
    change_id: str
    rationale: str = ""


@dataclass(frozen=True)
class RevertChange:
    """Exactly undo a previously-applied change (head-checked)."""

    command_id: str
    change_id: str
    expected_head: str | None = None


@dataclass(frozen=True)
class StopAdaptation:
    """End the run."""

    command_id: str
    reason: str = ""


KernelCommand = (
    RequestRefinement
    | ApplyChange
    | EvaluateFork
    | ScheduleTrigger
    | ConfirmChange
    | RevertChange
    | StopAdaptation
)


@dataclass(frozen=True)
class CommandResult:
    """What the kernel hands back for a completed command: an outcome, an
    optional typed payload, and the head after the command."""

    command_id: str
    outcome: str  # "ok" | "failed"
    head: str
    detail: str = ""
    proposal: CompositeChange | None = None
    observation_ref: str | None = None


# -- the public protocols -------------------------------------------------------------------------


class SurfaceStrategy(Protocol):
    """Analyzes an immutable view and PROPOSES a change (possibly coupled
    multi-surface). A strategy cannot mutate state — it only returns a
    proposal or None."""

    name: str  # name@version

    def propose(self, view: RunView) -> CompositeChange | None: ...


@dataclass(frozen=True)
class Step(Generic[State]):
    """One orchestration step: the commands to execute now and the successor
    policy state to checkpoint. `done` ends the run after these commands."""

    commands: tuple[KernelCommand, ...]
    next_state: State
    done: bool = False
    checkpoint: bool = True


class AdaptationPolicy(Protocol[Config, State]):
    """The ONE active orchestrating policy for a run. It owns timing and
    lifecycle decisions; it consumes immutable views and completed-command
    results and emits kernel commands. It never mutates state directly.

    `State` is the policy's own content-addressable state machine value
    (checkpointed by the kernel so a restart resumes exactly). `Config` is a
    frozen, policy-specific config dataclass."""

    name: str  # name@version

    def initial_state(self, config: Config, view: RunView) -> State: ...

    def step(
        self,
        config: Config,
        state: State,
        view: RunView,
        last_result: CommandResult | None,
    ) -> Step[State]: ...


# -- the injected immutable policy/strategy catalog -----------------------------------------------


@dataclass(frozen=True)
class PolicyDescriptor:
    """An immutable catalog entry: a policy name, a zero-arg factory building
    a fresh policy, a config loader (TOML path → frozen Config), and the
    versioned prompt files the policy pins (role → path)."""

    name: str
    factory: Callable[[], "AdaptationPolicy[Any, Any]"]
    config_loader: Callable[[str], object]
    prompt_files: dict[str, str] = field(default_factory=dict)


class PolicyCatalog:
    """An immutable set of policy descriptors, resolved by exact name@version.
    Fail-closed: an unknown policy raises rather than guessing."""

    def __init__(self, descriptors: Sequence[PolicyDescriptor]) -> None:
        self._by_name: dict[str, PolicyDescriptor] = {}
        for descriptor in descriptors:
            if descriptor.name in self._by_name:
                raise ValueError(f"duplicate policy descriptor {descriptor.name!r}")
            self._by_name[descriptor.name] = descriptor

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_name))

    def descriptor(self, name: str) -> PolicyDescriptor:
        descriptor = self._by_name.get(name)
        if descriptor is None:
            raise KeyError(
                f"unknown policy {name!r}; known: {list(self.names())} — "
                "refusing to substitute a different policy"
            )
        return descriptor


def default_catalog() -> PolicyCatalog:
    """The build's default policy catalog, assembled WITHOUT import-time
    registration side effects."""
    from strive.policies.manual_change import DESCRIPTOR as MANUAL_CHANGE

    return PolicyCatalog([MANUAL_CHANGE])


__all__ = [
    "AdaptationPolicy",
    "ApplyChange",
    "CommandResult",
    "ConfirmChange",
    "EvaluateFork",
    "KernelCommand",
    "PolicyCatalog",
    "PolicyDescriptor",
    "RequestRefinement",
    "RevertChange",
    "RunView",
    "ScheduleTrigger",
    "Step",
    "StopAdaptation",
    "SurfaceStrategy",
    "default_catalog",
]
