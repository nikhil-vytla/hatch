from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

import mcp.types as mcp_types
from hud.agents import create_agent
from hud.agents.base import Agent
from hud.agents.tool_agent import ToolAgent
from hud.agents.types import ToolStep
from hud.eval import DockerRuntime, Task
from hud.types import Step
from hud.utils.time import now_iso
from pydantic import Field

from .admission import AdmissionRecord, check_admission
from .canonical import atomic_write, canonical_bytes
from .delivery import CompleteDeliveryReceiptV1, TurnDeliveryController
from .experiment import Execution, ExecutionError, Unit
from .outcome import FailureKind
from .perturbation import VariantSet
from .provider import TokenPricing, pricing_for
from .swebench import SweBenchTask
from .swebench_harness import OfficialHarnessError, run_official_harness
from .swebench_specs import (
    CompiledBundle,
    compile_bundle,
    freeze_swe_task,
    load_evaluator_specs,
)
from .types import NonEmptyText, SourceId, StrictModel


def _docker_runtime(image: str) -> DockerRuntime:
    return DockerRuntime(image, run_args=("--privileged",))


class HudEpisode(StrictModel):
    model_patch: str
    delivery: CompleteDeliveryReceiptV1
    reported_model: NonEmptyText
    prompt_tokens: int = Field(ge=0)
    completion_tokens: int = Field(ge=0)
    estimated_cost_usd: float = Field(ge=0)


class HarnessTurnAgent(Agent):
    def __init__(
        self,
        policy: ToolAgent[Any, Any],
        *,
        turns: tuple[NonEmptyText, ...],
        step_budgets: tuple[int, ...],
    ) -> None:
        self.policy = policy
        self.turns = turns
        self.step_budgets = step_budgets

    async def __call__(self, run) -> None:
        connections = {}
        manifest = run.client.manifest
        if manifest is not None:
            wanted = {client.protocol for client in type(self.policy).clients}
            for capability in manifest.bindings:
                if (
                    capability.protocol in wanted
                    and capability.protocol not in connections
                ):
                    connections[capability.protocol] = await run.client.open(
                        capability.protocol
                    )
        state = await self.policy._initialize_state(prompt=run.prompt_messages)
        state.tools, state.params = await self.policy._build_tools(connections)
        controller = TurnDeliveryController(self.turns, self.step_budgets)
        trace = run.trace
        while not controller.complete:
            started_at = now_iso()
            step = await self.policy.get_response(
                state,
                system_prompt=self.policy.config.system_prompt,
                citations_enabled=self.policy.config.citations_enabled,
            )
            step.started_at = step.started_at or started_at
            step.model = step.model or self.policy.config.model
            run.record(step)
            if step.error:
                raise RuntimeError(step.error)
            stopped = self.policy._stop_condition(step)
            if stopped is not None:
                trace.stop_reason = stopped
                raise RuntimeError(
                    f"policy stopped before full turn delivery: {stopped}"
                )
            submitted = step.done or not step.tool_calls
            if not submitted:
                for call in step.tool_calls:
                    call_started_at = now_iso()
                    result = await self.policy._dispatch_call(call, state)
                    run.record(
                        ToolStep(call=call, result=result, started_at=call_started_at)
                    )
                    message = self.policy._format_result(call, result, state)
                    if message is None:
                        continue
                    if isinstance(message, list):
                        state.messages.extend(cast("list[Any]", message))
                    else:
                        state.messages.append(message)
            follow_up = controller.observe_step(submitted=submitted)
            if follow_up is not None:
                state.messages.append(self.policy._format_user_text(follow_up))
                run.record(
                    Step(
                        source="user",
                        messages=[
                            mcp_types.PromptMessage(
                                role="user",
                                content=mcp_types.TextContent(
                                    type="text",
                                    text=follow_up,
                                ),
                            )
                        ],
                    )
                )
        receipt = controller.receipt()
        trace.content = receipt.as_answer()
        trace.status = "completed"
        trace.stop_reason = (
            "max_steps"
            if receipt.phases[-1].advance_trigger == "terminal_budget_exhaustion"
            else "done"
        )


def parse_delivery_receipt(value: object) -> CompleteDeliveryReceiptV1:
    """Parse a delivery receipt from HUD grade info.

    The receipt crosses the HUD wire as JSON, so tuple fields arrive as
    lists. Strict python-mode validation rejects those, so validation must
    go through JSON mode.
    """
    return CompleteDeliveryReceiptV1.model_validate_json(json.dumps(value))


def _docker_build(directory: Path, image: str) -> None:
    result = subprocess.run(
        [
            "docker",
            "build",
            "--platform",
            "linux/amd64",
            "--tag",
            image,
            "--file",
            "Dockerfile.hud",
            ".",
        ],
        cwd=directory,
        text=True,
        capture_output=True,
        timeout=1800,
        check=False,
    )
    if result.returncode:
        raise ExecutionError("verifier", f"HUD image build failed: {result.stderr}")


async def _run_episode(
    *,
    image: str,
    environment_name: str,
    condition: str,
    turns: tuple[NonEmptyText, ...],
    step_budgets: tuple[int, ...],
    model: str,
    pricing: TokenPricing,
) -> HudEpisode:
    policy = create_agent(
        model,
        max_steps=sum(step_budgets),
        max_tokens=1024,
        auto_respond=False,
    )
    if not isinstance(policy, ToolAgent):
        raise ExecutionError("agent", "HUD model did not create a tool-capable policy")
    agent = HarnessTurnAgent(
        policy,
        turns=turns,
        step_budgets=step_budgets,
    )
    task = Task(env=environment_name, id="episode", args={"condition": condition})
    try:
        job = await task.run(
            agent,
            runtime=_docker_runtime(image),
            rollout_timeout=3600,
        )
    except TimeoutError as error:
        raise ExecutionError("agent", "HUD episode timed out") from error
    except Exception as error:
        raise ExecutionError("agent", f"HUD episode failed: {error}") from error
    if len(job.runs) != 1:
        raise ExecutionError("agent", "HUD returned an invalid run count")
    run = job.runs[0]
    models: list[str] = []
    prompt_tokens = 0
    completion_tokens = 0
    for step in run.trace.steps:
        reported = getattr(step, "model", None)
        if isinstance(reported, str) and reported:
            models.append(reported)
        usage = getattr(step, "usage", None)
        if usage is not None:
            prompt_tokens += usage.prompt_tokens or 0
            completion_tokens += usage.completion_tokens or 0
    cost = pricing.cost_usd(prompt_tokens, completion_tokens)

    def episode_error(
        failure_kind: FailureKind,
        message: str,
    ) -> ExecutionError:
        # The episode already ran, so its metered usage must survive into
        # the failure receipt instead of being reported as zero spend.
        return ExecutionError(
            failure_kind,
            message,
            reported_model=models[-1] if models else None,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            estimated_cost_usd=cost,
        )

    if run.trace.stop_reason == "length":
        raise episode_error("budget", "HUD model response was truncated")
    if run.trace.is_error:
        raise episode_error("agent", run.trace.error or "HUD agent run failed")
    patch = run.grade.info.get("model_patch")
    if not isinstance(patch, str):
        raise episode_error("agent", "HUD run omitted the candidate patch")
    try:
        delivery = parse_delivery_receipt(run.grade.info.get("delivery"))
    except ValueError as error:
        raise episode_error(
            "agent", "HUD run omitted a complete delivery receipt"
        ) from error
    if not models:
        raise ExecutionError("agent", "HUD run omitted response.model")
    return HudEpisode(
        model_patch=patch,
        delivery=delivery,
        reported_model=models[-1],
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        estimated_cost_usd=cost,
    )


class SweBenchExecutor:
    """Build, run, and grade one SWE-bench episode per experiment unit.

    Compilation is memoized per task and episodes are cached on disk, so a
    relaunch reuses both. A replayed episode is reported with `fresh=False`:
    it still carries the cost of the episode it replays, which is what makes a
    single journal readable, but only fresh rows are summed as spend.
    """

    def __init__(
        self,
        tasks: Mapping[SourceId, SweBenchTask],
        variants: Mapping[SourceId, VariantSet],
        admissions: Mapping[SourceId, AdmissionRecord],
        *,
        model: str,
        work_directory: Path,
        pricing: TokenPricing | None = None,
    ) -> None:
        self.tasks = tasks
        self.variants = variants
        self.admissions = admissions
        self.model = model
        self.work_directory = work_directory
        self.pricing = pricing or pricing_for(model)
        self._compiled: dict[SourceId, tuple[str, CompiledBundle]] = {}

    def _compile(self, task: SweBenchTask) -> tuple[str, CompiledBundle]:
        if task.record_id in self._compiled:
            return self._compiled[task.record_id]
        instance_id = str(task.instance_id)
        directory = self.work_directory / "environments" / instance_id
        directory.mkdir(parents=True, exist_ok=True)
        spec, environment = freeze_swe_task(task)
        check_admission(spec, environment, self.admissions[task.record_id])
        bundle = compile_bundle(
            spec,
            environment,
            self.variants[task.record_id],
        )
        bundle.write_agent_context(directory)
        image = f"parallax-swebench-{instance_id.lower()}:local"
        _docker_build(directory, image)
        self._compiled[task.record_id] = (image, bundle)
        return image, bundle

    def __call__(self, unit: Unit) -> Execution:
        task = self.tasks[unit.task_id]
        variant = self.variants[unit.task_id].variant(unit.condition)
        image, bundle = self._compile(task)
        spec, environment = load_evaluator_specs(bundle)
        episode_path = (
            self.work_directory
            / "episodes"
            / str(task.instance_id)
            / f"{unit.condition}-trial-{unit.trial_index}.json"
        )
        fresh = not episode_path.exists()
        if fresh:
            episode = asyncio.run(
                _run_episode(
                    image=image,
                    environment_name=f"parallax-{task.instance_id}",
                    condition=str(unit.condition),
                    turns=self.variants[unit.task_id].prompts(unit.condition),
                    step_budgets=tuple(turn.steps for turn in variant.turns),
                    model=self.model,
                    pricing=self.pricing,
                )
            )
            atomic_write(episode_path, canonical_bytes(episode) + b"\n")
        else:
            episode = HudEpisode.model_validate_json(episode_path.read_bytes())
        harness_directory = (
            self.work_directory
            / "official-harness"
            / str(unit.task_id)
            / f"{unit.condition}-trial-{unit.trial_index}"
        )
        try:
            evaluation = run_official_harness(
                spec,
                environment,
                episode.model_patch,
                model=episode.reported_model,
                run_directory=harness_directory,
                harness_source_directory=(
                    self.work_directory / "swebench-harness-source"
                ),
            )
        except OfficialHarnessError as error:
            raise ExecutionError(
                "verifier",
                str(error),
                reported_model=episode.reported_model,
                prompt_tokens=episode.prompt_tokens,
                completion_tokens=episode.completion_tokens,
                estimated_cost_usd=episode.estimated_cost_usd if fresh else 0.0,
            ) from error
        return Execution(
            outcome=evaluation.outcome,
            reported_model=episode.reported_model,
            prompt_tokens=episode.prompt_tokens,
            completion_tokens=episode.completion_tokens,
            estimated_cost_usd=episode.estimated_cost_usd,
            fresh=fresh,
            verifier_report_digest=evaluation.report_digest,
            harness_revision=evaluation.harness_revision,
            image_digest=evaluation.image_digest,
            delivery=episode.delivery,
        )
