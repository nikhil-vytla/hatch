"""The two guarantee-2 halves exercise actual producer and lineage boundaries."""
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from strive.vnext.cli.data import json_bytes, mapping, read_json, sequence
from strive.vnext.cli.runner import reader, resume, run_directory
from strive.vnext.codec import encode
from strive.vnext.contracts.primitives import ArtifactRef, ScopedArtifact
from strive.vnext.contracts.records import ContinuationCommit
from strive.vnext.store import ArtifactStore
from strive.vnext.errors import VerificationError
from strive.vnext.study.audit import execute_audit, freeze, release
from strive.vnext.study.experiment import allocate, experiment
from strive.vnext.telemetry.projector import MemoryExporter, Projector

from .benchmark_acceptance import BenchmarkRuntimeDriver
from .test_acceptance_contracts import RuntimeEvidence
from .test_benchmarks import test_forged_facts_guarantee_2
from .workflow_fixtures import campaign


def noninterference(root: Path) -> None:
    from strive.vnext.runtime import supervisor
    from strive.vnext.policy import refiner
    views: list[bytes] = []
    audit_scores: list[list[str]] = []
    # Runtime durations are a permitted input, fixed for the counterfactual pair.
    # Deno's real enforcement clock is untouched. The provider completion bytes
    # are deterministic and equal in both executions.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(supervisor, "time", SimpleNamespace(monotonic=lambda: 0.0))
        patch.setattr(refiner, "time", SimpleNamespace(monotonic=lambda: 0.0))
        for variant, target in enumerate((7, 8)):
            case = root / str(variant)
            path = campaign(case / "inputs", target=target)
            state_root = case / "state"
            experiment(state_root, path, audit=False)
            directory, allocation = allocate(state_root, path)
            frozen = freeze(state_root, directory, allocation)
            before = {str(p.relative_to(state_root / "runs")): p.read_bytes()
                      for p in (state_root / "runs").rglob("*") if p.is_file()}
            with pytest.raises(VerificationError, match="frozen"):
                resume(state_root, "reference-adapting-0")
            execute_audit(state_root, directory, allocation)
            boundary = state_root / "audit/reference"
            # Protected channels vary in every audit-owned service namespace.
            for name in ("traces", "memories", "prompts", "scores", "dashboards", "stop-signals", "budget", "messages", "retrieval", "cache", "conversation"):
                (boundary / name).write_bytes(f"protected-{variant}-{name}".encode())
            release(state_root, directory)
            after = {str(p.relative_to(state_root / "runs")): p.read_bytes()
                     for p in (state_root / "runs").rglob("*") if p.is_file()}
            assert after == before, "audit wrote back into the adaptive lineage"
            read = reader(state_root, "reference-adapting-0")
            state = read.verify()
            requests = tuple(read.objects.read(e.authorization.exact_request_reference) for e in state.effects)
            model_requests = tuple(read.objects.read(e.authorization.actual_provider_request_reference)
                                   for e in state.effects if e.authorization.actual_provider_request_reference)
            commands = tuple(read.objects.read(r.payload.pending_command_reference) for r in state.records
                             if isinstance(r.payload, ContinuationCommit) and r.payload.pending_command_reference is not None)
            # The complete adaptive record is equal, including state, budget,
            # visible evidence, commands and model responses, not just a score.
            views.append(encode((requests, model_requests, commands, state.private_state,
                state.active_bundle, state.environment, state.measured, tuple(r.payload for r in state.records))))
            audit_read = reader(boundary, "reference-adapting-0-audit")
            audit_scores.append([str(m.metric_value) for m in audit_read.verify().measurements])
            assert audit_read.authority.scope != read.authority.scope
            protected = ArtifactStore(run_directory(boundary, "reference-adapting-0-audit") / "artifacts").objects.publish(
                f"private audit-only observation {variant}".encode())
            with pytest.raises(VerificationError, match="missing"):
                read.objects.read(protected)
            with pytest.raises(VerificationError, match="audit telemetry"):
                Projector(audit_read, boundary / "cursor", MemoryExporter())
            result = Projector(audit_read, boundary / "cursor", MemoryExporter(), destination="audit:reference",
                               audit_release=boundary / "RELEASED").flush()
            assert result["backlog"] == 0
            assert read_json((directory / "freeze.json").read_bytes()) == frozen
    assert audit_scores == [["1", "1"], ["0", "0"]]
    assert views[0] == views[1], "protected inputs changed adaptive requests, commands or visible state"


class WorkflowRuntimeDriver(BenchmarkRuntimeDriver):
    def exercise(self, scenario: str) -> RuntimeEvidence:
        if scenario != "forge_success_and_vary_protected_evidence_with_fixed_permitted_inputs":
            return super().exercise(scenario)
        test_forged_facts_guarantee_2(self.root / "forged")
        noninterference(self.root / "protected")
        return replace(self.evidence(), forged_measurement_rejected=True,
                       protected_input_variation_changed_adaptive_requests=False)
