from pathlib import Path

import pytest

from strive.cli.data import mapping, read_json, sequence
from strive.cli.runner import Session, reader, resume, run_directory
from strive.errors import VerificationError
from strive.study.audit import execute_audit, freeze, release
from strive.study.experiment import allocate, experiment

from .workflow_fixtures import campaign


def test_audit_requires_freeze_and_exports_only_after_procedure(tmp_path: Path) -> None:
    path = campaign(tmp_path / "inputs")
    root = tmp_path / "state"
    directory, allocation = allocate(root, path)
    with pytest.raises(VerificationError, match="freeze"):
        execute_audit(root, directory, allocation)
    experiment(root, path, audit=False)
    with Session(run_directory(root, "reference-adapting-0"), "reference-adapting-0"):
        with pytest.raises(BlockingIOError):
            freeze(root, directory, allocation)
    frozen = freeze(root, directory, allocation)
    with pytest.raises(FileNotFoundError):
        release(root, directory)
    execute_audit(root, directory, allocation)
    assert release(root, directory)["audited"] == 2
    audit_root = root / "audit/reference"
    a = reader(audit_root, "reference-adapting-0-audit")
    before = a.verify().head
    assert experiment(root, path)["audited"] == 2
    assert a.verify().head == before
    with pytest.raises(VerificationError, match="frozen"):
        resume(root, "reference-adapting-0")
    for raw in sequence(frozen["selected"]):
        row = mapping(raw)
        assert row["head"] and row["bundle"]
    assert not (root / "runs/reference-adapting-0/reports").exists()


def test_invalid_selection_rejected_before_any_run(tmp_path: Path) -> None:
    path = campaign(tmp_path / "inputs")
    path.write_text(path.read_text().replace("final_valid_active_actor_from_every_trajectory", "best_audit_score"))
    with pytest.raises(VerificationError, match="selection"):
        experiment(tmp_path / "state", path)
    assert not (tmp_path / "state/runs").exists()
