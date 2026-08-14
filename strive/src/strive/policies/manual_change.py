"""`manual-change@1` — the deterministic Phase-A proof policy.

It proves the substrate + policy command boundary WITHOUT overbuilding
policy behavior or a model refiner: it constructs ONE typed, coupled
prompt+code change from its frozen config, requests an OPTIONAL fork
observation of the candidate, applies the change exactly, then reverts it
exactly — checkpointing after each step so the kernel can crash and resume
at any boundary without repeating a side effect.

A policy package is: typed code (this module — the state machine), a frozen
config dataclass loaded from TOML (`manual_change.toml`), and versioned
Markdown model-facing instructions (`prompts/*.md`). The config, prompt
refs, seed, and policy implementation are pinned per run; the concrete
change is a strict typed value (`CompositeChange`), not free-form text.
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
    PolicyDescriptor,
    RevertChange,
    RunView,
    Step,
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
CHANGE_ID = "manual-change-1"

# the coupled surfaces this policy changes (both allowlisted)
_CODE = ("strategy-code", "solve")
_PROMPT = ("prompt", "proposal-template")


@dataclass(frozen=True)
class ManualChangeConfig:
    """Frozen, policy-specific config (loaded from TOML). The exact target
    prompt template and strategy source the single change installs."""

    summary: str
    target_prompt: str
    target_strategy: str


@dataclass(frozen=True)
class ManualChangeState:
    """The policy's content-addressable state machine value."""

    phase: str  # start -> observed -> applied -> reverted -> done


def load_config(path: str) -> ManualChangeConfig:
    with open(path, "rb") as handle:
        data = tomllib.load(handle)
    section = data.get("manual_change", data)
    return ManualChangeConfig(
        summary=str(section["summary"]),
        target_prompt=str(section["target_prompt"]),
        target_strategy=str(section["target_strategy"]),
    )


class ManualChangePolicy:
    """The one active orchestrating policy for a manual-change run."""

    name = "manual-change@1"

    def initial_state(
        self, config: ManualChangeConfig, view: RunView
    ) -> ManualChangeState:
        return ManualChangeState(phase="start")

    def decode_state(self, data: object) -> ManualChangeState:
        assert isinstance(data, dict)
        return ManualChangeState(phase=str(data["phase"]))

    def step(
        self,
        config: ManualChangeConfig,
        state: ManualChangeState,
        view: RunView,
        last_result: CommandResult | None,
    ) -> Step[ManualChangeState]:
        if state.phase == "start":
            # OPTIONAL comparative observation of the candidate (a mechanism
            # the policy requests, never an activation prerequisite)
            change, blobs = self._build_change(config, view)
            return Step(
                commands=(
                    EvaluateFork(
                        command_id="mc-fork",
                        candidate=change,
                        content_blobs=blobs,
                        detail="observe the coupled prompt+code candidate",
                    ),
                ),
                next_state=ManualChangeState("observed"),
            )
        if state.phase == "observed":
            change, blobs = self._build_change(config, view)
            return Step(
                commands=(
                    ApplyChange(
                        command_id="mc-apply", change=change, content_blobs=blobs
                    ),
                ),
                next_state=ManualChangeState("applied"),
            )
        if state.phase == "applied":
            return Step(
                commands=(
                    RevertChange(command_id="mc-revert", change_id=CHANGE_ID),
                ),
                next_state=ManualChangeState("reverted"),
            )
        if state.phase == "reverted":
            return Step(
                commands=(
                    StopAdaptation(command_id="mc-stop", reason="manual change complete"),
                ),
                next_state=ManualChangeState("done"),
                done=True,
            )
        return Step(
            commands=(StopAdaptation(command_id="mc-stop", reason="already done"),),
            next_state=state,
            done=True,
        )

    def _build_change(
        self, config: ManualChangeConfig, view: RunView
    ) -> tuple[CompositeChange, dict[str, str]]:
        """Build the exact coupled change from the SEED state and the frozen
        config. Using the pinned seed (not the current view) makes the change
        stable across resume: after a crash post-apply, re-deriving it yields
        the same change, and the kernel's idempotency skips re-applying.
        Content refs are PURE content addresses; the new content travels in
        `blobs` for the kernel to stage (the policy never writes CAS)."""
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
            change_id=CHANGE_ID,
            deltas=(
                SurfaceDelta(_CODE[0], _CODE[1], code_before, code_after),
                SurfaceDelta(_PROMPT[0], _PROMPT[1], prompt_before, prompt_after),
            ),
            summary=config.summary,
        )
        blobs = {
            code_after: config.target_strategy,
            prompt_after: config.target_prompt,
        }
        return change, blobs


# -- seed + prompt helpers (used by the CLI / tests to prepare a run) -----------------------------


def seed_state(objects: ObjectStore, *, code: str, prompt: str) -> HarnessState:
    """Install a baseline composite state's content into CAS and return the
    canonical HarnessState (the run's seed identity)."""
    return canonical_state(
        {
            _CODE: objects.put_text(code),
            _PROMPT: objects.put_text(prompt),
        }
    )


def prompt_refs(objects: ObjectStore) -> dict[str, str]:
    """Content-address the policy's versioned Markdown instructions and
    return role → CAS ref (pinned per run)."""
    refs: dict[str, str] = {}
    for role, filename in DESCRIPTOR.prompt_files.items():
        refs[role] = objects.put_text(Path(filename).read_text(encoding="utf-8"))
    return refs


DESCRIPTOR = PolicyDescriptor(
    name="manual-change@1",
    factory=ManualChangePolicy,
    config_loader=load_config,
    prompt_files={"refine": str(_PROMPT_DIR / "manual_change_refine@1.md")},
)

DEFAULT_CONFIG_PATH = str(Path(__file__).with_name("manual_change.toml"))


__all__ = [
    "CHANGE_ID",
    "DEFAULT_CONFIG_PATH",
    "DESCRIPTOR",
    "ManualChangeConfig",
    "ManualChangePolicy",
    "ManualChangeState",
    "load_config",
    "prompt_refs",
    "seed_state",
]
