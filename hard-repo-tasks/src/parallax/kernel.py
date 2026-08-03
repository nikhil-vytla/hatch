from __future__ import annotations

import hashlib
import inspect
import json
import os
import shutil
import tempfile
import tomllib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeAlias

from parallax.evolving_intent import (
    CheckpointPlan,
    EvolvingIntent,
    IntentPlan,
    PlanArm,
    ProposalBundle,
    StaticPlan,
    SynthesisPlan,
    compile_plans,
    replay_plan,
)
from parallax.grading import GradeOutcome
from parallax.gsm8k import Gsm8k, SourceTask, parse_final_answer
from parallax.ids import canonical_bytes, digest_value, task_id_for

_ARTIFACT_FORMAT = "parallax.family.v1"
_LOCK_FORMAT = "parallax.family-lock.v1"
_ADMISSION_POLICY = "gsm8k-family-admission.v1"


class AdmissionError(ValueError):
    pass


@dataclass(frozen=True)
class RenderedTask:
    source: SourceTask
    proposal: ProposalBundle
    plan: SynthesisPlan

    def __post_init__(self) -> None:
        if not isinstance(self.plan, CheckpointPlan):
            replay_plan(self.source, self.plan)

    @property
    def arm_name(self) -> str:
        return str(self.plan.arm)

    @property
    def public_digest(self) -> str:
        return digest_value(self.public_payload())

    @property
    def sealed_digest(self) -> str:
        return digest_value(self.sealed_payload())

    @property
    def task_id(self) -> str:
        return task_id_for(self.public_digest, self.sealed_digest)

    def public_payload(self) -> dict[str, Any]:
        if isinstance(self.plan, CheckpointPlan):
            raise NotImplementedError("CheckpointPlan rendering is not implemented")
        return {
            "arm": self.arm_name,
            "budget": {
                "max_turns": self.plan.budget.max_turns,
                "output_tokens_per_turn": self.plan.budget.output_tokens_per_turn,
            },
            "format": _ARTIFACT_FORMAT,
            "opening_turn": self.plan.turns[0],
            "source": self.source.safe_metadata(),
            "source_digest": self.source.source_digest,
            "verifier_digest": self.source.verifier_digest,
        }

    def sealed_payload(self) -> dict[str, Any]:
        if isinstance(self.plan, CheckpointPlan):
            raise NotImplementedError("CheckpointPlan rendering is not implemented")
        return {
            "answer_authority": self.source.answer_authority,
            "evaluator": self.source.evaluator,
            "plan": _plan_payload(self.plan),
            "proposal": self.proposal.sealed_payload(),
            "scheduled_turns": self.plan.turns[1:],
        }


@dataclass(frozen=True)
class AdmissionCheck:
    name: str
    passed: bool
    evidence: str


@dataclass(frozen=True)
class AdmissionCertificate:
    family_id: str
    policy_revision: str
    checks: tuple[AdmissionCheck, ...]

    @property
    def admitted(self) -> bool:
        return all(check.passed for check in self.checks)


@dataclass(frozen=True)
class Family:
    family_id: str
    source_digest: str
    verifier_digest: str
    proposal_digest: str
    arms: tuple[RenderedTask, ...]
    certificate: AdmissionCertificate

    def __post_init__(self) -> None:
        if (
            self.certificate.family_id != self.family_id
            or self.certificate.policy_revision != _ADMISSION_POLICY
            or not self.certificate.admitted
        ):
            raise AdmissionError("family requires its passing atomic admission certificate")

    def arm(self, name: str) -> RenderedTask:
        try:
            return next(arm for arm in self.arms if arm.arm_name == name)
        except StopIteration as error:
            raise KeyError(f"unknown family arm: {name}") from error


@dataclass(frozen=True)
class ConversationRun:
    task: RenderedTask
    kind: str = "conversation"


@dataclass(frozen=True)
class WorkspaceEpisode:
    task: RenderedTask
    kind: str = "workspace"


@dataclass(frozen=True)
class CheckpointSequence:
    task: RenderedTask
    kind: str = "checkpoint"


RuntimeSpec: TypeAlias = ConversationRun | WorkspaceEpisode | CheckpointSequence


@dataclass(frozen=True)
class ConversationMessage:
    role: str
    content: str


@dataclass(frozen=True)
class Verdict:
    task_id: str
    outcome: GradeOutcome
    reward: float
    response: str
    parsed_answer: str | None
    turns_completed: int


ModelCallback: TypeAlias = Callable[[tuple[ConversationMessage, ...]], str | Awaitable[str]]


def build(*, source: SourceTask, strategy: EvolvingIntent) -> Family:
    plans = compile_plans(source, strategy)
    arms = tuple(RenderedTask(source, strategy.proposal, plan) for plan in plans)
    family_id = digest_value(
        {
            "admission_policy": _ADMISSION_POLICY,
            "arm_task_ids": [arm.task_id for arm in arms],
            "proposal_digest": strategy.proposal.digest,
            "source_digest": source.source_digest,
            "verifier_digest": source.verifier_digest,
        }
    )
    checks = _admission_checks(family_id, arms)
    certificate = AdmissionCertificate(family_id, _ADMISSION_POLICY, checks)
    if not certificate.admitted:
        failures = "; ".join(
            f"{check.name}: {check.evidence}" for check in checks if not check.passed
        )
        raise AdmissionError(f"family admission failed: {failures}")
    return Family(
        family_id=family_id,
        source_digest=source.source_digest,
        verifier_digest=source.verifier_digest,
        proposal_digest=strategy.proposal.digest,
        arms=arms,
        certificate=certificate,
    )


async def run(
    target: RenderedTask | RuntimeSpec,
    *,
    agent: ModelCallback,
) -> Verdict:
    runtime: RuntimeSpec = ConversationRun(target) if isinstance(target, RenderedTask) else target
    if not isinstance(runtime, ConversationRun):
        raise NotImplementedError(f"{runtime.kind} execution is not implemented")
    task = runtime.task
    if isinstance(task.plan, CheckpointPlan):
        raise NotImplementedError("CheckpointPlan execution is not implemented")
    transcript: list[ConversationMessage] = []
    final_response = ""
    for turn in replay_plan(task.source, task.plan):
        transcript.append(ConversationMessage("user", turn))
        result = agent(tuple(transcript))
        final_response = await result if inspect.isawaitable(result) else result
        if not isinstance(final_response, str):
            raise TypeError("conversation model callback must return a string")
        transcript.append(ConversationMessage("assistant", final_response))
    parsed = parse_final_answer(final_response)
    if parsed is None:
        outcome = GradeOutcome.INVALID_SUBMISSION
        reward = 0.0
    else:
        outcome = GradeOutcome.SCORED
        reward = float(task.source.score(final_response))
    return Verdict(
        task_id=task.task_id,
        outcome=outcome,
        reward=reward,
        response=final_response,
        parsed_answer=parsed,
        turns_completed=len(task.plan.turns),
    )


def build_experiment(
    *,
    store: Path,
    experiment: Path | None = None,
    locked: Path | None = None,
) -> Family:
    if (experiment is None) == (locked is None):
        raise ValueError("provide exactly one of experiment or locked lock file")
    if locked is not None:
        lock = _load_json_object(locked)
        if lock.get("format") != _LOCK_FORMAT:
            raise ValueError("unsupported family lock format")
        source_path = _locked_reference(locked, lock, "source")
        proposal_path = _locked_reference(locked, lock, "proposal")
        build_config = lock.get("build")
        if not isinstance(build_config, dict):
            raise ValueError("family lock build section must be an object")
        family = _build_from_references(source_path, proposal_path, build_config)
        expected_family_id = lock.get("family_id")
        if family.family_id != expected_family_id:
            raise AdmissionError("locked rebuild changed family identity")
        files = _artifact_files(family)
        if _file_digests(files) != lock.get("artifacts"):
            raise AdmissionError("locked rebuild changed artifact bytes")
        _publish_artifacts(store, family.family_id, files)
        return family

    assert experiment is not None
    config = _load_experiment(experiment)
    source_path = _config_reference(experiment, config, "source")
    proposal_path = _config_reference(experiment, config, "proposal")
    build_config = config["build"]
    family = _build_from_references(source_path, proposal_path, build_config)
    files = _artifact_files(family)
    _publish_artifacts(store, family.family_id, files)
    lock_path = experiment.with_name("family.lock")
    lock_payload = {
        "artifacts": _file_digests(files),
        "build": build_config,
        "family_id": family.family_id,
        "format": _LOCK_FORMAT,
        "proposal": _reference_payload(lock_path, proposal_path),
        "source": _reference_payload(lock_path, source_path),
    }
    _atomic_write(lock_path, canonical_bytes(lock_payload) + b"\n")
    return family


def runtime_for(task: RenderedTask) -> RuntimeSpec:
    if isinstance(task.plan, CheckpointPlan):
        return CheckpointSequence(task)
    return ConversationRun(task)


def _admission_checks(
    family_id: str,
    arms: tuple[RenderedTask, ...],
) -> tuple[AdmissionCheck, ...]:
    checks: list[AdmissionCheck] = []

    source_digests = {arm.source.source_digest for arm in arms}
    verifier_digests = {arm.source.verifier_digest for arm in arms}
    checks.append(
        AdmissionCheck(
            "source_verifier_parity",
            len(source_digests) == len(verifier_digests) == 1,
            "all arms share one source and verifier digest",
        )
    )

    try:
        for arm in arms:
            replay_plan(arm.source, arm.plan)
    except (ValueError, NotImplementedError) as error:
        checks.append(AdmissionCheck("terminal_anchor_replay", False, str(error)))
    else:
        checks.append(
            AdmissionCheck(
                "terminal_anchor_replay",
                True,
                "every plan replays to its source-copied terminal anchor",
            )
        )

    by_name = {arm.arm_name: arm for arm in arms}
    matched = by_name.get(PlanArm.MATCHED)
    evolved = by_name.get(PlanArm.EVOLVED)
    equal_budget = (
        matched is not None
        and evolved is not None
        and isinstance(matched.plan, IntentPlan)
        and isinstance(evolved.plan, IntentPlan)
        and matched.plan.budget == evolved.plan.budget
        and len(matched.plan.turns) == len(evolved.plan.turns)
    )
    checks.append(
        AdmissionCheck(
            "matched_evolved_budget",
            equal_budget,
            "matched and evolved use the same turn and output-token budget",
        )
    )

    leakage = tuple(_public_leakage(arm) for arm in arms)
    checks.append(
        AdmissionCheck(
            "public_leakage",
            not any(leakage),
            next(
                (item for item in leakage if item),
                "public payloads contain opening turns and safe metadata",
            ),
        )
    )

    source = arms[0].source
    oracle_passed = source.score(f"#### {source.answer_authority}")
    checks.append(
        AdmissionCheck(
            "oracle_success",
            oracle_passed,
            "sealed answer authority passes the native evaluator",
        )
    )
    wrong_failed = not source.score(_known_wrong_answer(source))
    checks.append(
        AdmissionCheck(
            "wrong_answer_failure",
            wrong_failed,
            "a known wrong final answer receives zero",
        )
    )

    rebuilt = _rebuild_arms(arms)
    deterministic = _rendered_bytes(arms) == _rendered_bytes(rebuilt)
    checks.append(
        AdmissionCheck(
            "deterministic_locked_rebuild",
            deterministic,
            "an independent compile from the same frozen inputs renders identical bytes",
        )
    )
    return tuple(checks)


def _public_leakage(task: RenderedTask) -> str:
    payload = task.public_payload()
    expected_keys = {
        "arm",
        "budget",
        "format",
        "opening_turn",
        "source",
        "source_digest",
        "verifier_digest",
    }
    if set(payload) != expected_keys:
        return "public payload has fields outside the safe schema"
    if payload["opening_turn"] != task.plan.turns[0]:
        return "public opening turn differs from the rendered plan"
    serialized = canonical_bytes(payload).decode()
    forbidden_names = ("answer_authority", "scheduled_turns", "proposal", "events")
    if any(name in serialized for name in forbidden_names):
        return "public payload names sealed fields"
    for turn in task.plan.turns[1:]:
        if turn != task.plan.turns[0] and turn in serialized:
            return "public payload contains a future turn"
    return ""


def _known_wrong_answer(source: SourceTask) -> str:
    for candidate in ("0", "1", "-1", "999999999"):
        response = f"#### {candidate}"
        if not source.score(response):
            return response
    raise AssertionError("could not construct a known wrong GSM8K answer")


def _plan_payload(plan: StaticPlan | IntentPlan) -> dict[str, Any]:
    base: dict[str, Any] = {
        "anchor_digest": plan.anchor_digest,
        "arm": str(plan.arm),
        "budget": {
            "max_turns": plan.budget.max_turns,
            "output_tokens_per_turn": plan.budget.output_tokens_per_turn,
        },
        "turns": plan.turns,
    }
    if isinstance(plan, IntentPlan):
        base.update(
            {
                "events": [_intent_event_payload(event) for event in plan.events],
                "initial_goal": plan.initial_goal,
                "initial_values": dict(plan.initial_values),
            }
        )
    return base


def _intent_event_payload(event: object) -> dict[str, str]:
    value = vars(event)
    return {key: item for key, item in sorted(value.items()) if isinstance(item, str)}


def _logical_artifact_payload(
    family_id: str,
    arms: tuple[RenderedTask, ...],
    checks: tuple[AdmissionCheck, ...],
) -> dict[str, Any]:
    return {
        "arms": [
            {
                "arm": arm.arm_name,
                "public_digest": arm.public_digest,
                "sealed_digest": arm.sealed_digest,
                "task_id": arm.task_id,
            }
            for arm in arms
        ],
        "certificate": [
            {"evidence": check.evidence, "name": check.name, "passed": check.passed}
            for check in checks
        ],
        "admission_policy": _ADMISSION_POLICY,
        "family_id": family_id,
        "format": _ARTIFACT_FORMAT,
        "proposal_digest": arms[0].proposal.digest,
        "source_digest": arms[0].source.source_digest,
        "verifier_digest": arms[0].source.verifier_digest,
    }


def _rebuild_arms(arms: tuple[RenderedTask, ...]) -> tuple[RenderedTask, ...]:
    evolved = next(arm for arm in arms if arm.arm_name == PlanArm.EVOLVED)
    if not isinstance(evolved.plan, IntentPlan):
        raise AdmissionError("family requires an evolved intent plan")
    strategy = EvolvingIntent(
        proposal=evolved.proposal,
        max_turns=evolved.plan.budget.max_turns,
        output_tokens_per_turn=evolved.plan.budget.output_tokens_per_turn,
    )
    return tuple(
        RenderedTask(evolved.source, evolved.proposal, plan)
        for plan in compile_plans(evolved.source, strategy)
    )


def _rendered_bytes(arms: tuple[RenderedTask, ...]) -> tuple[tuple[bytes, bytes], ...]:
    return tuple(
        (canonical_bytes(arm.public_payload()), canonical_bytes(arm.sealed_payload()))
        for arm in arms
    )


def _artifact_files(family: Family) -> dict[str, bytes]:
    files = {
        "family.json": canonical_bytes(
            _logical_artifact_payload(
                family.family_id,
                family.arms,
                family.certificate.checks,
            )
        )
        + b"\n"
    }
    for arm in family.arms:
        files[f"arms/{arm.arm_name}/public.json"] = canonical_bytes(arm.public_payload()) + b"\n"
        files[f"arms/{arm.arm_name}/sealed.json"] = canonical_bytes(arm.sealed_payload()) + b"\n"
    return files


def _publish_artifacts(store: Path, family_id: str, files: Mapping[str, bytes]) -> None:
    store.mkdir(parents=True, exist_ok=True)
    target = store / family_id
    temp: Path | None = Path(tempfile.mkdtemp(prefix=".parallax-", dir=store))
    try:
        for relative, content in files.items():
            assert temp is not None
            path = temp / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        if target.exists():
            if _read_directory(target) != dict(files):
                raise AdmissionError("content-addressed family directory has different bytes")
            return
        assert temp is not None
        os.replace(temp, target)
        temp = None
    finally:
        if temp is not None and temp.exists():
            shutil.rmtree(temp)


def _read_directory(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(item for item in root.rglob("*") if item.is_file())
    }


def _file_digests(files: Mapping[str, bytes]) -> dict[str, str]:
    return {path: hashlib.sha256(content).hexdigest() for path, content in sorted(files.items())}


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(raw_temp)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def _load_experiment(path: Path) -> dict[str, Any]:
    with path.open("rb") as stream:
        value = tomllib.load(stream)
    if set(value) != {"build", "proposal", "source"}:
        raise ValueError("experiment must contain only build, proposal, and source tables")
    source = value["source"]
    proposal = value["proposal"]
    build_config = value["build"]
    if (
        not isinstance(source, dict)
        or set(source) != {"kind", "path"}
        or source.get("kind") != "gsm8k"
    ):
        raise ValueError("experiment source must be a GSM8K path reference")
    if not isinstance(proposal, dict) or set(proposal) != {"path"}:
        raise ValueError("experiment proposal must contain one path reference")
    if (
        not isinstance(build_config, dict)
        or set(build_config) != {"output_tokens_per_turn"}
        or isinstance(build_config.get("output_tokens_per_turn"), bool)
        or not isinstance(build_config.get("output_tokens_per_turn"), int)
    ):
        raise ValueError("experiment build must set integer output_tokens_per_turn")
    return value


def _config_reference(experiment: Path, config: dict[str, Any], section: str) -> Path:
    value = config[section].get("path")
    if not isinstance(value, str) or not value:
        raise ValueError(f"experiment {section} path must be a string")
    return (experiment.parent / value).resolve()


def _build_from_references(
    source_path: Path,
    proposal_path: Path,
    build_config: Mapping[str, Any],
) -> Family:
    output_tokens = build_config.get("output_tokens_per_turn")
    if isinstance(output_tokens, bool) or not isinstance(output_tokens, int):
        raise ValueError("output_tokens_per_turn must be an integer")
    source = Gsm8k.load(source_path)
    strategy = EvolvingIntent.frozen(
        proposal_path,
        output_tokens_per_turn=output_tokens,
    )
    return build(source=source, strategy=strategy)


def _reference_payload(lock_path: Path, target: Path) -> dict[str, str]:
    return {
        "path": os.path.relpath(target.resolve(), lock_path.parent.resolve()),
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    }


def _locked_reference(
    lock_path: Path,
    lock: dict[str, Any],
    name: str,
) -> Path:
    reference = lock.get(name)
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256"}:
        raise ValueError(f"family lock {name} reference is invalid")
    relative = reference["path"]
    expected = reference["sha256"]
    if not isinstance(relative, str) or not isinstance(expected, str):
        raise ValueError(f"family lock {name} reference values must be strings")
    target = (lock_path.parent.resolve() / relative).resolve()
    if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        raise AdmissionError(f"locked {name} reference digest changed")
    return target


def _load_json_object(path: Path) -> dict[str, Any]:
    value: Any = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value
