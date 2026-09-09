"""Executable only inside the isolated pinned tau2 runtime.

No inference is allowed here. UserSimulator.generate is intercepted to capture
its structured input or inject a separately authorized, captured model reply.
The upstream evaluator calls retain Action.compare_with_tool_call unchanged.
"""
from copy import deepcopy
import importlib.metadata
import json
import os
from pathlib import Path
import random
import socket
import sys
from typing import Any
from unittest.mock import patch

PIN = "a2c024725189473d2d7cea3a5cfdbcc67478e41f"


def deny_network(*args: object, **kwargs: object) -> Any:
    raise RuntimeError("tau2 worker cannot dispatch inference or network effects")


def tuples(value: Any) -> Any:
    return tuple(tuples(v) for v in value) if isinstance(value, list) else value


def run(request: dict[str, Any]) -> dict[str, Any]:
    # These imports must never run in strive's runtime/verifier interpreter.
    # Upstream configuration must come from the retained request/data tree.
    import dotenv
    dotenv.load_dotenv = lambda *args, **kwargs: False
    from pydantic import TypeAdapter
    from tau2.data_model.message import AssistantMessage, Message, MultiToolMessage, ToolCall, UserMessage
    from tau2.data_model.persona import PersonaConfig
    from tau2.data_model.tasks import Task
    from tau2.domains.telecom.environment import get_environment, TelecomEnvironment
    from tau2.domains.telecom.data_model import TelecomDB
    from tau2.domains.telecom.user_data_model import TelecomUserDB
    from tau2.environment.toolkit import get_tool_types
    from tau2.evaluator.evaluator_action import ActionEvaluator
    from tau2.evaluator.evaluator_communicate import CommunicateEvaluator
    from tau2.evaluator.evaluator_env import EnvironmentEvaluator
    from tau2.user.user_simulator import UserSimulator
    from tau2.user.user_simulator_base import UserState, is_valid_user_history_message
    import tau2.user.user_simulator as user_module

    message_codec = TypeAdapter(Message)
    operation, state, payload = request["operation"], request["state"], request["payload"]
    if state is None:
        if operation not in {"initialize", "qualify"}:
            raise ValueError("operation requires a committed snapshot")
        task = Task.model_validate(payload["task"])
        config = payload.get("initialization", {})
        random.seed(config.get("seed", 0))
        env = get_environment(solo_mode=False)
        initial = task.initial_state
        history = list(initial.message_history or []) if initial else []
        env.set_state(initial.initialization_data if initial else None,
                      initial.initialization_actions if initial else None, history, strict=True)
        simulator = UserSimulator(llm=config.get("model", "retained-user-model"), instructions=str(task.user_scenario),
            tools=env.get_user_tools(include=task.user_tools), llm_args=config.get("model_settings", {}),
            persona_config=PersonaConfig.model_validate(config.get("persona", {})))
        state = {"version": "telecom-snapshot/1", "task": task.model_dump(mode="json"), "config": config,
            "identities": payload.get("identities", {}),
            "agent_history": [m.model_dump(mode="json") for m in history if
                              not (m.role == "tool" and m.requestor != "assistant")
                              and not (isinstance(m, UserMessage) and m.is_tool_call())],
            "user_history": [m.model_dump(mode="json") for m in history if is_valid_user_history_message(m)],
            "user_state": simulator.get_init_state([m for m in history if is_valid_user_history_message(m)]).model_dump(mode="json"),
            "speaker": "assistant", "pending_message": None, "pending_batch": [], "delivery_cursor": 0,
            "steps": 0, "errors": 0, "termination": None, "trajectory": [m.model_dump(mode="json") for m in history]}
    else:
        state = deepcopy(state)
        if state["version"] != "telecom-snapshot/1":
            raise ValueError("unknown snapshot version")
        task = Task.model_validate(state["task"])
        config = state["config"]
        random.setstate(tuples(state["random_state"]))
        # Failed tools may leave intentionally unsynchronized state. Reopening
        # must not call synchronization before the next authorized operation.
        with patch.object(TelecomEnvironment, "sync_tools", lambda self: None):
            env = get_environment(db=TelecomDB.model_validate(state["agent_db"]),
                                  user_db=TelecomUserDB.model_validate(state["user_db"]), solo_mode=False)
        if env.tools.db.model_dump(mode="json") != state["agent_db"] or env.user_tools.db.model_dump(mode="json") != state["user_db"]:
            raise ValueError("snapshot reconstruction changed committed databases")
        simulator = UserSimulator(llm=config.get("model", "retained-user-model"), instructions=str(task.user_scenario),
            tools=env.get_user_tools(include=task.user_tools), llm_args=config.get("model_settings", {}),
            persona_config=PersonaConfig.model_validate(config.get("persona", {})))
    if state["termination"] is not None and operation not in {"score", "snapshot", "terminate"}:
        raise ValueError("episode has terminated")
    output: Any = {}
    if operation == "initialize":
        output = {"policy": env.get_policy(), "tools": [tool.openai_schema for tool in env.get_tools()]}
    elif operation in {"agent_tool", "user_tool"}:
        requestor = "user" if operation == "user_tool" else "assistant"
        if payload.get("requestor") != requestor:
            raise ValueError("requestor authorization mismatch")
        call = ToolCall.model_validate(payload)
        if requestor == "user":
            cursor = state["delivery_cursor"]
            if cursor >= len(state["pending_batch"]) or state["pending_batch"][cursor] != call.model_dump(mode="json"):
                raise ValueError("user tool does not match the captured pending batch")
        else:
            if state["pending_batch"] or state["speaker"] != "assistant":
                raise ValueError("agent operation while user batch pending")
            state["trajectory"].append(AssistantMessage(role="assistant", tool_calls=[call]).model_dump(mode="json"))
        response = env.get_response(call)  # Preserve upstream synchronization and error behavior.
        output = response.model_dump(mode="json")
        state["trajectory"].append(output)
        state["errors"] += int(response.error)
        state["agent_history" if requestor == "assistant" else "user_history"].append(output)
        if requestor == "user":
            state["delivery_cursor"] += 1
            if state["delivery_cursor"] == len(state["pending_batch"]):
                results = state["trajectory"][-len(state["pending_batch"]):]
                state["pending_message"] = {"tool_messages": results}
                state["pending_batch"] = []
                state["delivery_cursor"] = 0
    elif operation == "deliver_message":
        message = AssistantMessage.model_validate(payload)
        if message.tool_calls or state["pending_batch"]:
            raise ValueError("tool calls must use separate authorized operations")
        state["trajectory"].append(message.model_dump(mode="json"))
        state["agent_history"].append(message.model_dump(mode="json"))
        state["pending_message"] = message.model_dump(mode="json")
        state["speaker"] = "user"
        output = {"delivered": True}
    elif operation in {"plan_user_turn", "user_turn"}:
        if state["pending_batch"] or state["pending_message"] is None:
            raise ValueError("user generation not at a message boundary")
        incoming = state["pending_message"]
        message = MultiToolMessage.model_validate(incoming) if "tool_messages" in incoming else message_codec.validate_python(incoming)
        user_state = UserState.model_validate(state["user_state"])
        captured: dict[str, Any] = {}
        class Capture(BaseException):
            pass
        def generation(**kwargs: Any) -> Any:
            captured.update({"model": kwargs["model"], "messages": [m.model_dump(mode="json") for m in kwargs["messages"]],
                             "tools": [t.openai_schema for t in kwargs["tools"]] if kwargs["tools"] else [],
                             "settings": {k: v for k, v in kwargs.items() if k not in {"model", "messages", "tools", "call_name"}}})
            if operation == "plan_user_turn":
                raise Capture()
            if captured != payload["plan"]:
                raise ValueError("captured user request differs from upstream protocol")
            return AssistantMessage.model_validate(payload["response"])
        with patch.object(user_module, "generate", generation):
            try:
                response, updated = simulator.generate_next_message(message, user_state)
            except Capture:
                output = captured
            else:
                output = response.model_dump(mode="json")
                state["user_state"] = updated.model_dump(mode="json")
                state["user_history"].append(output)
                state["trajectory"].append(output)
                state["pending_batch"] = [call.model_dump(mode="json") for call in response.tool_calls or []]
                state["delivery_cursor"] = 0
                state["pending_message"] = None
                state["speaker"] = "user" if state["pending_batch"] else "assistant"
                state["last_generation"] = payload["capture"]
                if simulator.is_stop(response):
                    state["termination"] = "user_stop"
    elif operation in {"score", "qualify"}:
        criteria = task.evaluation_criteria
        if criteria is None or not criteria.reward_basis or any(str(b.value) not in {"DB", "ENV_ASSERTION", "ACTION", "COMMUNICATE"} for b in criteria.reward_basis):
            raise ValueError("task requires missing/unknown/nondeterministic grading")
        initial = task.initial_state
        gold = get_environment(solo_mode=False)
        gold.set_state(initial.initialization_data if initial else None, initial.initialization_actions if initial else None,
                       list(initial.message_history or []) if initial else [], strict=True)
        # Fail here instead of allowing upstream's warning-and-continue path.
        for action in criteria.actions or []:
            gold.make_tool_call(action.name, requestor=action.requestor, **action.arguments)
        if operation == "qualify":
            for assertion in criteria.env_assertions or []:
                gold.run_env_assertion(assertion, raise_assertion_error=True)
            output = {"qualified": True}
        else:
            if task.model_dump(mode="json") != Task.model_validate(payload["task"]).model_dump(mode="json"):
                raise ValueError("scoring task differs from committed task")
            if payload["termination"] != state["termination"]:
                raise ValueError("termination differs from committed state")
            trajectory = [message_codec.validate_python(m) for m in state["trajectory"]]
            replay = get_environment(solo_mode=False)
            replay.set_state(initial.initialization_data if initial else None, initial.initialization_actions if initial else None,
                             trajectory, strict=True)
            if (replay.get_db_hash(), replay.get_user_db_hash()) != (env.get_db_hash(), env.get_user_db_hash()):
                output = {"status": "invalid", "reason": "committed/replayed state divergence"}
            else:
                predicted = deepcopy(env)
                direct = {"DB": int((predicted.get_db_hash(), predicted.get_user_db_hash()) == (gold.get_db_hash(), gold.get_user_db_hash())),
                          "ENV_ASSERTION": int(all(predicted.run_env_assertion(a, raise_assertion_error=False) for a in criteria.env_assertions or []))}
                tool_types = get_tool_types(env.tools) | get_tool_types(env.user_tools)
                direct["ACTION"] = int(ActionEvaluator.calculate_reward(task=task, full_trajectory=trajectory, tool_types=tool_types).reward)
                direct["COMMUNICATE"] = int(CommunicateEvaluator.calculate_reward(task=task, full_trajectory=trajectory).reward)
                upstream_env = EnvironmentEvaluator.calculate_reward(get_environment, task, trajectory, solo_mode=False, strict_replay=True)
                reward = 1
                equivalent = 1
                for basis in criteria.reward_basis:
                    reward *= direct[basis.value]
                    equivalent *= int(upstream_env.reward_breakdown[basis]) if basis.value in {"DB", "ENV_ASSERTION"} else direct[basis.value]
                if state["termination"] not in {"agent_stop", "user_stop"}:
                    reward = equivalent = 0
                output = {"status": "scored" if reward == equivalent else "invalid", "value": reward,
                          "upstream": equivalent, "components": direct}
    elif operation == "terminate":
        if not isinstance(payload, str) or payload not in {"agent_stop", "user_stop", "max_steps", "too_many_errors", "budget_exhausted"}:
            raise ValueError("unknown termination reason")
        if state["termination"] is not None and state["termination"] != payload:
            raise ValueError("cannot replace a committed termination reason")
        if state["pending_batch"]:
            raise ValueError("cannot terminate with pending tool batch")
        state["termination"] = payload
        output = {"termination": payload}
    elif operation == "snapshot":
        output = {"steps": state["steps"]}
    else:
        raise ValueError("unknown telecom operation")
    if operation not in {"plan_user_turn", "score", "qualify"}:
        state["steps"] += 1
    state["agent_db"] = env.tools.db.model_dump(mode="json")
    state["user_db"] = env.user_tools.db.model_dump(mode="json")
    state["random_state"] = random.getstate()
    return {"state": state, "output": output}


def main() -> None:
    root = Path(os.environ["TAU2_DATA_DIR"])
    if not root.is_absolute() or not root.is_dir():
        raise RuntimeError("explicit retained data root required")
    metadata = importlib.metadata.distribution("tau2")
    direct = json.loads(metadata.read_text("direct_url.json") or "{}")
    if metadata.version != "1.0.1" or direct.get("vcs_info", {}).get("commit_id") != PIN:
        raise RuntimeError("tau2 distribution is not the pinned source commit")
    # Covers accidental direct inference in evaluators as well as user simulation.
    request = json.loads(sys.stdin.buffer.read(32 * 1024 * 1024))
    with patch.object(socket.socket, "connect", deny_network), patch.object(socket, "create_connection", deny_network):
        result = run(request)
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
