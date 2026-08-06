"""CLI: machine-readable envelopes, clean diagnostics, no tracebacks."""

import json
from pathlib import Path
from typing import Any

import pytest

from strive.cli import main


def _run_json(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, dict[str, Any]]:
    code = main(["--json", *argv])
    out = capsys.readouterr().out.strip().splitlines()[-1]
    envelope = json.loads(out)
    assert isinstance(envelope, dict)
    return code, envelope


def test_run_emits_machine_readable_envelope(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = str(tmp_path / "artifacts")
    code, envelope = _run_json(capsys, "--artifacts", artifacts, "run")
    assert code == 0
    assert envelope["ok"] is True and envelope["command"] == "run"
    data = envelope["data"]
    assert data["decision"]["accepted"] is True
    assert data["generation_after"] != data["generation_before"]
    assert set(data["split_scores"]) >= {"visible", "held_out", "adversarial"}


def test_lineage_inspect_compare_replay_round_trip(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = str(tmp_path / "artifacts")
    code, run_env = _run_json(capsys, "--artifacts", artifacts, "run")
    assert code == 0
    run_id = run_env["data"]["run_id"]
    gen_before = run_env["data"]["generation_before"]
    gen_after = run_env["data"]["generation_after"]

    code, lineage = _run_json(capsys, "--artifacts", artifacts, "lineage")
    assert code == 0
    ids = [g["generation_id"] for g in lineage["data"]["lineage"]]
    assert ids == [gen_after, gen_before]

    code, inspect = _run_json(
        capsys, "--artifacts", artifacts, "inspect", "--generation", gen_after
    )
    assert code == 0
    assert "solve" in inspect["data"]["source"]
    assert inspect["data"]["generation"]["decision"]["accepted"] is True

    code, inspect_run = _run_json(
        capsys, "--artifacts", artifacts, "inspect", "--run", run_id
    )
    assert code == 0
    event_types = [e["type"] for e in inspect_run["data"]["events"]]
    assert "cycle_started" in event_types and "decision" in event_types

    code, compare = _run_json(
        capsys, "--artifacts", artifacts, "compare", gen_before, gen_after
    )
    assert code == 0
    assert compare["data"]["decision"]["accepted"] is True
    assert compare["data"]["candidate"]["overall"] == 1.0

    code, replay = _run_json(capsys, "--artifacts", artifacts, "replay", run_id)
    assert code == 0
    assert replay["data"]["matches"] is True
    assert replay["data"]["task_drift"] is False


def test_promote_requires_paired_evidence_and_rollback_works(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = str(tmp_path / "artifacts")
    _, run_env = _run_json(capsys, "--artifacts", artifacts, "run")
    gen_before = run_env["data"]["generation_before"]
    gen_after = run_env["data"]["generation_after"]

    # demoting to the weaker seed must be refused by the policy
    code, refused = _run_json(capsys, "--artifacts", artifacts, "promote", gen_before)
    assert code == 1
    assert refused["ok"] is False and "promotion refused" in refused["error"]

    code, rollback = _run_json(capsys, "--artifacts", artifacts, "rollback")
    assert code == 0
    assert rollback["data"]["active_generation"]["generation_id"] == gen_before

    # promoting the genuinely better generation back passes the paired gate
    code, promoted = _run_json(capsys, "--artifacts", artifacts, "promote", gen_after)
    assert code == 0
    assert promoted["data"]["decision"]["accepted"] is True
    assert promoted["data"]["activation"]["generation_id"] == gen_after


def test_corrupt_ledger_yields_clean_error_envelope(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = tmp_path / "artifacts"
    _run_json(capsys, "--artifacts", str(artifacts), "run")
    ledger = artifacts / "ledger" / "ledger.jsonl"
    lines = ledger.read_bytes().splitlines(keepends=True)
    lines[0] = b'{"schema":"generation@1","garbage":true}\n'
    ledger.write_bytes(b"".join(lines))

    code, envelope = _run_json(capsys, "--artifacts", str(artifacts), "status")
    assert code == 1
    assert envelope["ok"] is False
    assert "LedgerError" in envelope["error"]


def test_resume_without_freeze_is_a_clean_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = str(tmp_path / "artifacts")
    _run_json(capsys, "--artifacts", artifacts, "run")
    code, envelope = _run_json(capsys, "--artifacts", artifacts, "resume")
    assert code == 1
    assert envelope["ok"] is False and "not frozen" in envelope["error"]


def test_unknown_generation_is_a_clean_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = str(tmp_path / "artifacts")
    _run_json(capsys, "--artifacts", artifacts, "run")
    code, envelope = _run_json(
        capsys, "--artifacts", artifacts, "inspect", "--generation", "gen-9999"
    )
    assert code == 1
    assert envelope["ok"] is False and "unknown generation" in envelope["error"]
