import ast
from pathlib import Path

import pytest

from strive.vnext.cli.data import mapping, read_json, sequence
from strive.vnext.cli.fixture import example
from strive.vnext.cli.runner import reader, resume, run, run_directory
from strive.vnext.contracts.manifest import ManifestError, TelemetryProfile, load_authored_manifest, load_resolved_configuration
from strive.vnext.report.history import expenditure
from strive.vnext.telemetry.projector import HTTPExporter, MemoryExporter, Projector, cursor_status, project, project_metrics

from .fixtures import AUTHORED_TOML, RESOLVED_TOML


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


def test_langfuse_profile_preserves_otlp_and_journal(tmp_path: Path) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "run-1", display=lambda _: None)
    read = reader(root, "run-1")
    journal = read.journal.path.read_bytes()
    exporter = MemoryExporter()
    Projector(read, tmp_path / "cursor", exporter, profile=TelemetryProfile.LANGFUSE).flush()
    assert exporter.spans
    exported = {str(span["spanId"]): span for span in exporter.spans.values()}
    for span in project(read):
        attributes = {str(mapping(a)["key"]): mapping(a)["value"]
                      for a in sequence(exported[span.identity]["attributes"])}
        assert "langfuse.observation.type" in attributes
        for key, value in span.fields.items():
            if value is not None:
                assert key in attributes
        assert attributes["strive.run.id"] == {"stringValue": "run-1"}
    assert read.journal.path.read_bytes() == journal


@pytest.mark.parametrize("profile", ["langsmith", "phoenix"])
def test_manifest_rejects_deferred_telemetry_profiles(profile: str) -> None:
    message = rf"telemetry\.profile: unsupported profile '{profile}'; .*only 'langfuse'; .*deferred"
    with pytest.raises(ManifestError, match=message):
        load_authored_manifest(AUTHORED_TOML.replace('profile = "langfuse"', f'profile = "{profile}"'))
    with pytest.raises(ManifestError, match=message):
        load_resolved_configuration(RESOLVED_TOML.replace('profile = "langfuse"', f'profile = "{profile}"'))


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
