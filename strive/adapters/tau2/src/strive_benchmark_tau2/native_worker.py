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


def message_record(message: Any) -> dict[str, Any]:
    """Retain model fields, excluding only timestamps on message envelopes."""
    return dict(message.model_dump(mode="json", exclude={
        "timestamp": True, "tool_messages": {"__all__": {"timestamp"}},
    }))


def tool_results_message(results: list[dict[str, Any]]) -> dict[str, Any]:
    # At PIN, the batch requires role="tool" and tool_messages; each result
    # requires id and role="tool". Validate before retaining the pending input.
    from tau2.data_model.message import MultiToolMessage
    return message_record(MultiToolMessage(role="tool", tool_messages=results))


def generation_request(kwargs: dict[str, Any]) -> dict[str, Any]:
    # UserState.flip_roles creates new messages with wall-clock timestamps on
    # every call. Those timestamps are not sent by to_litellm_messages. Exclude
    # only that message metadata; retain content, tool arguments and settings.
    return {"model": kwargs["model"],
            "messages": [message_record(m) for m in kwargs["messages"]],
            "tools": [t.openai_schema for t in kwargs["tools"]] if kwargs["tools"] else [],
            "settings": {k: v for k, v in kwargs.items() if k not in {"model", "messages", "tools", "call_name"}}}


def reference_trajectory(task: Any, environment: Any) -> list[Any]:
    """Record the reference actions as live calls, including telecom sync."""
    from tau2.data_model.message import AssistantMessage, ToolCall, UserMessage
    initial = task.initial_state
    trajectory = list(initial.message_history or []) if initial else []
    for action in task.evaluation_criteria.actions or []:
        call = ToolCall(id=action.action_id, name=action.name, requestor=action.requestor, arguments=action.arguments)
        message_type = UserMessage if action.requestor == "user" else AssistantMessage
        trajectory.append(message_type(role=action.requestor, tool_calls=[call]))
        response = environment.get_response(call)
        if response.error:
            raise ValueError(f"reference action {action.action_id} ({action.name}) failed: {response.content}")
        trajectory.append(response)
    return trajectory


def run(request: dict[str, Any]) -> dict[str, Any]:
    # These imports must never run in strive's runtime/verifier interpreter.
    # Upstream configuration must come from the retained request/data tree.
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
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
                state["pending_message"] = tool_results_message(results)
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
            captured.update(generation_request(kwargs))
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
        if operation == "qualify":
            gold = get_environment(solo_mode=False)
            gold.set_state(initial.initialization_data if initial else None, initial.initialization_actions if initial else None,
                           list(initial.message_history or []) if initial else [], strict=True)
            # Keep the preparation gate strict about errors in upstream's DB
            # target construction, which uses unsynchronized make_tool_call.
            for action in criteria.actions or []:
                gold.make_tool_call(action.name, requestor=action.requestor, **action.arguments)
            # Assertions grade the replayed environment, not the DB target.
            # get_response synchronizes after each reference action just as a
            # real trajectory does; calculate_reward then strictly replays it.
            reference = reference_trajectory(task, deepcopy(env))
            checked = EnvironmentEvaluator.calculate_reward(get_environment, task, reference, solo_mode=False, strict_replay=True)
            failures = [str(check.env_assertion) for check in checked.env_assertions or [] if not check.met]
            if failures:
                raise ValueError("reference trajectory fails assertions: " + "; ".join(failures))
            if checked.reward != 1:
                raise ValueError("reference trajectory fails selected environment reward: " + str(checked.reward_breakdown))
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
            elif state["termination"] not in {"agent_stop", "user_stop"}:
                # evaluate_simulation returns zero before running evaluators
                # on premature termination. Keep receipt/state checks above.
                output = {"status": "scored", "value": 0, "upstream": 0, "components": {}}
            else:
                # Use the pinned deterministic evaluators, including the env
                # evaluator's None-vs-empty behavior, DB target construction,
                # and execution of every assertion on the replayed trajectory.
                # Combine component rewards exactly as evaluate_simulation(ALL).
                environment_reward = EnvironmentEvaluator.calculate_reward(get_environment, task, trajectory, solo_mode=False, strict_replay=True)
                tool_types = get_tool_types(env.tools) | get_tool_types(env.user_tools)
                action_reward = ActionEvaluator.calculate_reward(task=task, full_trajectory=trajectory, tool_types=tool_types)
                communicate_reward = CommunicateEvaluator.calculate_reward(task=task, full_trajectory=trajectory)
                selected = {basis.value for basis in criteria.reward_basis}
                reward = 1
                components = {}
                for bases, result in (({"DB", "ENV_ASSERTION"}, environment_reward),
                                      ({"ACTION"}, action_reward), ({"COMMUNICATE"}, communicate_reward)):
                    if selected & bases:
                        reward *= int(result.reward)
                        components.update({basis.value: value for basis, value in (result.reward_breakdown or {}).items()})
                output = {"status": "scored", "value": reward, "upstream": reward, "components": components}
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
