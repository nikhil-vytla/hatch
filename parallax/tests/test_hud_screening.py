from __future__ import annotations

from pathlib import Path

from test_swebench import INSTANCE_ID, construction, row, runtime

from parallax.hud_screening import HudExecutor
from parallax.screening import ScreeningUnit
from parallax.swebench import build_swe_script_family, load_swebench_rows


def executor(tmp_path: Path) -> HudExecutor:
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    family = build_swe_script_family(
        problem,
        construction(),
        total_agent_steps=12,
        max_output_tokens=4096,
    )
    return HudExecutor(
        {str(problem.record_id): family},
        model="claude-opus-4-8",
        work_directory=tmp_path,
    )


def unit(arm: str, trial_index: int) -> ScreeningUnit:
    return ScreeningUnit(
        source_id=f"swebench:{INSTANCE_ID}",
        source_digest="a" * 64,
        verifier_digest="b" * 64,
        trial_index=trial_index,
        trial_seed=11,
        arm=arm,
    )


def test_per_unit_paths_separate_the_arms_of_one_trial(tmp_path: Path) -> None:
    """A cache keyed on instance and trial alone served one arm's paid episode
    to the other, and a driver worked around it with one executor per arm."""
    hud = executor(tmp_path)

    static = hud._unit_directory("episodes", unit("static", 0))
    evolved = hud._unit_directory("episodes", unit("evolved", 0))

    assert static != evolved
    assert str(unit("static", 0).arm) in static.name
    assert str(unit("evolved", 0).arm) in evolved.name


def test_per_unit_paths_separate_trials_of_one_arm(tmp_path: Path) -> None:
    hud = executor(tmp_path)

    first = hud._unit_directory("episodes", unit("evolved", 0))
    second = hud._unit_directory("episodes", unit("evolved", 1))

    assert first != second


def test_every_unit_of_a_design_gets_its_own_path(tmp_path: Path) -> None:
    hud = executor(tmp_path)
    units = [unit(arm, trial) for arm in ("static", "evolved") for trial in (0, 1, 2)]

    for root in ("episodes", "official-harness"):
        paths = {hud._unit_directory(root, item) for item in units}
        assert len(paths) == len(units)
