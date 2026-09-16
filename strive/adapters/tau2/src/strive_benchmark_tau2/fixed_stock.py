"""Initial, non-adapting tau2 LLM actor on stock test, reported separately.

The initial actor is an explicit model/options artifact, never a selected final
adaptive checkpoint. Upstream constructs a fresh LLM agent for each simulation.
No refiner, learned memory, prompt update, or cross-episode actor state is used.
"""
import argparse
from collections import Counter
from collections.abc import Callable
from copy import deepcopy
import math
from pathlib import Path

from strive.benchmarks.json_data import canonical, items, obj, parse, string
from strive.errors import VerificationError
from strive.store import ArtifactStore
from . import UPSTREAM_REVISION
from .qualification import Qualification

USER_MODEL = "gpt-4.1-2025-04-14"
USER_TEMPERATURE = 0.0
Batch = Callable[[dict[str, object], list[dict[str, object]], Path], dict[str, object]]


def configuration(initial_actor: bytes, *, trials: int, seed: int) -> dict[str, object]:
    actor = obj(parse(initial_actor))
    if (set(actor) != {"schema", "agent", "model", "model_settings"}
            or actor["schema"] != "strive.initial-tau2-actor/1" or actor["agent"] != "llm_agent"):
        raise VerificationError("fixed stock mode requires the initial tau2 llm_agent model/options artifact")
    model = string(actor["model"])
    settings = obj(actor["model_settings"])
    temperature = settings.get("temperature")
    if (not model.strip() or isinstance(temperature, bool) or not isinstance(temperature, (int, float))
            or not math.isfinite(temperature) or not 0 <= temperature <= 2 or trials < 1):
        raise VerificationError("initial actor model, explicit temperature, and positive trial count required")
    return {"domain": "telecom", "task_split_name": "test", "agent": "llm_agent", "user": "user_simulator",
            "llm_agent": model, "llm_args_agent": settings, "llm_user": USER_MODEL,
            "llm_args_user": {"temperature": USER_TEMPERATURE}, "num_trials": trials, "seed": seed,
            "max_steps": 200, "max_errors": 10, "max_concurrency": 1, "auto_resume": False,
            "auto_review": False, "hallucination_retries": 0}


def upstream_batch(config: dict[str, object], tasks: list[dict[str, object]], output: Path) -> dict[str, object]:
    # Heavy imports stay in the isolated tau2 interpreter. This is the separate
    # fixed benchmark runner, not the adapting Strive runtime or its verifier.
    from tau2.data_model.simulation import TextRunConfig
    from tau2.data_model.tasks import Task
    from tau2.evaluator.evaluator import EvaluationType
    from tau2.runner import run_tasks
    resolved = TextRunConfig(**config)
    resolved.validate()
    (output / "resolved-tau2-config.json").write_text(resolved.model_dump_json(indent=2))
    results = run_tasks(resolved, [Task.model_validate(task) for task in tasks],
                        save_path=output / "upstream-results.json", evaluation_type=EvaluationType.ALL)
    return obj(results.model_dump(mode="json"))


def run_fixed_stock(store: ArtifactStore, qualification: Qualification, initial_actor: bytes,
                    output: Path, *, trials: int = 4, seed: int = 300,
                    execute: Batch = upstream_batch, prepare_only: bool = False) -> dict[str, object]:
    if qualification.mode != "fixed-stock" or qualification.development or qualification.validation:
        raise VerificationError("fixed stock execution requires its own fixed-stock certificate")
    splits = obj(parse(store.objects.read(qualification.source_splits)))
    if tuple(string(v) for v in items(splits["test"])) != qualification.audit:
        raise VerificationError("fixed stock task IDs/order differ from published test")
    source = parse(store.objects.read(qualification.inventory))
    if isinstance(source, dict):
        source = source.get("tasks")
    index = {string(obj(t)["id"]): obj(t) for t in items(source)}
    tasks = [index[t] for t in qualification.audit]
    config = configuration(initial_actor, trials=trials, seed=seed)
    initial = store.objects.publish(initial_actor)
    plan: dict[str, object] = {"schema": "strive.fixed-stock/1", "mode": "fixed-stock",
        "upstream_revision": UPSTREAM_REVISION, "qualification": qualification.report.digest,
        "initial_actor": initial.digest, "actor_selection": "initial", "adaptation_enabled": False,
        "cross_episode_actor_state": False, "group_disjointness_gate": False, "split": "test",
        "task_ids": qualification.audit, "config": config, "expected_simulations": len(tasks) * trials,
        "comparison_scope": "tau2 stock test with matching settings; not the original base-split leaderboard",
        "result_role": "separate fixed-agent benchmark; never adaptive campaign feedback"}
    output.mkdir(parents=True, exist_ok=True)
    # Publish before dispatch; the same folder cannot silently acquire a new plan.
    plan_path = output / "fixed-stock-plan.json"
    if plan_path.exists() and plan_path.read_bytes() != canonical(plan):
        raise VerificationError("fixed stock plan changed; use a fresh output directory")
    plan_path.write_bytes(canonical(plan))
    report_path = output / "fixed-stock-result.json"
    if report_path.exists():
        raise VerificationError("fixed stock results already exist; use a fresh output directory")
    if prepare_only:
        return {**plan, "status": "prepared", "performance_measured": False}
    report: dict[str, object] = {**plan, "status": "incomplete", "performance_measured": False}
    try:
        result = execute(deepcopy(config), deepcopy(tasks), output)
        report["raw_results"] = store.objects.publish(canonical(result)).digest
        simulations = [obj(s) for s in items(result.get("simulations"))]
        observed = Counter(string(s.get("task_id")) for s in simulations)
        if observed != Counter({t: trials for t in qualification.audit}):
            raise VerificationError("fixed stock result omits, repeats, or substitutes selected trials")
        pairs: set[tuple[str, int]] = set()
        rewards: list[float] = []
        for simulation in simulations:
            trial = simulation.get("trial")
            if isinstance(trial, bool) or not isinstance(trial, int) or not 0 <= trial < trials:
                raise VerificationError("missing or invalid fixed stock trial identity")
            pair = string(simulation["task_id"]), trial
            if pair in pairs:
                raise VerificationError("duplicate fixed stock task/trial result")
            pairs.add(pair)
            reward = obj(simulation.get("reward_info")).get("reward")
            if not isinstance(reward, (float, int)) or reward not in (0, 1):
                raise VerificationError("missing or invalid deterministic stock reward")
            rewards.append(float(reward))
        report.update(status="completed", performance_measured=True, simulations=len(simulations),
                      mean_success=sum(rewards) / len(rewards), successes=sum(rewards))
    except Exception as error:
        report["error"] = str(error)
        report_path.write_bytes(canonical(report))
        raise
    report_path.write_bytes(canonical(report))
    return report


def main() -> None:
    from .certify import certify
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_root", type=Path)
    parser.add_argument("output_root", type=Path)
    parser.add_argument("--initial-actor", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=4)
    parser.add_argument("--seed", type=int, default=300)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    # Parse the actor before costly qualification; qualification performs no inference.
    initial_actor = args.initial_actor.read_bytes()
    configuration(initial_actor, trials=args.trials, seed=args.seed)
    qualification = certify(args.data_root, args.output_root / "certificate", mode="fixed-stock")
    store = ArtifactStore(args.output_root / "certificate/artifacts")
    report = run_fixed_stock(store, qualification, initial_actor, args.output_root,
                             trials=args.trials, seed=args.seed, prepare_only=args.prepare_only)
    print(canonical(report).decode())


if __name__ == "__main__":
    main()
