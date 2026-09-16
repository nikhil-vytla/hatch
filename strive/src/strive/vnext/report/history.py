"""Coverage, costs and provenance; annotations never become measurements."""
from decimal import Decimal

from ..benchmarks.bridge import OperationRequest
from ..codec import decode
from ..contracts.annotations import Annotation
from ..contracts.commands import StepOutput, Suspend
from ..contracts.lifecycle import EffectState
from ..contracts.primitives import ArtifactRef, Resource
from ..contracts.records import EffectObservationSettlement, Measurement, OutcomeStatus, ProducerKind, UsageKind
from ..runtime.broker import EffectRequest
from ..store import RunReader
from ..verify import VerifiedState
from ..cli.data import json_bytes, mapping, plain, read_json, sequence
from ..cli.resolve import load_manifest
from .access import authorize
from .model import observed_model
from .snapshot import snapshot


def expenditure(state: VerifiedState) -> dict[str, object]:
    measured = {q.resource.value: q.quantity for q in state.measured}
    held = {q.resource.value: q.quantity for q in state.obligations}
    unknown = [{"effect": e.authorization.effect_id, "outcome": e.outcome,
                "obligation": plain(e.obligations)} for e in state.effects
               if e.obligations and e.state not in {EffectState.AUTHORIZED_RESERVED, EffectState.ACCEPTED}]
    return {"source": "verified journal fold", "settled_usage": measured,
            "calculated_nanodollars": measured.get(Resource.USD_NANODOLLARS.value, 0),
            "reserved": held, "unknown": unknown,
            "note": "Calculated monetary usage is part of settled usage, not an additional charge; fixture rates are zero."}


def suspension_reason(read: RunReader, state: VerifiedState) -> str | None:
    for record in reversed(state.records):
        payload = record.payload
        if not isinstance(payload, Annotation):
            continue
        if payload.namespace == "workflow.failure" and record.envelope.producer_identity.kind is ProducerKind.OPERATOR:
            return str(read_json(payload.payload).get("reason"))
        if payload.namespace == "runtime.step_output" and record.envelope.producer_identity.kind is ProducerKind.SUPERVISOR:
            data = read_json(payload.payload)
            ref = data.get("reference")
            if isinstance(ref, str):
                output = decode(read.objects.read(ArtifactRef(ref)))
                if isinstance(output, StepOutput) and isinstance(output.command, Suspend):
                    return output.command.reason
    return "unresolved effect or accounting overrun" if state.dispatch_stopped else None


def history(read: RunReader) -> dict[str, object]:
    authorize(read)
    captured = snapshot(read)
    read = captured
    state = read.verify()
    assert state.binding is not None
    manifest = load_manifest(read.objects, state.binding.resolved_manifest)
    config = manifest.configuration
    tasks = sequence(read_json(read.objects.read(config.workload.task_stream))["tasks"])
    planned = len(tasks)
    admitted: set[str] = set()
    failed_operations: set[str] = set()
    for effect in state.effects:
        if effect.authorization.operation.startswith("benchmark."):
            request = EffectRequest.read(read.objects.read(effect.authorization.exact_request_reference))
            operation = OperationRequest.read(read.objects.read(request.arguments))
            admitted.add(operation.episode)
            if effect.outcome is OutcomeStatus.FAILED:
                failed_operations.add(operation.episode)
    rows: list[dict[str, object]] = []
    claims: list[dict[str, object]] = []
    judges: list[dict[str, object]] = []
    usage: dict[tuple[str, str], int] = {}
    cumulative = Decimal(0)
    by_task: dict[str, list[Decimal]] = {}
    completed: set[str] = set()
    excluded: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for record in state.records:
        payload, event = record.payload, record.envelope.record_id
        if isinstance(payload, EffectObservationSettlement):
            for item in payload.usage:
                if item.kind is UsageKind.MEASURED and item.quantity is not None:
                    usage[(payload.effect_id, item.quantity.resource.value)] = item.quantity.quantity
        if isinstance(payload, Measurement):
            # replay authenticates producer and scorer; never parse candidate
            # JSON as a measurement, even when its keys imitate these columns.
            assert record.envelope.producer_identity.kind is ProducerKind.TRUSTED_SCORER
            identity = (str(payload.episode_identity), payload.metric_identity.digest)
            if identity in seen:
                continue
            seen.add(identity)
            if payload.episode_identity is not None:
                completed.add(payload.episode_identity)
            cumulative += payload.metric_value
            for task in payload.completed_coverage:
                by_task.setdefault(task, []).append(payload.metric_value)
            excluded.update(e.subject for e in payload.exclusions)
            cost = sum(q for (_, resource), q in usage.items() if resource == Resource.USD_NANODOLLARS.value)
            rows.append({"episode": payload.episode_identity, "value": str(payload.metric_value),
                "metric": payload.metric_identity.digest, "cumulative_successes": str(cumulative),
                "workload_progress": len(completed), "cumulative_nanodollars": cost,
                "cumulative_model_calls": sum(q for (_, resource), q in usage.items() if resource == Resource.MODEL_CALLS.value),
                "event": event, "evidence": plain((*payload.supporting_receipt_references, *payload.supporting_state_references)),
                "scorer": payload.scorer_version.digest, "revision": plain(payload.revision_references)})
        elif isinstance(payload, Annotation):
            diagnostic: dict[str, object] = {"event": event, "namespace": payload.namespace, "producer": record.envelope.producer_identity.kind.value,
                    "payload": payload.payload.decode("utf-8", errors="backslashreplace"), "official": False}
            if payload.namespace.startswith("judge."):
                judges.append(diagnostic)
            elif record.envelope.producer_identity.kind is ProducerKind.CANDIDATE:
                claims.append(diagnostic)
    failed = len(failed_operations - completed)
    unresolved = max(0, planned - len(completed) - failed - len(excluded))
    comparisons = {t: v for t, v in by_task.items() if len(v) > 1}
    corpus = sequence(read_json(read.objects.read(config.workload.dev_corpus))["tasks"])
    retention = {"corpus": config.workload.dev_corpus.digest, "planned_tasks": len(corpus),
        "observed_repeated_tasks": len(comparisons),
        "retained_successes": sum(v[0] == 1 and v[-1] == 1 for v in comparisons.values()),
        "regressions": sum(v[-1] < v[0] for v in comparisons.values()),
        "unmeasured_tasks": [t for t in corpus if t not in comparisons],
        "evidence": [row["event"] for row in rows],
        "method": "first versus last observed development trajectory exposure; no unexecuted corpus evaluation is inferred"}
    reason = suspension_reason(read, state)
    status = "indeterminate" if state.execution_status.value == "continue" and reason else state.execution_status.value
    return {"run": read.authority.run_id, "head": plain(state.head), "status": status,
        "inspection": captured.inspection,
        "execution_status": state.execution_status.value,
        "active_revision": state.active_revision, "current_work": "finished" if status == "finished" else state.pending_command_id or (
            state.effects[-1].authorization.operation if state.effects else "prepared"),
        "suspension_reason": reason,
        "labels": {"execution_integrity_measurement_provenance": {
            "enforced": [2, 3, 4, 5], "deferred": [1], "producer": "trusted_scorer",
            "scope": "fixture runtime; native OS jail remains unqualified"},
            "feedback_exposure": {"contract": config.feedback.contract.value, "lineage": read.authority.scope.lineage_id,
                "audit_release": config.feedback.audit_release},
            "comparison_strength": "single trajectory; no controlled improvement estimate"},
        "coverage": {"planned": planned, "admitted": len(admitted), "completed": len(completed), "failed": failed,
                     "task_failures": sum(Decimal(str(r["value"])) == 0 for r in rows),
                     "excluded": len(excluded), "unresolved": unresolved},
        "performance": {"cumulative_successes": str(cumulative), "fulfilment_denominator": planned,
            "observed_fulfilment": str(cumulative / planned) if planned else None,
            "unobserved_outcomes": max(0, planned - len(completed)),
            "outcome_bounds": [str(cumulative), str(cumulative + max(0, planned - len(completed)))],
            "uncertainty": {"unit": "independent trajectory", "n": 1, "interval": None,
                            "reason": "one trajectory; missing outcomes remain explicit"}},
        "retention": retention, "expenditure": expenditure(state), "official_measurements": rows,
        "candidate_claims": claims, "judge_assessments": judges}


def invocation_inputs(read: RunReader, invocation: str | None = None) -> list[dict[str, object]]:
    authorize(read)
    read = snapshot(read)
    result: list[dict[str, object]] = []
    for effect in read.verify().effects:
        auth = effect.authorization
        if auth.operation != "model.generate" or invocation is not None and invocation not in {effect.invocation_id, auth.effect_id}:
            continue
        ref = auth.actual_provider_request_reference
        if ref is None:
            continue  # Prepared-but-unforwarded requests were not sent.
        raw = read.objects.read(ref)
        components = []
        for component in auth.input_references:
            data = read.objects.read(component)
            offset = raw.find(data)
            components.append({"reference": component.digest, "content": plain(data),
                               "byte_range": [offset, offset + len(data)] if offset >= 0 else None})
        observed, evidence, response = observed_model(read, effect)
        result.append({"label": "sent to the model", "invocation": effect.invocation_id, "effect": auth.effect_id,
            "request_reference": ref.digest, "exact_request": raw.decode(), "supplied_components": components,
            "observed_model": plain(observed), "identity_evidence": plain(evidence), "provider_response": plain(response),
            "note": "Supplied inputs do not establish causal influence; provider-side transformations may be unobservable."})
    return result


def unavailable(run: str, planned: int, reason: str) -> dict[str, object]:
    """An allocated execution remains in the denominator without invented data."""
    return {"run": run, "head": None, "status": "indeterminate", "active_revision": None,
        "current_work": "unavailable history", "suspension_reason": reason,
        "labels": {"execution_integrity_measurement_provenance": "unverifiable",
                   "feedback_exposure": "unknown", "comparison_strength": "descriptive incomplete allocation"},
        "coverage": {"planned": planned, "admitted": 0, "completed": 0, "failed": 0, "excluded": 0,
                     "unresolved": planned, "admission_unknown": True},
        "performance": {"cumulative_successes": "0", "observed_fulfilment": None,
                        "fulfilment_denominator": planned, "outcome_bounds": ["0", str(planned)],
                        "uncertainty": {"interval": None, "reason": "no verifiable outcomes"}},
        "retention": {"status": "unresolved"},
        "expenditure": {"source": "history unavailable", "settled_usage": {}, "calculated_nanodollars": None,
                        "reserved": {}, "unknown": [{"run": run, "reason": reason}]},
        "official_measurements": [], "candidate_claims": [], "judge_assessments": []}


def total_expenditure(reports: list[dict[str, object]]) -> dict[str, object]:
    settled: dict[str, int] = {}
    reserved: dict[str, int] = {}
    unknown: list[dict[str, object]] = []
    seen: set[str] = set()
    for report in reports:
        run_id = str(report["run"])
        if run_id in seen:
            continue
        seen.add(run_id)
        costs = mapping(report["expenditure"])
        for name, target in (("settled_usage", settled), ("reserved", reserved)):
            for resource, quantity in mapping(costs[name]).items():
                if type(quantity) is not int:
                    raise ValueError("nonintegral journal resource total")
                target[resource] = target.get(resource, 0) + quantity
        if costs["unknown"]:
            unknown.append({"run": run_id, "obligations": costs["unknown"]})
    return {"source": "sum of independent verified journal folds, deduplicated by execution identity",
        "runs": len(seen), "settled_usage": settled, "reserved": reserved, "unknown": unknown,
        "calculated_nanodollars": settled.get(Resource.USD_NANODOLLARS.value, 0),
        "inherited_preparation_nanodollars": 0}
