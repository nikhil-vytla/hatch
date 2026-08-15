"""`manual-change@1` — the deterministic vNext substrate proof.

It exercises the result-driven kernel end to end WITHOUT overbuilding policy
behavior or a model refiner. From its frozen config it builds ONE typed,
coupled prompt+code change against the pinned seed state, then, one command
at a time:

1. `EvaluateFork` the candidate — the OPTIONAL comparative mechanism; this
   emits `ChangeProposed` and records a fork observation.
2. **React to the fork through the reducer**: if the fork improved the code
   score, `ApplyChange` then `RevertChange` (proving exact apply + revert);
   if it did NOT improve, `StopAdaptation` and leave state untouched.

Honest scope: the fork scores the **code** surface over the task's cases.
The **prompt** surface is coupled into the same change and is applied and
reverted round-trip, but no scorer consumes it yet — a real prompt consumer
arrives with `continual-refine@1`. Command ids are run-scoped and unique so
resume is exact.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from strive.cas import ObjectStore, hash_text
from strive.policy import (
    ApplyChange,
    CommandResult,
    EvaluateFork,
    KernelCommand,
    PolicyDescriptor,
    RevertChange,
    RunView,
    StopAdaptation,
)
from strive.substrate import (
    CompositeChange,
    HarnessState,
    SubstrateError,
    SurfaceDelta,
    canonical_state,
)

_PROMPT_DIR = Path(__file__).with_name("prompts")
_CODE = ("strategy-code", "solve")
_PROMPT = ("prompt", "proposal-template")
STRATEGY_REF = "manual-change@1"


@dataclass(frozen=True)
class ManualChangeConfig:
    """Frozen, policy-specific config (loaded from TOML). The exact target
    the single coupled change installs."""

    summary: str
    target_prompt: str
    target_strategy: str
    change_id: str = "manual-change-1"


@dataclass(frozen=True)
class ManualChangeState:
    """The policy's content-addressable state machine value.
    phase: start -> observed -> applied -> reverted -> done. A failed command
    outcome drives the terminal `failed` phase (the policy stops, honestly, on
    a failed Apply/Revert/Fork/Stop rather than pretending it advanced)."""

    phase: str
    fork_improved: bool | None = None


def _require_str(section: dict[str, object], key: str, default: str | None = None) -> str:
    """Strictly read a string TOML field — NO permissive `str()` coercion of
    ints/floats/bools/tables into config values."""
    if key not in section:
        if default is not None:
            return default
        raise SubstrateError(f"manual_change config is missing required key {key!r}")
    value = section[key]
    if not isinstance(value, str):
        raise SubstrateError(
            f"manual_change config {key!r} must be a string, got "
            f"{type(value).__name__}"
        )
    return value


def load_config(path: str) -> ManualChangeConfig:
    with open(path, "rb") as handle:
        data = tomllib.load(handle)
    raw = data.get("manual_change", data)
    if not isinstance(raw, dict):
        raise SubstrateError("manual_change config section is not a table")
    section: dict[str, object] = raw
    return ManualChangeConfig(
        summary=_require_str(section, "summary"),
        target_prompt=_require_str(section, "target_prompt"),
        target_strategy=_require_str(section, "target_strategy"),
        change_id=_require_str(section, "change_id", "manual-change-1"),
    )


class ManualChangePolicy:
    name = "manual-change@1"

    def initial_state(
        self, config: ManualChangeConfig, view: RunView
    ) -> ManualChangeState:
        return ManualChangeState(phase="start")

    def decode_state(self, data: object) -> ManualChangeState:
        assert isinstance(data, dict)
        improved = data.get("fork_improved")
        return ManualChangeState(
            phase=str(data["phase"]),
            fork_improved=None if improved is None else bool(improved),
        )

    def next_command(
        self, config: ManualChangeConfig, state: ManualChangeState, view: RunView
    ) -> KernelCommand | None:
        rid = view.run_id
        if state.phase == "start":
            change, blobs = self._build_change(config, view)
            return EvaluateFork(
                command_id=f"{rid}:fork",
                candidate=change,
                content_blobs=blobs,
                detail=STRATEGY_REF,
            )
        if state.phase == "observed":
            if state.fork_improved:
                change, blobs = self._build_change(config, view)
                return ApplyChange(
                    command_id=f"{rid}:apply",
                    change=change,
                    strategy_ref=STRATEGY_REF,
                    content_blobs=blobs,
                )
            return StopAdaptation(
                command_id=f"{rid}:stop-noimprove",
                reason="fork did not improve the code score; leaving state unchanged",
            )
        if state.phase == "applied":
            return RevertChange(
                command_id=f"{rid}:revert", change_id=config.change_id
            )
        if state.phase == "reverted":
            return StopAdaptation(
                command_id=f"{rid}:stop-done", reason="manual change complete"
            )
        return None  # phase == "done" or "failed"

    def reduce(
        self, config: ManualChangeConfig, state: ManualChangeState, result: CommandResult
    ) -> ManualChangeState:
        if result.outcome != "ok":
            # honest failure handling: a failed Apply/Revert/Fork/Stop stops the
            # policy at a terminal `failed` phase — it never claims to advance.
            return ManualChangeState(phase="failed", fork_improved=state.fork_improved)
        if result.kind == "EvaluateFork":
            return ManualChangeState(
                phase="observed",
                fork_improved=result.metrics.get("improved", 0.0) == 1.0,
            )
        if result.kind == "ApplyChange":
            return ManualChangeState(phase="applied", fork_improved=state.fork_improved)
        if result.kind == "RevertChange":
            return ManualChangeState(phase="reverted", fork_improved=state.fork_improved)
        if result.kind == "StopAdaptation":
            return ManualChangeState(phase="done", fork_improved=state.fork_improved)
        return state

    def _build_change(
        self, config: ManualChangeConfig, view: RunView
    ) -> tuple[CompositeChange, dict[str, str]]:
        """Build the exact coupled change from the SEED state and the frozen
        config — stable across resume, so re-derivation yields the same
        change and the kernel's idempotency skips re-applying. Content refs
        are pure content addresses; new content travels in `blobs`."""
        seed = view.seed_state.as_map()
        code_before = seed.get(_CODE)
        prompt_before = seed.get(_PROMPT)
        code_after = hash_text(config.target_strategy)
        prompt_after = hash_text(config.target_prompt)
        if code_before == code_after and prompt_before == prompt_after:
            raise SubstrateError(
                "manual-change target equals the seed state (no change to make)"
            )
        change = CompositeChange(
            change_id=config.change_id,
            deltas=(
                SurfaceDelta(_CODE[0], _CODE[1], code_before, code_after),
                SurfaceDelta(_PROMPT[0], _PROMPT[1], prompt_before, prompt_after),
            ),
            summary=config.summary,
        )
        blobs = {code_after: config.target_strategy, prompt_after: config.target_prompt}
        return change, blobs


# -- run preparation helpers (used by the CLI / tests) --------------------------------------------


def seed_state(objects: ObjectStore, *, code: str, prompt: str) -> HarnessState:
    """Install a baseline composite state's content into CAS and return the
    canonical HarnessState (the run's seed identity)."""
    return canonical_state(
        {_CODE: objects.put_text(code), _PROMPT: objects.put_text(prompt)}
    )


def prompt_refs(objects: ObjectStore) -> dict[str, str]:
    """Content-address the policy's versioned Markdown instructions
    (role → CAS ref), pinned per run."""
    return {
        role: objects.put_text(Path(path).read_text(encoding="utf-8"))
        for role, path in DESCRIPTOR.prompt_files.items()
    }


DEFAULT_CONFIG_PATH = str(Path(__file__).with_name("manual_change.toml"))

DESCRIPTOR = PolicyDescriptor(
    name="manual-change@1",
    factory=ManualChangePolicy,
    config_loader=load_config,
    default_config_path=DEFAULT_CONFIG_PATH,
    prompt_files={"refine": str(_PROMPT_DIR / "manual_change_refine@1.md")},
)


__all__ = [
    "DEFAULT_CONFIG_PATH",
    "DESCRIPTOR",
    "ManualChangeConfig",
    "ManualChangePolicy",
    "ManualChangeState",
    "load_config",
    "prompt_refs",
    "seed_state",
]
