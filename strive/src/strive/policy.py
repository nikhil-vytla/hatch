"""The policy boundary (Strive vNext).

A policy is the model-led adaptation program. ONE active orchestrating
`AdaptationPolicy` owns timing and lifecycle for a run; `SurfaceStrategy`
objects analyze immutable views and PROPOSE changes (including coupled
multi-surface proposals) but can never mutate state.

The lifecycle is RESULT-DRIVEN, one command at a time:

    command = policy.next_command(config, state, view)   # None => done
    result  = kernel runs & journals the single command
    state   = policy.reduce(config, state, result)       # fold the outcome

The kernel never advances policy state before a command's outcome exists,
and on restart it reconstructs the exact same `result` from the journal —
so `last_result` can never disappear and no effect, model call, observation,
or spend is duplicated.

Policies receive IMMUTABLE `RunView`s and emit a small closed command
vocabulary (`RequestRefinement`, `ApplyChange`, `EvaluateFork`,
`ScheduleTrigger`, `ConfirmChange`, `RevertChange`, `StopAdaptation`). Each
command carries a run-scoped unique `command_id` bound to one canonical
payload digest. Comparative evaluation is what `EvaluateFork` REQUESTS; the
kernel never imposes it.

Catalogs are INJECTED and IMMUTABLE (name → descriptor); the descriptor's
config loader and prompt slots are authoritative (conformance-tested), and
there is no import-time registration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, Sequence, TypeVar

from strive.substrate import CompositeChange, HarnessState, VerifiedSubstrateView

Config = TypeVar("Config", contravariant=True)
State = TypeVar("State")


# -- the immutable view policies receive ----------------------------------------------------------


@dataclass(frozen=True)
class RunView:
    """The immutable read a policy is handed each step: the run/task scope,
    the current composite state, the pinned seed state (stable across
    resume), the journal head, and the ordered event bodies (read-only)."""

    run_id: str
    task_id: str
    state: HarnessState
    state_ref: str | None
    seed_state: HarnessState
    seed_state_ref: str | None  # STABLE across resume — a durable base precondition
    head: str
    seed: int
    bodies: tuple[object, ...]

    @staticmethod
    def of(seed: int, view: VerifiedSubstrateView) -> "RunView":
        return RunView(
            run_id=view.run_id,
            task_id=view.task_id,
            state=view.state,
            state_ref=view.state_ref,
            seed_state=view.seed_state,
            seed_state_ref=view.bound.seed_state_ref if view.bound is not None else None,
            head=view.head,
            seed=seed,
            bodies=view.bodies,
        )


# -- kernel commands (closed vocabulary; each has a run-scoped command_id) -------------------------


@dataclass(frozen=True)
class RequestRefinement:
    """Ask the kernel to run the model under a pinned prompt role and decode a
    strict typed proposal. The kernel performs and journals the model call
    once, so a restart never repeats it."""

    command_id: str
    prompt_role: str
    context_ref: str


@dataclass(frozen=True)
class ApplyChange:
    """Apply an exact composite change. The policy stages the change's new
    content in `content_blobs` (ref → content, each the pure content address of
    the delta's `after_ref`); the kernel stages the full closure and verifies
    it before applying. `expected_state_ref` (optional) is the LOGICAL composite
    harness-state ref the policy expects to still hold — robust to intervening
    non-state-moving events; a stale expectation is a real conflict."""

    command_id: str
    change: CompositeChange
    strategy_ref: str
    content_blobs: dict[str, str] = field(default_factory=dict)
    expected_state_ref: str | None = None


@dataclass(frozen=True)
class EvaluateFork:
    """Request an OPTIONAL comparative observation: score the current
    composite state and a forked candidate, recording BOTH exact state refs
    (captured before execution) even if active state later advances. A
    mechanism a policy requests — never a gate the kernel imposes."""

    command_id: str
    candidate: CompositeChange
    content_blobs: dict[str, str] = field(default_factory=dict)
    detail: str = ""


@dataclass(frozen=True)
class ScheduleTrigger:
    command_id: str
    after_seconds: float
    reason: str = ""


@dataclass(frozen=True)
class ConfirmChange:
    command_id: str
    change_id: str
    rationale: str = ""


@dataclass(frozen=True)
class RevertChange:
    command_id: str
    change_id: str
    expected_state_ref: str | None = None


@dataclass(frozen=True)
class StopAdaptation:
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
    """What the kernel hands back for a completed command: an outcome, the
    head after it, optional typed payloads, and numeric metrics (e.g. fork
    scores) the reducer may react to."""

    command_id: str
    kind: str
    outcome: str  # "ok" | "failed"
    head: str
    detail: str = ""
    proposal: CompositeChange | None = None
    observation_ref: str | None = None
    metrics: dict[str, float] = field(default_factory=dict)


# -- the protocols --------------------------------------------------------------------------------


class SurfaceStrategy(Protocol):
    """Analyzes an immutable view and PROPOSES a change (possibly coupled
    multi-surface). Cannot mutate state — returns a proposal or None."""

    name: str

    def propose(self, view: RunView) -> CompositeChange | None: ...


class AdaptationPolicy(Protocol[Config, State]):
    """The one active orchestrating policy for a run. Result-driven: the
    kernel asks for the next command, runs it, and folds the result back with
    `reduce`. `State` is the policy's content-addressable state machine value
    (checkpointed so a restart resumes exactly); `Config` is a frozen,
    policy-specific config dataclass."""

    name: str

    def initial_state(self, config: Config, view: RunView) -> State: ...

    def decode_state(self, data: object) -> State: ...

    def next_command(
        self, config: Config, state: State, view: RunView
    ) -> KernelCommand | None: ...

    def reduce(self, config: Config, state: State, result: CommandResult) -> State: ...


# -- the injected immutable catalog ---------------------------------------------------------------


@dataclass(frozen=True)
class PolicyDescriptor:
    """An immutable catalog entry: a policy name, a factory, an authoritative
    config loader (TOML path → frozen Config), the versioned prompt slots the
    policy pins (role → file path), and an EXPLICIT policy-package manifest —
    the module names whose source is part of the policy's durable identity
    (`dependency_modules`), i.e. any strategy/helper module the policy relies on
    OUTSIDE its own module. The kernel folds these module sources into the
    pinned policy digest, so a change to a declared dependency is detected on
    resume even though it lives elsewhere."""

    name: str
    factory: Callable[[], "AdaptationPolicy[Any, Any]"]
    config_loader: Callable[[str], object]
    default_config_path: str
    prompt_files: dict[str, str] = field(default_factory=dict)
    dependency_modules: tuple[str, ...] = ()


class PolicyCatalog:
    """An immutable set of policy descriptors, resolved by exact name@version,
    fail-closed."""

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


def conformance_violations(descriptor: PolicyDescriptor) -> list[str]:
    """Reusable descriptor conformance checks: versioned name, a policy whose
    `name` matches the descriptor, a loadable default config, and prompt
    slots that resolve to existing files."""
    import os

    problems: list[str] = []
    if "@" not in descriptor.name:
        problems.append(f"policy name {descriptor.name!r} is not versioned")
    policy = descriptor.factory()
    if policy.name != descriptor.name:
        problems.append("policy.name disagrees with descriptor.name")
    for role, path in descriptor.prompt_files.items():
        if not os.path.exists(path):
            problems.append(f"prompt slot {role!r} file is missing: {path}")
    try:
        descriptor.config_loader(descriptor.default_config_path)
    except Exception as exc:  # noqa: BLE001 — report, don't raise
        problems.append(f"default config does not load: {exc}")
    return problems


def default_catalog() -> PolicyCatalog:
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
    "StopAdaptation",
    "SurfaceStrategy",
    "conformance_violations",
    "default_catalog",
]
