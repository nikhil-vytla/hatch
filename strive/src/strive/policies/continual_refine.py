"""`continual-refine@1` — the real continual, model-led policy over Phase A.

It runs a genuine online adaptation loop: at a trigger it asks the model to
refine the harness (feeding it recent trajectory, the active harness, prior
changes, and structured failures rendered through the ACTIVE proposal
template), decodes a strict typed `RefinementProposal`, assembles ONE atomic
coupled prompt+code change through its surface strategies, and — because a
structurally-valid change is applied immediately — `ApplyChange`s it under the
kernel floor. Comparative evaluation is OPTIONAL: only when `use_fork` is set
does it `EvaluateFork` (an observation, never a gate). It then observes and at
a review checkpoint chooses keep / revise / revert / defer — no mandatory
tribunal and no automatic expiry.

The orchestrator alone emits lifecycle commands; the strategies only analyze
and propose. The policy never touches an adapter, budget, permission, surface
allow-list, or the event log — the kernel owns all of that.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from strive.cas import ObjectStore, hash_text
from strive.policies import continual_refine_strategies as strat
from strive.policy import (
    ApplyChange,
    CommandResult,
    EvaluateFork,
    KernelCommand,
    PolicyDescriptor,
    RequestRefinement,
    RevertChange,
    RunView,
    StopAdaptation,
)
from strive.runtime import RefinementProposal
from strive.substrate import (
    ChangeApplied,
    ChangeReverted,
    CompositeChange,
    HarnessState,
    ObservationRecorded,
    OperationFailed,
    SubstrateError,
    SurfaceDelta,
    canonical_state,
)

_PROMPT_DIR = Path(__file__).with_name("prompts")
STRATEGY_REF = "continual-refine@1"
_STRATEGY_MODULE = "strive.policies.continual_refine_strategies"
_ALL_SURFACES = ("strategy-code", "prompt")


# -- config ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ContinualRefineConfig:
    """Frozen, policy-specific config (loaded from strict TOML)."""

    summary: str
    model_role: str = "refine"
    trajectory_window: int = 8
    edit_limit: int = 2
    enabled_strategies: tuple[str, ...] = _ALL_SURFACES
    use_fork: bool = False
    review_mode: str = "auto"  # "auto" | "model"
    max_cycles: int = 1
    change_id_prefix: str = "refine"


_ALLOWED_KEYS = frozenset({
    "summary", "model_role", "trajectory_window", "edit_limit",
    "enabled_strategies", "use_fork", "review_mode", "max_cycles",
    "change_id_prefix",
})


def _req_str(s: dict[str, object], key: str, default: str | None = None) -> str:
    if key not in s:
        if default is not None:
            return default
        raise SubstrateError(f"continual_refine config is missing required key {key!r}")
    value = s[key]
    if not isinstance(value, str):
        raise SubstrateError(f"continual_refine config {key!r} must be a string")
    return value


def _req_int(s: dict[str, object], key: str, default: int) -> int:
    value = s.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SubstrateError(f"continual_refine config {key!r} must be an integer")
    if value < 0:
        raise SubstrateError(f"continual_refine config {key!r} must be non-negative")
    return value


def _req_bool(s: dict[str, object], key: str, default: bool) -> bool:
    value = s.get(key, default)
    if not isinstance(value, bool):
        raise SubstrateError(f"continual_refine config {key!r} must be a boolean")
    return value


def load_config(path: str) -> ContinualRefineConfig:
    with open(path, "rb") as handle:
        data = tomllib.load(handle)
    raw = data.get("continual_refine", data)
    if not isinstance(raw, dict):
        raise SubstrateError("continual_refine config section is not a table")
    section: dict[str, object] = raw
    unknown = set(section) - _ALLOWED_KEYS
    if unknown:
        raise SubstrateError(
            f"continual_refine config has unknown key(s): {sorted(unknown)}"
        )
    strategies_raw = section.get("enabled_strategies", list(_ALL_SURFACES))
    if not (
        isinstance(strategies_raw, list)
        and all(isinstance(x, str) for x in strategies_raw)
    ):
        raise SubstrateError("continual_refine config 'enabled_strategies' must be a string list")
    strategies = tuple(strategies_raw)
    unknown_surfaces = set(strategies) - set(_ALL_SURFACES)
    if unknown_surfaces:
        raise SubstrateError(
            f"continual_refine 'enabled_strategies' has unknown surface(s): "
            f"{sorted(unknown_surfaces)} (allowed: {list(_ALL_SURFACES)})"
        )
    if not strategies:
        raise SubstrateError("continual_refine 'enabled_strategies' must be non-empty")
    review_mode = _req_str(section, "review_mode", "auto")
    if review_mode not in ("auto", "model"):
        raise SubstrateError("continual_refine 'review_mode' must be 'auto' or 'model'")
    max_cycles = _req_int(section, "max_cycles", 1)
    if max_cycles < 1:
        raise SubstrateError("continual_refine 'max_cycles' must be >= 1")
    return ContinualRefineConfig(
        summary=_req_str(section, "summary"),
        model_role=_req_str(section, "model_role", "refine"),
        trajectory_window=_req_int(section, "trajectory_window", 8),
        edit_limit=_req_int(section, "edit_limit", 2),
        enabled_strategies=strategies,
        use_fork=_req_bool(section, "use_fork", False),
        review_mode=review_mode,
        max_cycles=max_cycles,
        change_id_prefix=_req_str(section, "change_id_prefix", "refine"),
    )


# -- state ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ContinualRefineState:
    """The policy's content-addressable state machine value.

    phase: refine -> proposed -> [forked] -> applied -> reviewed ->
           (kept|reverted) -> done ; a failed command drives `failed`.
    """

    phase: str
    cycle: int = 0
    change_id: str | None = None
    fork_improved: bool | None = None
    verdict: str | None = None


_STATE_KEYS = {"phase", "cycle", "change_id", "fork_improved", "verdict"}


# -- policy ---------------------------------------------------------------------------------------


class ContinualRefinePolicy:
    name = "continual-refine@1"

    def __init__(self) -> None:
        self._strategies = {
            "strategy-code": strat.code_strategy(),
            "prompt": strat.prompt_strategy(),
        }

    def initial_state(
        self, config: ContinualRefineConfig, view: RunView
    ) -> ContinualRefineState:
        return ContinualRefineState(phase="refine", cycle=0)

    def decode_state(self, data: object) -> ContinualRefineState:
        if not isinstance(data, dict):
            raise SubstrateError("continual-refine state is not an object")
        unknown = set(data) - _STATE_KEYS
        if unknown:
            raise SubstrateError(f"continual-refine state has unknown key(s): {sorted(unknown)}")
        phase = data.get("phase")
        if not isinstance(phase, str):
            raise SubstrateError("continual-refine state needs a string 'phase'")
        cycle = data.get("cycle", 0)
        if isinstance(cycle, bool) or not isinstance(cycle, int):
            raise SubstrateError("continual-refine state 'cycle' must be an integer")
        change_id = data.get("change_id")
        if change_id is not None and not isinstance(change_id, str):
            raise SubstrateError("continual-refine state 'change_id' must be a string or null")
        improved = data.get("fork_improved")
        if improved is not None and not isinstance(improved, bool):
            raise SubstrateError("continual-refine state 'fork_improved' must be bool or null")
        verdict = data.get("verdict")
        if verdict is not None and not isinstance(verdict, str):
            raise SubstrateError("continual-refine state 'verdict' must be a string or null")
        return ContinualRefineState(
            phase=phase, cycle=cycle, change_id=change_id,
            fork_improved=improved, verdict=verdict,
        )

    # -- command ids (deterministic, run + cycle scoped, so resume is exact) ------

    def _cid(self, view: RunView, name: str, cycle: int) -> str:
        return f"{view.run_id}:{name}:{cycle}"

    def next_command(
        self, config: ContinualRefineConfig, state: ContinualRefineState, view: RunView
    ) -> KernelCommand | None:
        c = state.cycle
        if state.phase == "refine":
            context = _build_context(
                view, window=config.trajectory_window,
                exclude_cid=self._cid(view, "refine", c), cycle=c,
            )
            ref = hash_text(context)
            return RequestRefinement(
                command_id=self._cid(view, "refine", c),
                prompt_role="refine",
                context_ref=ref,
                content_blobs={ref: context},
            )
        if state.phase == "proposed":
            change = self._assemble_change(config, state, view)
            if change is None:
                return StopAdaptation(
                    command_id=self._cid(view, "stop-empty", c),
                    reason="refinement proposed no change for the enabled surfaces",
                )
            if config.use_fork:
                return EvaluateFork(
                    command_id=self._cid(view, "fork", c),
                    candidate=change, detail=STRATEGY_REF,
                )
            return ApplyChange(
                command_id=self._cid(view, "apply", c),
                change=change, strategy_ref=self._strategy_ref(config),
                expected_state_ref=view.state_ref,
            )
        if state.phase == "forked":
            change = self._assemble_change(config, state, view)
            assert change is not None  # a fork implies a change was assembled
            return ApplyChange(
                command_id=self._cid(view, "apply", c),
                change=change, strategy_ref=self._strategy_ref(config),
                expected_state_ref=view.state_ref,
            )
        if state.phase == "applied":
            if config.review_mode == "model":
                context = _review_context(
                    view, change_id=state.change_id, improved=state.fork_improved,
                    exclude_cid=self._cid(view, "review", c),
                )
                ref = hash_text(context)
                return RequestRefinement(
                    command_id=self._cid(view, "review", c),
                    prompt_role="review", context_ref=ref, content_blobs={ref: context},
                )
            # auto review: keep unless a fork showed no improvement
            verdict = "revert" if state.fork_improved is False else "keep"
            return self._act_on_verdict(config, state, view, verdict)
        if state.phase == "reviewed":
            proposal = strat.proposal_for(view, self._cid(view, "review", c))
            verdict = proposal.review_hint if proposal is not None else "keep"
            return self._act_on_verdict(config, state, view, verdict)
        if state.phase == "revised":
            # a `revise` verdict applied a new change; nothing more this cycle
            return StopAdaptation(
                command_id=self._cid(view, "stop-revised", c), reason="revised"
            )
        return None  # done | reverted-terminal | failed

    def _act_on_verdict(
        self, config: ContinualRefineConfig, state: ContinualRefineState,
        view: RunView, verdict: str,
    ) -> KernelCommand:
        c = state.cycle
        if verdict == "revert" and state.change_id is not None:
            return RevertChange(
                command_id=self._cid(view, "revert", c), change_id=state.change_id
            )
        # keep / defer -> stop this run honestly (no automatic expiry)
        return StopAdaptation(
            command_id=self._cid(view, "stop", c),
            reason=f"review verdict: {verdict}",
        )

    def reduce(
        self, config: ContinualRefineConfig, state: ContinualRefineState,
        result: CommandResult,
    ) -> ContinualRefineState:
        if result.outcome != "ok":
            return ContinualRefineState(
                phase="failed", cycle=state.cycle, change_id=state.change_id,
                fork_improved=state.fork_improved, verdict=state.verdict,
            )
        if result.kind == "RequestRefinement":
            if state.phase == "refine":
                return ContinualRefineState(phase="proposed", cycle=state.cycle)
            return ContinualRefineState(  # a review refinement
                phase="reviewed", cycle=state.cycle, change_id=state.change_id,
                fork_improved=state.fork_improved,
            )
        if result.kind == "EvaluateFork":
            return ContinualRefineState(
                phase="forked", cycle=state.cycle,
                fork_improved=result.metrics.get("improved", 0.0) == 1.0,
            )
        if result.kind == "ApplyChange":
            change_id = result.proposal.change_id if result.proposal else state.change_id
            return ContinualRefineState(
                phase="applied", cycle=state.cycle, change_id=change_id,
                fork_improved=state.fork_improved,
            )
        if result.kind == "RevertChange":
            return ContinualRefineState(
                phase="done", cycle=state.cycle, change_id=state.change_id,
                fork_improved=state.fork_improved, verdict="revert",
            )
        if result.kind == "StopAdaptation":
            return ContinualRefineState(
                phase="done", cycle=state.cycle, change_id=state.change_id,
                fork_improved=state.fork_improved, verdict=state.verdict,
            )
        return state

    # -- assembling one atomic coupled change from a proposal ---------------------

    def _strategy_ref(self, config: ContinualRefineConfig) -> str:
        return f"{STRATEGY_REF}:{'+'.join(config.enabled_strategies)}"

    def _assemble_change(
        self, config: ContinualRefineConfig, state: ContinualRefineState, view: RunView
    ) -> CompositeChange | None:
        proposal = strat.proposal_for(view, self._cid(view, "refine", state.cycle))
        if proposal is None:
            return None
        if len(proposal.edits) > config.edit_limit:
            raise SubstrateError(
                f"refinement proposed {len(proposal.edits)} edits, over the "
                f"edit_limit {config.edit_limit}"
            )
        deltas: list[SurfaceDelta] = []
        for surface in config.enabled_strategies:
            delta = self._strategies[surface].delta_for(view, proposal)
            if delta is not None:
                deltas.append(delta)
        if not deltas:
            return None
        return CompositeChange(
            change_id=proposal.change_id, deltas=tuple(deltas),
            summary=proposal.rationale,  # rationale bound to the emitted annotation
        )


# -- context rendering (deterministic; excludes the in-flight command's own events) ---------------


def _build_context(
    view: RunView, *, window: int, exclude_cid: str, cycle: int
) -> str:
    """Deterministic refiner context: the active strategy source plus a bounded
    window of the STABLE trajectory (applied/reverted changes and prior
    failures). It excludes the current refine command's own events, so the
    context — and thus the command's payload digest — is identical when a crash
    forces re-derivation."""
    lines = [f"cycle: {cycle}"]
    code_ref = view.state.content_ref("strategy-code", "solve")
    lines.append("=== active strategy ===")
    lines.append(view.read_text(code_ref) if code_ref else "<none>")
    traj: list[str] = []
    for body in view.bodies:
        if isinstance(body, ChangeApplied):
            traj.append(f"applied change {body.change_id}")
        elif isinstance(body, ChangeReverted):
            traj.append(f"reverted change {body.change_id}")
        elif isinstance(body, OperationFailed) and body.command_id != exclude_cid:
            traj.append(f"failure[{body.kind}]: {body.detail}")
    lines.append("=== recent trajectory ===")
    lines.extend(traj[-window:] if window > 0 else [])
    return "\n".join(lines) + "\n"


def _review_context(
    view: RunView, *, change_id: str | None, improved: bool | None, exclude_cid: str
) -> str:
    lines = [f"reviewing change: {change_id}"]
    lines.append(f"fork improved: {improved}")
    for body in view.bodies:
        if isinstance(body, ChangeApplied) and body.change_id == change_id:
            lines.append(f"applied at state {body.after_state_ref[:12]}")
        elif isinstance(body, OperationFailed) and body.command_id != exclude_cid:
            lines.append(f"failure[{body.kind}]: {body.detail}")
    return "\n".join(lines) + "\n"


# -- run preparation helpers (used by the CLI / tests) --------------------------------------------


def seed_state(objects: ObjectStore, *, code: str, prompt: str) -> HarnessState:
    return canonical_state(
        {
            ("strategy-code", "solve"): objects.put_text(code),
            ("prompt", "proposal-template"): objects.put_text(prompt),
        }
    )


def prompt_refs(objects: ObjectStore) -> dict[str, str]:
    return {
        role: objects.put_text(Path(path).read_text(encoding="utf-8"))
        for role, path in DESCRIPTOR.prompt_files.items()
    }


DEFAULT_CONFIG_PATH = str(Path(__file__).with_name("continual_refine.toml"))

DESCRIPTOR = PolicyDescriptor(
    name="continual-refine@1",
    factory=ContinualRefinePolicy,
    config_loader=load_config,
    default_config_path=DEFAULT_CONFIG_PATH,
    prompt_files={
        "refine": str(_PROMPT_DIR / "continual_refine_refine@1.md"),
        "review": str(_PROMPT_DIR / "continual_refine_review@1.md"),
    },
    dependency_modules=(_STRATEGY_MODULE,),
)


__all__ = [
    "DEFAULT_CONFIG_PATH",
    "DESCRIPTOR",
    "ContinualRefineConfig",
    "ContinualRefinePolicy",
    "ContinualRefineState",
    "load_config",
    "prompt_refs",
    "seed_state",
]
