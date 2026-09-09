import ast
from pathlib import Path

import pytest

from strive.vnext.cli.data import mapping, read_json, sequence
from strive.vnext.cli.fixture import example
from strive.vnext.cli.runner import reader, resume, run, run_directory
from strive.vnext.contracts.manifest import TelemetryProfile
from strive.vnext.report.history import expenditure
from strive.vnext.telemetry.projector import HTTPExporter, MemoryExporter, Projector, cursor_status, project, project_metrics


def test_projector_outage_rebuild_and_no_double_count(tmp_path: Path) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None, dispatch=False)
    read = reader(root, "run-1")
    exporter = MemoryExporter()
    exporter.unavailable = True
    cursor = tmp_path / "telemetry/cursor.json"
    projector = Projector(read, cursor, exporter)
    assert projector.flush()["backlog"] == len(read.verify().records)
    # Export is down for the entire dispatch/recovery/scoring/accounting loop.
    state = resume(root, "run-1")
    assert [m.metric_value for m in state.measurements] == [0, 1]
    official = expenditure(state)
    journal = read.journal.path.read_bytes()
    assert projector.flush()["backlog"] == len(state.records)
    assert not cursor.exists()
    exporter.unavailable = False
    assert projector.flush()["backlog"] == 0
    count = len(exporter.spans)
    projector.flush(rebuild=True)
    assert len(exporter.spans) == count
    cursor.unlink()
    assert cursor_status(cursor, len(state.records))["backlog"] == len(state.records)
    projector.flush()
    assert len(exporter.spans) == count
    assert expenditure(read.verify()) == official
    assert read.journal.path.read_bytes() == journal
    spans = project(read)
    assert {"invoke_workflow", "invoke_agent", "generate_content", "execute_tool"} <= {
        str(s.fields.get("gen_ai.operation.name")) for s in spans}
    models = [s for s in spans if s.fields.get("gen_ai.operation.name") == "generate_content"]
    assert len(models) == 1
    assert models[0].fields["gen_ai.usage.input_tokens"] == 1
    assert models[0].fields["gen_ai.response.model"] == "counter-refiner/1"
    assert "strive.observed.model.evidence" in models[0].fields
    assert models[0].fields["strive.request.label"] == "sent to the model"
    assert all(s.fields["strive.semconv.version"] == "1.41.0" for s in spans)
    metrics = project_metrics(read)
    scope = mapping(sequence(mapping(sequence(metrics["resourceMetrics"])[0])["scopeMetrics"])[0])
    assert {mapping(m)["name"] for m in sequence(scope["metrics"])} == {
        "gen_ai.client.operation.duration", "gen_ai.client.token.usage"}


@pytest.mark.parametrize("profile,key", [(TelemetryProfile.LANGFUSE, "langfuse.observation.type"),
    (TelemetryProfile.LANGSMITH, "langsmith.span.kind"), (TelemetryProfile.PHOENIX, "openinference.span.kind")])
def test_profile_switch_requires_no_policy_change(tmp_path: Path, profile: TelemetryProfile, key: str) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None)
    read = reader(root, "run-1")
    journal = read.journal.path.read_bytes()
    exporter = MemoryExporter()
    Projector(read, tmp_path / "cursor", exporter, profile=profile).flush()
    assert all(key in {mapping(a)["key"] for a in sequence(span["attributes"])} for span in exporter.spans.values())
    assert read.journal.path.read_bytes() == journal


def test_execution_does_not_import_projection_or_reporting() -> None:
    root = Path(__file__).resolve().parents[2] / "src/strive/vnext"
    for directory in ("runtime", "policy", "benchmarks", "verify", "store", "harness"):
        for path in (root / directory).glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom):
                    assert not any(part in (node.module or "").split(".") for part in ("telemetry", "report", "study", "cli"))


@pytest.mark.parametrize("development", [None, "https://shared.invalid/v1/traces"])
def test_audit_http_alias_cannot_share_development_endpoint(development: str | None) -> None:
    from strive.vnext.errors import VerificationError
    exporter = HTTPExporter("https://shared.invalid/v1/traces", development_endpoint=development)
    with pytest.raises(VerificationError, match="distinct"):
        exporter.export("audit:reference", {})
