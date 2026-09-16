"""Offline live-upstream checks, executed only in the isolated tau2 interpreter.

Synthetic conversations are declared fixtures, not benchmark performance
results. They exercise the real simulator, tools, evaluators and operation DB.
"""
from copy import deepcopy
from dataclasses import replace
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from typing import Any
from unittest.mock import patch

from strive.benchmarks.api import (FoundOperation, OperationContext,
    OperationReceipt, ScoringInput, TaskSpec)
from strive.benchmarks.json_data import canonical, parse
from strive.benchmarks.payloads import dumps, loads
from strive.benchmarks.store import OperationStore
from strive.codec import content_ref
from strive.contracts.lifecycle import DispatchStage, RecoveryCapability, RecoveryContract
from strive.contracts.primitives import (AccessScope, ArtifactRef, CommandId, EffectId,
    EnvironmentId, EpisodeId, LineageId, Reservation, RunId)
from strive.contracts.records import EffectAuthorization
from strive.errors import VerificationError
from strive.store.cas import CAS, durable_directory
from .adapter import TelecomScorer
from .native_worker import deny_network, run
from .prepare import check_install


class LiveBackend:
    identity = content_ref(Path(__file__).with_name("native_worker.py").read_bytes())

    def call(self, operation: str, state: bytes | None, payload: bytes) -> tuple[bytes, bytes]:
        result = run({"operation": operation, "state": parse(state) if state else None, "payload": parse(payload)})
        return canonical(result["state"]), canonical(result["output"])


def task(criteria: dict[str, Any]) -> dict[str, Any]:
    return {"id": "strive-offline-fixture", "user_scenario": {"instructions": "An offline telecom tool test."},
            "evaluation_criteria": criteria}


def initialize(definition: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = run({"operation": "initialize", "state": None,
        "payload": {"task": definition, "initialization": {"seed": 42}, "identities": {"fixture": "recorded/1"}}})
    return dict(result["state"])


def operation(state: dict[str, Any], name: str, payload: Any) -> tuple[dict[str, Any], Any]:
    result = run({"operation": name, "state": state, "payload": payload})
    return result["state"], result["output"]


def comparator() -> None:
    from tau2.data_model.tasks import Action
    from tau2.data_model.message import ToolCall
    cases = [(None, {}, True), ([], {"x": 9}, True), (None, {"x": 1}, True),
             (None, {"x": 2}, False), (["x"], {}, False), (["x"], {"x": 1, "z": 9}, True),
             (None, {"z": 9}, False)]
    for compare, arguments, expected in cases:
        action = Action(action_id="reference", name="transfer", arguments={"x": 1, "y": 2}, compare_args=compare)
        call = ToolCall(id="call", name="transfer", arguments=arguments, requestor="user")
        assert action.compare_with_tool_call(call) is expected, (compare, arguments)
    print(json.dumps({"comparator_cases": len(cases)}))


def upstream_reward(definition: dict[str, Any], state: dict[str, Any], termination: str) -> float:
    from pydantic import TypeAdapter
    from tau2.data_model.message import Message
    from tau2.data_model.simulation import SimulationRun, TerminationReason
    from tau2.data_model.tasks import Task
    from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation
    simulation = SimulationRun(id="recorded-fixture", task_id=definition["id"],
        start_time="2026-09-09T00:00:00", end_time="2026-09-09T00:00:00", duration=0.0,
        termination_reason=TerminationReason(termination),
        messages=TypeAdapter(list[Message]).validate_python(state["trajectory"]))
    return float(evaluate_simulation(simulation, Task.model_validate(definition), EvaluationType.ALL,
        solo_mode=False, domain="telecom", strict_replay=True).reward)


def equivalence() -> None:
    base = initialize(task({"reward_basis": ["DB"], "actions": [], "env_assertions": []}))
    customer_id = base["agent_db"]["customers"][0]["customer_id"] if isinstance(base["agent_db"]["customers"], list) else next(iter(base["agent_db"]["customers"]))
    read_action = {"action_id": "read", "name": "get_customer_by_id", "requestor": "assistant", "arguments": {"customer_id": customer_id}}
    cases = 0
    for basis in ("DB", "ENV_ASSERTION", "ACTION", "COMMUNICATE"):
        for solved in (False, True):
            criteria: dict[str, Any] = {"reward_basis": [basis], "actions": [], "env_assertions": []}
            if basis == "DB":
                criteria["actions"] = [{"action_id": "toggle", "name": "toggle_data", "requestor": "user", "arguments": {}}]
            elif basis == "ENV_ASSERTION":
                criteria["env_assertions"] = [{"env_type": "user", "func_name": "assert_airplane_mode_status",
                    "arguments": {"expected_status": base["user_db"]["device"]["airplane_mode"] if solved else not base["user_db"]["device"]["airplane_mode"]}}]
            elif basis == "ACTION":
                criteria["actions"] = [read_action]
            else:
                criteria["communicate_info"] = ["STRIVE-4821", "1000 mb"]
            definition = task(criteria)
            state = initialize(definition)
            if solved and basis == "DB":
                # Use the real user generation path; its recorded response gets
                # role-flipped by upstream before the separate tool operation.
                state = recorded_user_mutation(state)
            elif solved and basis == "ACTION":
                state, _ = operation(state, "agent_tool", {"id": "read", "name": read_action["name"],
                    "requestor": "assistant", "arguments": read_action["arguments"]})
            elif solved and basis == "COMMUNICATE":
                state, _ = operation(state, "deliver_message", {"role": "assistant", "content": "strive-4821: You have 1,000 MB."})
            state, _ = operation(state, "terminate", "agent_stop")
            _, result = operation(state, "score", {"task": definition, "termination": "agent_stop"})
            upstream = upstream_reward(definition, state, "agent_stop")
            assert result["status"] == "scored", (basis, solved, result)
            assert result["value"] == result["upstream"] == upstream == int(solved), (basis, solved, result, upstream)
            # Limit terminations must score zero, including otherwise solved tasks.
            limited = deepcopy(state)
            limited["termination"] = "max_steps"
            _, result = operation(limited, "score", {"task": definition, "termination": "max_steps"})
            assert result["status"] == "scored" and result["value"] == upstream_reward(definition, limited, "max_steps") == 0
            cases += 2
    # Exercise evaluate_simulation's product and the env evaluator's special
    # case for absent action/assertion lists, as distinct from empty lists.
    for criteria, expected in (
        ({"reward_basis": ["DB", "ENV_ASSERTION", "ACTION", "COMMUNICATE"]}, 1),
        ({"reward_basis": ["DB", "ACTION", "COMMUNICATE"], "actions": [], "env_assertions": [],
          "communicate_info": ["missing confirmation"]}, 0),
        ({"reward_basis": ["DB"], "actions": [], "env_assertions": [
            {"env_type": "user", "func_name": "assert_airplane_mode_status",
             "arguments": {"expected_status": not base["user_db"]["device"]["airplane_mode"]}}]}, 1),
    ):
        definition = task(criteria)
        state = initialize(definition)
        state, _ = operation(state, "terminate", "agent_stop")
        _, result = operation(state, "score", {"task": definition, "termination": "agent_stop"})
        assert result["status"] == "scored" and result["value"] == upstream_reward(definition, state, "agent_stop") == expected
        cases += 1
    print(json.dumps({"scorer_cases": cases, "bases": ["DB", "ENV_ASSERTION", "ACTION", "COMMUNICATE"]}))


_RECORDINGS: dict[str, Any] = {}


def recorded_user_mutation(state: dict[str, Any]) -> dict[str, Any]:
    state, _ = operation(state, "deliver_message", _RECORDINGS["actor"])
    state, plan = operation(state, "plan_user_turn", {})
    state, _ = operation(state, "user_turn", {"plan": plan, "response": _RECORDINGS["user_tool"], "capture": {"fixture": "recorded-user-tool"}})
    state, _ = operation(state, "user_tool", state["pending_batch"][0])
    state, plan = operation(state, "plan_user_turn", {})
    state, _ = operation(state, "user_turn", {"plan": plan, "response": _RECORDINGS["user_done"], "capture": {"fixture": "recorded-user-done"}})
    return state


def integration(root: Path) -> None:
    durable_directory(root / "objects")
    objects = CAS(root / "objects")
    pin = objects.publish(Path(__file__).read_bytes())
    run_id, episode = RunId("live-offline"), EpisodeId("episode")
    backend = LiveBackend()
    definition = task({"reward_basis": ["DB"], "actions": [], "env_assertions": []})
    spec = TaskSpec(definition["id"], "offline", objects.publish(canonical(definition)), objects.publish(canonical(definition["evaluation_criteria"])))
    store = OperationStore(root / "operations", objects, run_id, pin, 1, create=True)
    receipts: list[OperationReceipt] = []
    def context(name: str, payload: Any) -> OperationContext:
        arguments = objects.publish(canonical(payload))
        auth = EffectAuthorization(CommandId("command-" + str(len(receipts))), EffectId("effect-" + str(len(receipts))),
            arguments, pin, pin, "benchmark." + name, EnvironmentId("telecom"),
            AccessScope(run_id, LineageId("fixture"), pin), Reservation((), pin),
            RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP}), True, False), 1,
            DispatchStage.OPERATION, None, None, (arguments,), None)
        return OperationContext(auth, episode, arguments, store.head(episode))
    def commit(name: str, payload: Any) -> OperationReceipt:
        ctx = context(name, payload)
        receipt = store.commit(ctx, lambda state: backend.call(name, state, objects.read(ctx.arguments)))
        receipts.append(receipt)
        return receipt
    def crash_commit(name: str, payload: Any) -> tuple[OperationContext, FoundOperation]:
        nonlocal store
        ctx = context(name, payload)
        configuration = root / (name + "-crash.json")
        configuration.write_bytes(dumps((str(root), pin, ctx, name)))
        result = subprocess.run([sys.executable, "-I", "-B", "-m", "strive_benchmark_tau2.live_checks", "crash", str(configuration)],
            capture_output=True, timeout=90)
        assert result.returncode == 79, result.stderr.decode(errors="replace")
        store.close()
        store = OperationStore(root / "operations", objects, run_id, pin, 1)
        found = store.lookup(episode, ctx.authorization.effect_id, ctx.authorization.exact_request_reference)
        assert isinstance(found, FoundOperation)
        def never_repeat(state: bytes | None) -> tuple[bytes, bytes]:
            raise AssertionError("committed mutation was repeated")
        assert store.commit(ctx, never_repeat) == found.receipt
        receipts.append(found.receipt)
        return ctx, found
    try:
        commit("initialize", {"task": definition, "initialization": {"seed": 42}, "identities": {"fixture": "live/1"}})
        initial_data = json.loads(store.open(receipts[-1].after))
        customer = next(item for item in initial_data["agent_db"]["customers"] if item["line_ids"])
        actor_tool = deepcopy(_RECORDINGS["actor_tool"])
        actor_tool["arguments"].update(customer_id=customer["customer_id"], line_id=customer["line_ids"][0])
        agent_context, agent_found = crash_commit("agent_tool", actor_tool)
        assert json.loads(store.open(agent_found.receipt.after))["agent_db"] != initial_data["agent_db"]
        commit("deliver_message", _RECORDINGS["actor"])
        current = store.head(episode)
        assert current is not None
        _, plan = backend.call("plan_user_turn", store.open(current), b"{}")
        commit("user_turn", {"plan": parse(plan), "response": _RECORDINGS["user_tool"], "capture": {"fixture": "recorded"}})
        current = store.head(episode)
        assert current is not None
        before = json.loads(store.open(current))
        payload = before["pending_batch"][0]
        # The child exits after SQLite commit and before delivering its receipt.
        ctx, found = crash_commit("user_tool", payload)
        after = json.loads(store.open(found.receipt.after))
        assert before["user_db"] != after["user_db"], "real device mutation absent"
        assert after["pending_batch"] == [] and after["delivery_cursor"] == 0
        _, plan = backend.call("plan_user_turn", store.open(found.receipt.after), b"{}")
        commit("user_turn", {"plan": parse(plan), "response": _RECORDINGS["user_done"], "capture": {"fixture": "recorded"}})
        before_snapshot = json.loads(store.open(receipts[-1].after))
        snap = commit("snapshot", {})
        restored = json.loads(store.open(snap.after))
        for name in ("agent_db", "user_db", "user_state", "agent_history", "user_history", "random_state", "pending_batch", "delivery_cursor"):
            assert before_snapshot[name] == restored[name], name
        commit("terminate", "agent_stop")
        scorer = TelecomScorer(store, backend, pin)
        inputs = ScoringInput(spec, receipts[-1].after, objects.publish(dumps(tuple(receipts))),
            tuple(objects.publish(dumps(receipt)) for receipt in receipts), objects.publish(canonical("agent_stop")))
        reward = scorer.score(inputs)
        assert reward.status == "scored" and reward.metrics[0].value == 0  # One toggle differs from initial DB.
        try:
            scorer.score(replace(inputs, operation_receipts=inputs.operation_receipts[1:]))
        except VerificationError:
            pass
        else:
            raise AssertionError("incomplete operation receipt chain accepted")
        store.close()
        store = OperationStore(root / "operations", objects, run_id, pin, 2)
        assert store.lookup(episode, ctx.authorization.effect_id, ctx.authorization.exact_request_reference) == found
        assert store.lookup(episode, agent_context.authorization.effect_id, agent_context.authorization.exact_request_reference) == agent_found
        assert store.open(receipts[-1].after)
        print(json.dumps({"operations": len(receipts), "crash_after_commit_recovered": ["agent_tool", "user_tool"],
                          "repeat_mutations": 0, "snapshot_fields": 8, "live_model_calls": 0}))
    finally:
        store.close()


def crash(configuration: Path) -> None:
    root_name, pin, ctx, name = loads(configuration.read_bytes(), tuple)
    assert isinstance(root_name, str) and isinstance(pin, ArtifactRef) and isinstance(ctx, OperationContext)
    assert name in ("agent_tool", "user_tool") and isinstance(name, str)
    root = Path(root_name)
    objects = CAS(root / "objects")
    def fault(point: str) -> None:
        if point == "after-commit":
            os._exit(79)
    store = OperationStore(root / "operations", objects, ctx.authorization.permitted_scope.run_id, pin, 1, fault=fault)
    store.commit(ctx, lambda state: LiveBackend().call(name, state, objects.read(ctx.arguments)))
    raise AssertionError("crash did not fire")


def fixed_configuration() -> None:
    from tau2.config import DEFAULT_LLM_USER, DEFAULT_LLM_ARGS_USER
    from tau2.data_model.simulation import TextRunConfig
    from .fixed_stock import USER_MODEL, USER_TEMPERATURE, configuration
    actor = canonical({"schema": "strive.initial-tau2-actor/1", "agent": "llm_agent", "model": DEFAULT_LLM_USER,
                       "model_settings": {"temperature": 0.0}})
    config = TextRunConfig(**configuration(actor, trials=4, seed=300))
    config.validate()
    assert config.task_split_name == "test" and config.agent == "llm_agent"
    assert config.llm_user == USER_MODEL == DEFAULT_LLM_USER
    assert config.llm_args_user == DEFAULT_LLM_ARGS_USER == {"temperature": USER_TEMPERATURE}
    assert not config.auto_review and not config.auto_resume and config.hallucination_retries == 0
    print(json.dumps({"fixed_stock_configuration": "validated", "user_model": USER_MODEL,
                      "temperature": USER_TEMPERATURE, "live_model_calls": 0}))


def main() -> None:
    check_install()
    mode = sys.argv[1]
    if mode != "crash":
        _RECORDINGS.update(json.loads(Path(sys.argv[3]).read_bytes()))
    # Also reject accidental provider calls from scorers/import-time clients.
    with patch.object(socket.socket, "connect", deny_network), patch.object(socket.socket, "connect_ex", deny_network), patch.object(socket, "create_connection", deny_network):
        if mode == "comparator":
            comparator()
        elif mode == "equivalence":
            equivalence()
        elif mode == "integration":
            integration(Path(sys.argv[2]))
        elif mode == "fixed-configuration":
            fixed_configuration()
        elif mode == "crash":
            crash(Path(sys.argv[2]))
        else:
            raise ValueError("unknown live check")


if __name__ == "__main__":
    main()
