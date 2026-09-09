"""Complete research workflow against the actual offline runtime."""
from dataclasses import replace
from pathlib import Path
import sys

import pytest

from strive.vnext.cli.app import main, status
from strive.vnext.cli.data import json_bytes, mapping, read_json, sequence, toml
from strive.vnext.cli.fixture import example
from strive.vnext.cli.runner import Session, manifest_for, reader, resume, run, run_directory
from strive.vnext.codec import encode
from strive.vnext.contracts.annotations import Annotation
from strive.vnext.contracts.primitives import ExecutionStatus, Resource
from strive.vnext.contracts.records import CausalIdentity, ProducerKind
from strive.vnext.errors import VerificationError
from strive.vnext.report.compare import compare, comparison_spec, export
from strive.vnext.report.history import expenditure, history, invocation_inputs
from strive.vnext.runtime.supervisor import Boundary
from strive.vnext.study.experiment import allocate, experiment

from .workflow_fixtures import campaign, edit_manifest, spec


def test_run_resolves_displays_before_dispatch_and_rejects_id_reuse(tmp_path: Path) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    def displayed(text: str) -> None:
        assert "configuration_digest" in text
        assert not reader(root, "run-1").verify().effects
    state = run(root, path, "run-1", display=displayed)
    assert state.execution_status is ExecutionStatus.FINISHED
    assert [m.metric_value for m in state.measurements] == [0, 1]
    resolved = manifest_for(reader(root, "run-1"))
    assert reader(root, "run-1").objects.read(resolved.authored_manifest) == path.read_bytes()
    import shutil
    from strive.vnext.codec import content_ref
    deno = shutil.which("deno")
    assert deno is not None
    executable = Path(deno).read_bytes()
    assert content_ref(executable) in resolved.closure.dependency_artifacts
    assert reader(root, "run-1").objects.read(content_ref(executable)) == executable
    with pytest.raises(FileExistsError):
        run(root, path, "run-1")


def test_resume_preserves_spending_and_retained_config(tmp_path: Path) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None, dispatch=False)
    with Session(run_directory(root, "run-1"), "run-1") as session:
        def interrupt(point: Boundary) -> None:
            if point is Boundary.SETTLED and any(q.resource is Resource.MODEL_CALLS for q in session.supervisor.state.measured):
                raise InterruptedError("after paid-shaped fixture settlement")
        session.supervisor.fault = interrupt
        with pytest.raises(InterruptedError):
            session.drive()
        spent = session.reader.verify().measured
    path.write_text("authoring file changed after resolution")
    with pytest.raises(VerificationError, match="overrides"):
        resume(root, "run-1", overrides={"budget.tokens": 999999})
    state = resume(root, "run-1")
    assert state.execution_status is ExecutionStatus.FINISHED
    assert next(q.quantity for q in state.measured if q.resource is Resource.MODEL_CALLS) == 1
    assert all(next(v.quantity for v in state.measured if v.resource == q.resource) >= q.quantity for q in spent)
    previous = state.head
    assert resume(root, "run-1").head == previous


def test_compare_matched_descriptive_and_no_dispatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "adapting", display=lambda _: None)
    edit_manifest(path, "run", "editable", [])
    run(root, path, "fixed", display=lambda _: None)
    a, b = reader(root, "fixed"), reader(root, "adapting")
    before = (a.journal.path.read_bytes(), b.journal.path.read_bytes())
    monkeypatch.setattr(Session, "drive", lambda _: pytest.fail("comparison dispatched"))
    report = compare([a], [b], spec())
    assert report["comparison_strength"] == "matched"
    assert mapping(report["uncertainty"])["interval"] is None
    assert export(report, tmp_path / "report")[0].exists()
    assert (a.journal.path.read_bytes(), b.journal.path.read_bytes()) == before
    spec_path = tmp_path / "paired.toml"
    spec_path.write_text(toml(spec()))
    assert main(["--root", str(root), "compare", "fixed", "adapting", "--spec", str(spec_path)]) == 0
    edit_manifest(path, "budget", "model_calls", 9)
    # Setup only is enough to validate mismatched budgets without another effect.
    run(root, path, "different", display=lambda _: None, dispatch=False)
    with pytest.raises(VerificationError, match="unmatched"):
        compare([a], [reader(root, "different")], spec())
    descriptive = compare([a], [reader(root, "different")], spec("descriptive"))
    assert descriptive["claim"] == "descriptive outcomes only"
    assert mapping(descriptive["uncertainty"])["incomplete_pairs"] == 1


def test_experiment_stable_mapping_restart_and_separate_allocations(tmp_path: Path) -> None:
    path = campaign(tmp_path / "inputs", reps=2)
    root = tmp_path / "state"
    directory, allocation = allocate(root, path)
    rows = [mapping(r) for r in sequence(allocation["runs"])]
    assert [(r["arm"], r["repetition"], r["seed"]) for r in rows] == [
        ("fixed", 0, 17), ("fixed", 1, 18), ("adapting", 0, 17), ("adapting", 1, 18)]
    assert not (root / "runs").exists()
    mapping_bytes = (directory / "allocation.json").read_bytes()
    experiment(root, path, stop_after=1, audit=False)
    first = reader(root, "reference-fixed-0").verify().head
    report = experiment(root, path, audit=False)
    assert reader(root, "reference-fixed-0").verify().head == first
    assert (directory / "allocation.json").read_bytes() == mapping_bytes
    assert len(list((root / "runs").iterdir())) == 4
    assert mapping(report["uncertainty"])["complete_pairs"] == 2
    assert mapping(report["uncertainty"])["interval"] == [1.0, 1.0]
    assert allocation["audit_allocation"] is not allocation["development_allocation"]
    path.write_text(path.read_text().replace('"repetitions" = 2', '"repetitions" = 3'))
    with pytest.raises(VerificationError):
        experiment(root, path)


def test_reporting_full_denominators_labels_and_trusted_only(tmp_path: Path) -> None:
    path = example(tmp_path)
    edit_manifest(path, "budget", "model_calls", 0)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None)
    with Session(run_directory(root, "run-1"), "run-1") as session:
        state = session.reader.verify()
        for namespace in ("candidate.claim", "judge.score"):
            session.writer.port(ProducerKind.CANDIDATE).append(Annotation(namespace, b'{"metric_value":9999}'),
                causal=CausalIdentity(state.records[-1].envelope.record_id, None, None, None), epoch=session.writer.epoch)
    report = history(reader(root, "run-1"))
    assert report["coverage"] == {"planned": 2, "admitted": 1, "completed": 1, "failed": 0,
                                    "task_failures": 1, "excluded": 0, "unresolved": 1}
    assert mapping(report["performance"])["outcome_bounds"] == ["0", "1"]
    assert len(mapping(report["labels"])) == 3
    assert len(sequence(report["candidate_claims"])) >= 1
    assert len(sequence(report["judge_assessments"])) == 1
    assert [mapping(v)["value"] for v in sequence(report["official_measurements"])] == ["0"]


def test_status_follow_read_only_and_exact_model_inputs(tmp_path: Path) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None, dispatch=False)
    follow = status(root, "run-1", follow=True, interval=0, updates=2)
    first = next(follow)
    assert mapping(first["coverage"])["completed"] == 0
    resume(root, "run-1")
    read = reader(root, "run-1")
    before = read.journal.path.read_bytes()
    second = next(follow)
    assert second["active_revision"] != first["active_revision"]
    assert mapping(second["coverage"])["completed"] == 2
    assert {"current_work", "suspension_reason", "expenditure", "retention", "telemetry"} <= second.keys()
    inputs = invocation_inputs(read)
    assert len(inputs) == 1 and inputs[0]["label"] == "sent to the model"
    assert inputs[0]["supplied_components"]
    assert read.journal.path.read_bytes() == before


def test_cli_commands_use_real_runner(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = example(tmp_path)
    prefix = ["--root", str(tmp_path / "state")]
    assert main(prefix + ["run", str(path), "--id", "cli"]) == 0
    assert "Resolved configuration before dispatch" in capsys.readouterr().out
    assert main(prefix + ["resume", "cli"]) == 0
    assert main(prefix + ["status", "cli", "--follow"]) == 0
    assert main(prefix + ["run", str(path), "--id", "cli"]) == 1
    assert "sent to the model" in capsys.readouterr().out


@pytest.mark.parametrize("setting,value", [("provider", "openai"), ("model", "latest"), ("request_options", "builtin:prices")])
def test_resolver_refuses_scientific_provider_conflicts(tmp_path: Path, setting: str, value: str) -> None:
    path = example(tmp_path)
    from strive.vnext.cli.data import toml, mapping
    import tomllib
    data = mapping(tomllib.loads(path.read_text()))
    models = mapping(data["models"])
    model = mapping(models["refiner"])
    model[setting] = value
    models["refiner"] = model
    data["models"] = models
    path.write_text(toml(data))
    with pytest.raises(VerificationError):
        run(tmp_path / "state", path, "run-1", display=lambda _: None)


def test_m7_history_replays_in_fresh_pure_interpreter(tmp_path: Path) -> None:
    from .fresh_probe import fresh_replay
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None)
    fresh_replay(run_directory(root, "run-1") / "artifacts", corrupt=False, benchmark=True)


@pytest.mark.parametrize("stage", ["directory", "authority-before-binding"])
def test_declared_runs_with_incomplete_setup_remain_in_report(tmp_path: Path, stage: str) -> None:
    path = campaign(tmp_path / "inputs")
    root = tmp_path / "state"
    allocate(root, path)
    if stage == "directory":
        run_directory(root, "reference-fixed-0").mkdir(parents=True)
    else:
        run(root, path.parent / "counter.toml", "reference-fixed-0", dispatch=False, display=lambda _: None)
        reader(root, "reference-fixed-0").journal.path.write_bytes(b"")
    report = experiment(root, path, audit=False)
    runs = [mapping(r) for r in sequence(report["runs"])]
    assert len(runs) == 2
    assert runs[0]["status"] == "indeterminate"
    assert mapping(runs[0]["coverage"])["unresolved"] == 2
    assert mapping(report["uncertainty"])["interval"] is None
    assert not reader(root, "reference-adapting-0").verify().effects


def test_missing_usage_is_unknown_not_zero(tmp_path: Path) -> None:
    from strive.vnext.cli.fixture import FixtureProvider
    class MissingUsage(FixtureProvider):
        def generate(self, request: bytes, operation_key: str) -> bytes:
            response = read_json(super().generate(request, operation_key))
            response.pop("usage")
            return json_bytes(response)
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None, dispatch=False)
    with Session(run_directory(root, "run-1"), "run-1", upstream=MissingUsage()) as session:
        state = session.drive()
    totals = expenditure(state)
    assert totals["unknown"]
    assert mapping(totals["reserved"])["input_tokens"] == 100
    assert "input_tokens" not in mapping(totals["settled_usage"])


def test_changed_actor_bytes_cannot_hide_behind_allowed_policy_change(tmp_path: Path) -> None:
    from strive.vnext.cli.fixture import ACTOR
    path = example(tmp_path)
    root = tmp_path / "state"
    edit_manifest(path, "comparison", "allowed_differences", ["policy.package"])
    run(root, path, "a", display=lambda _: None, dispatch=False)
    bundle = tmp_path / "actor"
    for name, data in {"actor/step.js": ACTOR, "prompts/delta.txt": b"9", "memory/delta.txt": b"0"}.items():
        target = bundle / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    edit_manifest(path, "pins", "initial_bundle", "./actor")
    run(root, path, "b", display=lambda _: None, dispatch=False)
    plan = {**spec(), "allowed_differences": ["policy.package"]}
    with pytest.raises(VerificationError, match="pins.initial_bundle.prompts"):
        compare([reader(root, "a")], [reader(root, "b")], plan)


def test_policy_package_cannot_smuggle_actor_components(tmp_path: Path) -> None:
    from strive.vnext.cli.fixture import CONTROLLER
    path = example(tmp_path)
    package = tmp_path / "policy"
    for name, data in {"controller/step.js": CONTROLLER, "memory/hidden.txt": b"undeclared actor intervention"}.items():
        target = package / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    edit_manifest(path, "policy", "package", "./policy")
    with pytest.raises(VerificationError, match="ownership"):
        run(tmp_path / "state", path, "run-1", display=lambda _: None, dispatch=False)


def test_cli_routing_does_not_treat_root_as_command() -> None:
    from strive.vnext.cli.app import accepts
    assert not accepts(["--root", "project", "run", "--seed", "1"])
    assert accepts(["--root", "project", "resume", "run-1"])


def test_stopped_budget_work_keeps_unresolved_coverage(tmp_path: Path) -> None:
    path = example(tmp_path)
    edit_manifest(path, "budget", "wall_seconds", 0)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None)
    report = history(reader(root, "run-1"))
    assert report["status"] == "suspended"
    assert mapping(report["coverage"])["unresolved"] == 2
    assert report["suspension_reason"]
