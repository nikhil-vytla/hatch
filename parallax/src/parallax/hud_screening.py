from __future__ import annotations

import asyncio
import subprocess
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

from .canonical import atomic_write, canonical_bytes
from .delivery import CompleteDeliveryReceiptV1, TurnDeliveryController
from .hud_compile import CompiledBundleV1, compile_hud, load_evaluator_specs
from .hud_wire import WireFormatError, parse_wire, raise_stream_frame_limit
from .metering import MeteredUsage, meter
from .outcome import FailureKind
from .preflight import require_docker
from .screening import ScreeningExecution, ScreeningExecutionError, ScreeningUnit
from .specs import freeze_swe_specs
from .swebench import SweScriptFamily
from .swebench_harness import OfficialHarnessError, run_official_harness
from .types import NonEmptyText, NonNegativeInt, StrictModel


def _docker_runtime(image: str) -> DockerRuntime:
    return DockerRuntime(image, run_args=("--privileged",))


class HudEpisode(StrictModel):
    """One paid episode, stored as tokens rather than as dollars.

    A cached episode outlives the rate card that was current when it ran, and
    a resume that trusted a stored price would carry a retired rate into fresh
    evidence — which is exactly how a screening round came to be reported at
    three times its cost. Price is therefore never stored, only derived.
    """

    model_patch: str
    delivery: CompleteDeliveryReceiptV1
    reported_model: NonEmptyText
    prompt_tokens: NonNegativeInt
    completion_tokens: NonNegativeInt

    @property
    def usage(self) -> MeteredUsage:
        return meter(
            self.reported_model,
            prompt_tokens=self.prompt_tokens,
            completion_tokens=self.completion_tokens,
        )


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


def _docker_build(directory: Path, image: str) -> None:
    require_docker()
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
        raise ScreeningExecutionError(
            "verifier", f"HUD image build failed: {result.stderr}"
        )


async def _run_episode(
    *,
    image: str,
    environment_name: str,
    arm: str,
    turns: tuple[NonEmptyText, ...],
    step_budgets: tuple[int, ...],
    model: str,
) -> HudEpisode:
    policy = create_agent(
        model,
        max_steps=sum(step_budgets),
        max_tokens=1024,
        auto_respond=False,
    )
    if not isinstance(policy, ToolAgent):
        raise ScreeningExecutionError(
            "agent", "HUD model did not create a tool-capable policy"
        )
    agent = HarnessTurnAgent(
        policy,
        turns=turns,
        step_budgets=step_budgets,
    )
    task = Task(env=environment_name, id="episode", args={"arm": arm})
    try:
        job = await task.run(
            agent,
            runtime=_docker_runtime(image),
            rollout_timeout=3600,
        )
    except TimeoutError as error:
        raise ScreeningExecutionError("agent", "HUD episode timed out") from error
    except Exception as error:
        raise ScreeningExecutionError(
            "agent", f"HUD episode failed: {error}"
        ) from error
    if len(job.runs) != 1:
        raise ScreeningExecutionError("agent", "HUD returned an invalid run count")
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
    usage = meter(
        model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )

    def episode_error(
        failure_kind: FailureKind,
        message: str,
    ) -> ScreeningExecutionError:
        # The episode already ran, so its metered usage must survive into
        # the failure receipt instead of being reported as zero spend.
        return ScreeningExecutionError(
            failure_kind,
            message,
            reported_model=models[-1] if models else None,
            usage=usage,
        )

    if run.trace.stop_reason == "length":
        raise episode_error("budget", "HUD model response was truncated")
    if run.trace.is_error:
        raise episode_error("agent", run.trace.error or "HUD agent run failed")
    patch = run.grade.info.get("model_patch")
    if not isinstance(patch, str):
        raise episode_error("agent", "HUD run omitted the candidate patch")
    try:
        delivery = parse_wire(
            CompleteDeliveryReceiptV1,
            run.grade.info.get("delivery"),
        )
    except WireFormatError as error:
        raise episode_error(
            "agent", "HUD run omitted a complete delivery receipt"
        ) from error
    if not models:
        raise ScreeningExecutionError("agent", "HUD run omitted response.model")
    return HudEpisode(
        model_patch=patch,
        delivery=delivery,
        reported_model=models[-1],
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


class HudExecutor:
    def __init__(
        self,
        families: dict[str, SweScriptFamily],
        *,
        model: str,
        work_directory: Path,
    ) -> None:
        self.families = families
        self.model = model
        self.work_directory = work_directory
        self._compiled: dict[str, tuple[str, CompiledBundleV1]] = {}

    def _unit_directory(self, root: str, unit: ScreeningUnit) -> Path:
        """Every per-unit path carries the whole unit identity.

        A path built from instance and trial alone collides across arms, which
        silently serves one arm's cached episode to another.
        """
        return (
            self.work_directory
            / root
            / str(self.families[str(unit.source_id)].static.problem.instance_id)
            / f"{unit.arm}-trial-{unit.trial_index}"
        )

    def _compile(self, family: SweScriptFamily) -> tuple[str, CompiledBundleV1]:
        problem = family.static.problem
        key = str(problem.record_id)
        instance_id = str(problem.instance_id)
        if key in self._compiled:
            return self._compiled[key]
        directory = self.work_directory / "environments" / instance_id
        directory.mkdir(parents=True, exist_ok=True)
        task_spec, env_spec = freeze_swe_specs(family)
        bundle = compile_hud(task_spec, env_spec)
        bundle.write_agent_context(directory)
        image = f"parallax-screening-{instance_id.lower()}:local"
        _docker_build(directory, image)
        self._compiled[key] = (image, bundle)
        return image, bundle

    def __call__(self, unit: ScreeningUnit) -> ScreeningExecution:
        source_id = str(unit.source_id)
        family = self.families[source_id]
        problem = family.static.problem
        image, bundle = self._compile(family)
        task_spec, env_spec = load_evaluator_specs(bundle)
        script = getattr(family, unit.arm)
        episode_path = self._unit_directory("episodes", unit).with_suffix(".json")
        if episode_path.exists():
            episode = HudEpisode.model_validate_json(episode_path.read_bytes())
        else:
            raise_stream_frame_limit()
            episode = asyncio.run(
                _run_episode(
                    image=image,
                    environment_name=f"parallax-{problem.instance_id}",
                    arm=str(unit.arm),
                    turns=tuple(turn.text for turn in script.turns),
                    step_budgets=script.agent_steps,
                    model=self.model,
                )
            )
            atomic_write(episode_path, canonical_bytes(episode) + b"\n")
            print(
                f"SCREENING_USAGE source={problem.instance_id} "
                f"trial={unit.trial_index} arm={unit.arm} "
                f"cost_usd={episode.usage.cost_usd:.6f}",
                flush=True,
            )
        harness_directory = self._unit_directory("official-harness", unit)
        try:
            evaluation = run_official_harness(
                task_spec,
                env_spec,
                episode.model_patch,
                model=episode.reported_model,
                run_directory=harness_directory,
                harness_source_directory=(
                    self.work_directory / "swebench-harness-source"
                ),
            )
        except OfficialHarnessError as error:
            raise ScreeningExecutionError(
                "verifier",
                str(error),
                reported_model=episode.reported_model,
                usage=episode.usage,
            ) from error
        return ScreeningExecution(
            outcome=evaluation.outcome,
            reported_model=episode.reported_model,
            usage=episode.usage,
            verifier_report_digest=evaluation.report_digest,
            harness_revision=evaluation.harness_revision,
            image_digest=evaluation.image_digest,
            delivery=episode.delivery,
        )
