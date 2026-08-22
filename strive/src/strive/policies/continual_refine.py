"""`continual-refine@1` — the real continual, model-led policy over Phase A.

It alternates REAL OPERATION and REFINEMENT over a continuing trajectory:

    warm-up: operate the active harness (ObserveCurrentState) N times, durably
             recording its behavior (scores, per-case failures) as feedback;
    refine:  ask the model to improve the harness, feeding it those real
             observations + prior rationale/citations/expected outcomes +
             applied changes + usage + failures, rendered through the active
             proposal template; decode a strict typed proposal under DURABLE
             constraints (change id, edit limit, enabled/pinned surfaces);
    apply:   assemble ONE atomic coupled prompt+code change and apply it
             immediately under the kernel floor (comparative EvaluateFork is
             OPTIONAL — an observation, never a gate);
    observe: operate again over a configured window to see the changed
             behavior before deciding;
    review:  keep (ConfirmChange), revert (exact rollback), defer (gather more
             and review again — never terminates), or revise (apply a new
             atomic change with lineage to the superseded one);
    then the next cycle, up to `max_cycles`.

The orchestrator alone emits lifecycle commands; the strategies only analyze
and propose. The policy never touches an adapter, budget, permission, surface
allow-list, or the event log — the kernel owns all of that.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from strive.cas import ObjectStore, hash_text
from strive.policies import continual_refine_strategies as strat
from strive.policy import (
    ApplyChange,
    CommandResult,
    ConfirmChange,
    EvaluateFork,
    KernelCommand,
    ObserveCurrentState,
    PolicyDescriptor,
    RequestRefinement,
    RevertChange,
    RunView,
    StopAdaptation,
)
from strive.runtime import (
    FORK_SUMMARY,
    OPERATION_RESULT,
    REFINE_RESULT,
    AttemptRecord,
    ForkObservation,
    ModelResult,
    RefinementProposal,
)
from strive.contracts import Evaluation
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
_SURFACE_KEY = {"strategy-code": strat.CODE_SURFACE, "prompt": strat.PROMPT_SURFACE}
_MAX_DEFERS = 2  # bound defer looping so a run always terminates


# -- config ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ContinualRefineConfig:
    """Frozen, policy-specific config (loaded from strict TOML)."""

    summary: str
    model_role: str = "refine"
    # how many times to operate (observe) the harness before each refinement.
    # (There is no external trigger mechanism yet, so a separate manual/cadence
    # "mode" would be fiction — a run refines after this many observations.)
    warmup_observations: int = 1
    review_window: int = 1  # post-change observations gathered before a review
    trajectory_window: int = 8
    edit_limit: int = 2
    enabled_strategies: tuple[str, ...] = _ALL_SURFACES
    use_fork: bool = False
    review_mode: str = "auto"  # "auto" | "model"
    max_cycles: int = 1


_ALLOWED_KEYS = frozenset({
    "summary", "model_role", "warmup_observations",
    "review_window", "trajectory_window", "edit_limit", "enabled_strategies",
    "use_fork", "review_mode", "max_cycles",
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


def _req_int(s: dict[str, object], key: str, default: int, *, minimum: int = 0) -> int:
    value = s.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SubstrateError(f"continual_refine config {key!r} must be an integer")
    if value < minimum:
        raise SubstrateError(f"continual_refine config {key!r} must be >= {minimum}")
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
        raise SubstrateError("continual_refine 'enabled_strategies' must be a string list")
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
    return ContinualRefineConfig(
        summary=_req_str(section, "summary"),
        model_role=_req_str(section, "model_role", "refine"),
        warmup_observations=_req_int(section, "warmup_observations", 1, minimum=1),
        review_window=_req_int(section, "review_window", 1, minimum=1),
        trajectory_window=_req_int(section, "trajectory_window", 8),
        edit_limit=_req_int(section, "edit_limit", 2, minimum=1),
        enabled_strategies=strategies,
        use_fork=_req_bool(section, "use_fork", False),
        review_mode=review_mode,
        max_cycles=_req_int(section, "max_cycles", 1, minimum=1),
    )


# -- state ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ContinualRefineState:
    """The policy's content-addressable state machine value.

    phase: warmup -> proposed -> [forked] -> observe_post -> review ->
           reviewed -> (kept|reverted|revised|deferring) -> cycle_end ; a failed
           command drives `failed`. `obs_done` counts observations in the
           current sub-phase; `defers` bounds defer looping."""

    phase: str
    cycle: int = 0
    obs_done: int = 0
    change_id: str | None = None
    fork_improved: bool | None = None
    verdict: str | None = None
    defers: int = 0
    revised: int = 0  # 1 once a revise change has been applied this cycle


_STATE_KEYS = {
    "phase", "cycle", "obs_done", "change_id", "fork_improved", "verdict",
    "defers", "revised",
}


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
        return ContinualRefineState(phase="warmup", cycle=0, obs_done=0)

    def decode_state(self, data: object) -> ContinualRefineState:
        if not isinstance(data, dict):
            raise SubstrateError("continual-refine state is not an object")
        unknown = set(data) - _STATE_KEYS
        if unknown:
            raise SubstrateError(f"continual-refine state has unknown key(s): {sorted(unknown)}")
        phase = data.get("phase")
        if not isinstance(phase, str):
            raise SubstrateError("continual-refine state needs a string 'phase'")

        def _int(key: str) -> int:
            v = data.get(key, 0)
            if isinstance(v, bool) or not isinstance(v, int):
                raise SubstrateError(f"continual-refine state {key!r} must be an integer")
            return v

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
            phase=phase, cycle=_int("cycle"), obs_done=_int("obs_done"),
            change_id=change_id, fork_improved=improved, verdict=verdict,
            defers=_int("defers"), revised=_int("revised"),
        )

    # -- deterministic ids --------------------------------------------------------

    def _cid(self, view: RunView, name: str) -> str:
        return f"{view.run_id}:{name}"

    def _refine_change_id(self, view: RunView, cycle: int) -> str:
        return f"{view.run_id}:refine-change:{cycle}"

    def _revise_change_id(self, view: RunView, cycle: int) -> str:
        return f"{view.run_id}:revise-change:{cycle}"

    def _enabled_surface_specs(self, config: ContinualRefineConfig) -> tuple[str, ...]:
        return _surface_specs(config)

    # -- the loop -----------------------------------------------------------------

    def next_command(
        self, config: ContinualRefineConfig, state: ContinualRefineState, view: RunView
    ) -> KernelCommand | None:
        c, n = state.cycle, state.obs_done
        if state.phase == "warmup":
            if n < config.warmup_observations:
                return ObserveCurrentState(
                    command_id=self._cid(view, f"warmup:{c}:{n}"),
                    detail="warm-up observation",
                )
            return self._refine_command(config, view, c)
        if state.phase == "proposed":
            change = self._assemble(config, view, self._refine_change_id(view, c), refine_cid=self._cid(view, f"refine:{c}"))
            if change is None:
                return StopAdaptation(
                    command_id=self._cid(view, f"stop-empty:{c}"),
                    reason="refinement proposed no change for the enabled surfaces",
                )
            if config.use_fork:
                return EvaluateFork(
                    command_id=self._cid(view, f"fork:{c}"), candidate=change,
                    detail=STRATEGY_REF,
                )
            return ApplyChange(
                command_id=self._cid(view, f"apply:{c}"), change=change,
                strategy_ref=self._strategy_ref(config), expected_state_ref=view.state_ref,
            )
        if state.phase == "forked":
            change = self._assemble(config, view, self._refine_change_id(view, c), refine_cid=self._cid(view, f"refine:{c}"))
            assert change is not None
            return ApplyChange(
                command_id=self._cid(view, f"apply:{c}"), change=change,
                strategy_ref=self._strategy_ref(config), expected_state_ref=view.state_ref,
            )
        if state.phase == "observe_post":
            if n < config.review_window:
                return ObserveCurrentState(
                    command_id=self._cid(view, f"post:{c}:{state.revised}:{state.defers}:{n}"),
                    detail="post-change observation",
                )
            if config.review_mode == "model":
                return self._review_command(config, view, c, state.defers, state.revised)
            return self._act_on_verdict(config, state, view, self._auto_verdict(config, state, view))
        if state.phase == "reviewed":
            rcid = self._cid(view, f"review:{c}:{state.revised}:{state.defers}")
            proposal = strat.proposal_for(view, rcid)
            verdict = proposal.review_hint if proposal is not None else "defer"
            return self._act_on_verdict(config, state, view, verdict)
        if state.phase == "cycle_end":
            if c + 1 < config.max_cycles:
                return ObserveCurrentState(
                    command_id=self._cid(view, f"warmup:{c + 1}:0"),
                    detail="next-cycle warm-up observation",
                )
            return StopAdaptation(
                command_id=self._cid(view, "stop-done"),
                reason=f"done after {c + 1} cycle(s); last verdict {state.verdict}",
            )
        return None  # done | failed

    def _refine_command(
        self, config: ContinualRefineConfig, view: RunView, cycle: int
    ) -> RequestRefinement:
        context = _build_refine_context(
            view, config, exclude_cid=self._cid(view, f"refine:{cycle}"), cycle=cycle
        )
        ref = hash_text(context)
        return RequestRefinement(
            command_id=self._cid(view, f"refine:{cycle}"), prompt_role="refine",
            model_role=config.model_role,
            context_ref=ref, content_blobs={ref: context},
            required_change_id=self._refine_change_id(view, cycle),
            edit_limit=config.edit_limit,
            enabled_surfaces=self._enabled_surface_specs(config), edit_rule="refine",
        )

    def _review_command(
        self, config: ContinualRefineConfig, view: RunView, cycle: int,
        defers: int, revised: int,
    ) -> RequestRefinement:
        rcid = self._cid(view, f"review:{cycle}:{revised}:{defers}")
        reviewing = (
            self._revise_change_id(view, cycle) if revised
            else self._refine_change_id(view, cycle)
        )
        context = _build_review_context(
            view, config, change_id=reviewing,
            refine_cid=self._cid(view, f"refine:{cycle}"),
            exclude_cid=rcid, cycle=cycle,
        )
        ref = hash_text(context)
        return RequestRefinement(
            command_id=rcid, prompt_role="review",
            model_role=config.model_role,
            context_ref=ref, content_blobs={ref: context},
            required_change_id=self._revise_change_id(view, cycle),
            edit_limit=config.edit_limit,
            enabled_surfaces=self._enabled_surface_specs(config), edit_rule="review",
        )

    def _auto_verdict(
        self, config: ContinualRefineConfig, state: ContinualRefineState, view: RunView
    ) -> str:
        """Auto review NEVER blindly keeps: with a fork, it uses the comparative
        result; otherwise it compares the pre-change and post-change operational
        observations and keeps ONLY on a measured improvement."""
        if config.use_fork and state.fork_improved is not None:
            return "keep" if state.fork_improved else "revert"
        pre, post = _pre_post_overall(view, state.change_id)
        if pre is not None and post is not None and post > pre:
            return "keep"
        return "revert"  # no measured improvement over pre-change behavior

    def _act_on_verdict(
        self, config: ContinualRefineConfig, state: ContinualRefineState,
        view: RunView, verdict: str,
    ) -> KernelCommand:
        c = state.cycle
        if verdict == "revert" and state.change_id is not None:
            return RevertChange(
                command_id=self._cid(view, f"revert:{c}"), change_id=state.change_id
            )
        if verdict == "revise" and state.revised == 0:  # one revise per cycle
            rcid = self._cid(view, f"review:{c}:{state.revised}:{state.defers}")
            change = self._assemble(
                config, view, self._revise_change_id(view, c),
                refine_cid=rcid, superseded=state.change_id,
            )
            if change is not None:
                return ApplyChange(
                    command_id=self._cid(view, f"revise-apply:{c}"), change=change,
                    strategy_ref=f"{self._strategy_ref(config)}:revises={state.change_id}",
                    expected_state_ref=view.state_ref,
                )
            verdict = "defer"  # an unassemblable revise gathers more instead
        elif verdict == "revise":  # a SECOND revise this cycle — bounded
            # NEVER silently confirm: a repeated revise past the one-per-cycle
            # bound leaves the change UNRESOLVED (unconfirmed), not kept.
            return StopAdaptation(
                command_id=self._cid(view, f"stop-unresolved:{c}"),
                reason="second revise in one cycle — left unresolved, not confirmed",
            )
        if verdict == "defer":
            if state.defers < _MAX_DEFERS:
                return ObserveCurrentState(
                    command_id=self._cid(view, f"post:{c}:{state.revised}:{state.defers + 1}:0"),
                    detail="deferred: gathering more observations",
                )
            # an EXHAUSTED defer stays UNRESOLVED — it does NOT silently confirm
            return StopAdaptation(
                command_id=self._cid(view, f"stop-unresolved:{c}"),
                reason=f"review unresolved after {state.defers} defer(s) — left unconfirmed",
            )
        # keep: confirm the applied change with its REAL rationale (not the verdict)
        if verdict == "keep" and state.change_id is not None:
            return ConfirmChange(
                command_id=self._cid(view, f"confirm:{c}"), change_id=state.change_id,
                rationale=_applied_rationale(view, self._cid(view, f"refine:{c}")),
            )
        return StopAdaptation(
            command_id=self._cid(view, f"stop:{c}"), reason=f"review verdict: {verdict}",
        )

    def reduce(
        self, config: ContinualRefineConfig, state: ContinualRefineState,
        result: CommandResult,
    ) -> ContinualRefineState:
        if result.outcome != "ok":
            return _with(state, phase="failed")
        k = result.kind
        if k == "ObserveCurrentState":
            if state.phase == "warmup":
                return _with(state, obs_done=state.obs_done + 1)
            if state.phase == "cycle_end":
                # the first warm-up observation of the NEXT cycle
                return ContinualRefineState(
                    phase="warmup", cycle=state.cycle + 1, obs_done=1,
                )
            if state.phase in ("observe_post", "reviewed"):
                # a fresh post/deferred observation window
                bumped = state.obs_done + 1 if state.phase == "observe_post" else 1
                defers = state.defers + (1 if state.phase == "reviewed" else 0)
                return _with(state, phase="observe_post", obs_done=bumped, defers=defers)
            return state
        if k == "RequestRefinement":
            if state.phase == "warmup":
                return _with(state, phase="proposed", obs_done=0)
            return _with(state, phase="reviewed")  # a review refinement
        if k == "EvaluateFork":
            return _with(
                state, phase="forked",
                fork_improved=result.metrics.get("improved", 0.0) == 1.0,
            )
        if k == "ApplyChange":
            change_id = result.proposal.change_id if result.proposal else state.change_id
            if state.phase in ("proposed", "forked"):
                # the initial apply: operate again over the review window
                return _with(state, phase="observe_post", obs_done=0, change_id=change_id)
            # a revise-apply: OBSERVE the revised state and REVIEW it before
            # confirming (lineage to the superseded change is in the annotation);
            # reset the defer budget for the revised change's review
            return _with(
                state, phase="observe_post", obs_done=0, defers=0, revised=1,
                change_id=change_id, verdict="revise",
            )
        if k == "ConfirmChange":
            return _with(state, phase="cycle_end", verdict=state.verdict or "keep")
        if k == "RevertChange":
            return _with(state, phase="cycle_end", verdict="revert")
        if k == "StopAdaptation":
            return _with(state, phase="done")
        return state

    # -- assembling one atomic coupled change from a proposal ---------------------

    def _strategy_ref(self, config: ContinualRefineConfig) -> str:
        return f"{STRATEGY_REF}:{'+'.join(config.enabled_strategies)}"

    def _assemble(
        self, config: ContinualRefineConfig, view: RunView, change_id: str,
        *, refine_cid: str, superseded: str | None = None,
    ) -> CompositeChange | None:
        proposal = strat.proposal_for(view, refine_cid)
        if proposal is None or proposal.change_id != change_id:
            return None
        deltas: list[SurfaceDelta] = []
        for surface in config.enabled_strategies:
            delta = self._strategies[surface].delta_for(view, proposal)
            if delta is not None:
                deltas.append(delta)
        if not deltas:
            return None
        summary = proposal.rationale
        if superseded is not None:
            summary = f"revises {superseded}: {summary}"  # lineage annotation
        return CompositeChange(change_id=change_id, deltas=tuple(deltas), summary=summary)


def _with(state: ContinualRefineState, **changes: object) -> ContinualRefineState:
    from dataclasses import replace

    return replace(state, **changes)  # type: ignore[arg-type]


def _surface_specs(config: ContinualRefineConfig) -> tuple[str, ...]:
    return tuple(
        f"{_SURFACE_KEY[s][0]}/{_SURFACE_KEY[s][1]}" for s in config.enabled_strategies
    )


# -- context rendering (deterministic; excludes the in-flight command's events) -------------------


def _observations(view: RunView, exclude_cid: str) -> list[tuple[AttemptRecord, Evaluation]]:
    out: list[tuple[AttemptRecord, Evaluation]] = []
    for body in view.bodies:
        if not (isinstance(body, ObservationRecorded) and body.observation_kind == OPERATION_RESULT):
            continue
        from strive import codec

        rec = codec.loads(view.read_text(body.observation_ref), AttemptRecord)
        if rec.command_id == exclude_cid:
            continue
        ev = codec.loads(view.read_text(rec.evaluation_ref), Evaluation)
        out.append((rec, ev))
    return out


def _prior_proposals(view: RunView, exclude_cid: str) -> list[RefinementProposal]:
    out: list[RefinementProposal] = []
    from strive import codec

    for body in view.bodies:
        if not (isinstance(body, ObservationRecorded) and body.observation_kind == REFINE_RESULT):
            continue
        res = codec.loads(view.read_text(body.observation_ref), ModelResult)
        if res.command_id == exclude_cid or res.proposal_ref is None:
            continue
        out.append(codec.loads(view.read_text(res.proposal_ref), RefinementProposal))
    return out


def _build_refine_context(
    view: RunView, config: ContinualRefineConfig, *, exclude_cid: str, cycle: int
) -> str:
    """Deterministic refiner context from REAL feedback: recent observations
    (scores + the exact failing cases to cite), prior rationale/citations/
    expected outcomes, applied/reverted changes, usage counts, and failures. It
    excludes the in-flight refine's own events so the payload digest is stable
    across a crash-forced re-derivation."""
    lines = [f"cycle: {cycle}"]
    lines.append("=== constraints (your proposal MUST satisfy these) ===")
    lines.append(f"required_change_id: {view.run_id}:refine-change:{cycle}")
    lines.append(f"enabled_surfaces: {list(_surface_specs(config))}")
    lines.append(f"edit_limit: {config.edit_limit}")
    code_ref = view.state.content_ref("strategy-code", "solve")
    lines.append("=== active strategy ===")
    lines.append(view.read_text(code_ref) if code_ref else "<none>")

    obs = _observations(view, exclude_cid)[-config.trajectory_window:]
    lines.append("=== observed behavior (operate the current harness) ===")
    for rec, ev in obs:
        failing = [ce for ce in ev.case_evaluations if not ce.passed]
        lines.append(f"observation overall={rec.overall:.4f} ok={rec.ok}")
        for ce in failing:
            lines.append(
                f"  FAIL case {ce.case_id}: expected {ce.expected}, got {ce.output} "
                f"({(ce.error or '').strip().splitlines()[-1] if ce.error else 'wrong'})"
            )

    priors = _prior_proposals(view, exclude_cid)[-config.trajectory_window:]
    if priors:
        lines.append("=== prior refinements ===")
        for p in priors:
            lines.append(
                f"  change {p.change_id}: {p.rationale} | cited {list(p.cited_evidence)} "
                f"| expected {list(p.expected_outcomes)}"
            )

    changes: list[str] = []
    fails = 0
    for body in view.bodies:
        if isinstance(body, ChangeApplied):
            changes.append(f"applied {body.change_id}")
        elif isinstance(body, ChangeReverted):
            changes.append(f"reverted {body.change_id}")
        elif isinstance(body, OperationFailed) and body.command_id != exclude_cid:
            fails += 1
    lines.append("=== changes & usage ===")
    lines.extend(changes[-config.trajectory_window:])
    lines.append(f"observations so far: {len(obs)}; recorded failures: {fails}")
    return "\n".join(lines) + "\n"


def _post_apply_observations(
    view: RunView, change_id: str | None
) -> list[tuple[AttemptRecord, Evaluation]]:
    """Operation observations recorded AFTER the given change was applied — the
    only feedback a review of that change may consider."""
    from strive import codec

    out: list[tuple[AttemptRecord, Evaluation]] = []
    seen_apply = change_id is None
    for body in view.bodies:
        if isinstance(body, ChangeApplied) and body.change_id == change_id:
            seen_apply = True
        elif (
            seen_apply
            and isinstance(body, ObservationRecorded)
            and body.observation_kind == OPERATION_RESULT
        ):
            rec = codec.loads(view.read_text(body.observation_ref), AttemptRecord)
            ev = codec.loads(view.read_text(rec.evaluation_ref), Evaluation)
            out.append((rec, ev))
    return out


def _pre_post_overall(
    view: RunView, change_id: str | None
) -> tuple[float | None, float | None]:
    """The last operation overall BEFORE and AFTER the change was applied."""
    from strive import codec

    pre: float | None = None
    post: float | None = None
    seen_apply = False
    for body in view.bodies:
        if isinstance(body, ChangeApplied) and body.change_id == change_id:
            seen_apply = True
        elif isinstance(body, ObservationRecorded) and body.observation_kind == OPERATION_RESULT:
            rec = codec.loads(view.read_text(body.observation_ref), AttemptRecord)
            if seen_apply:
                post = rec.overall
            else:
                pre = rec.overall
    return pre, post


def _applied_rationale(view: RunView, refine_cid: str) -> str:
    """The ORIGINAL rationale a `keep` confirms with — the refinement's own
    rationale, never the bare verdict string."""
    proposal = strat.proposal_for(view, refine_cid)
    return proposal.rationale if proposal is not None else "kept after review"


def _build_review_context(
    view: RunView, config: ContinualRefineConfig, *, change_id: str | None,
    refine_cid: str, exclude_cid: str, cycle: int
) -> str:
    """Deterministic review context: the exact applied change with its ORIGINAL
    rationale/citations/expected outcomes, any fork evidence, and ONLY the
    operation observations recorded AFTER the change was applied."""
    from strive import codec

    lines = [f"cycle: {cycle}", f"reviewing change: {change_id}"]
    lines.append("=== constraints (a revise MUST use these) ===")
    lines.append(f"required_change_id: {view.run_id}:revise-change:{cycle}")
    lines.append(f"enabled_surfaces: {list(_surface_specs(config))}")
    proposal = strat.proposal_for(view, refine_cid)
    if proposal is not None:
        lines.append("=== the applied change ===")
        lines.append(f"rationale: {proposal.rationale}")
        lines.append(f"cited_evidence: {list(proposal.cited_evidence)}")
        lines.append(f"expected_outcomes: {list(proposal.expected_outcomes)}")
    for body in view.bodies:  # optional fork evidence, if the policy gathered it
        if isinstance(body, ObservationRecorded) and body.observation_kind == FORK_SUMMARY:
            fork = codec.loads(view.read_text(body.observation_ref), ForkObservation)
            lines.append(
                f"fork evidence: base={fork.base_overall:.4f} "
                f"candidate={fork.candidate_overall:.4f} improved={fork.improved}"
            )
    lines.append("=== behavior AFTER the change ===")
    for rec, ev in _post_apply_observations(view, change_id)[-config.trajectory_window:]:
        failing = [ce.case_id for ce in ev.case_evaluations if not ce.passed]
        lines.append(f"observation overall={rec.overall:.4f} failing={failing}")
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
    requires_secure_execution=True,
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
