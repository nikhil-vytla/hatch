from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from hud.agents import create_agent
from hud.eval import DockerRuntime, Task
from pydantic import Field

from .canonical import atomic_write, canonical_bytes
from .screening import ScreeningExecution, ScreeningExecutionError, ScreeningUnit
from .swebench import SweScriptFamily
from .swebench_env import render_environment
from .swebench_harness import OfficialHarnessError, run_official_harness
from .types import NonEmptyText, StrictModel


class TokenPricing(StrictModel):
    input_usd_per_million: float = Field(gt=0)
    output_usd_per_million: float = Field(gt=0)


CLAUDE_OPUS_PRICING = TokenPricing(
    input_usd_per_million=15.0,
    output_usd_per_million=75.0,
)


class HudEpisode(StrictModel):
    model_patch: str
    reported_model: NonEmptyText
    prompt_tokens: int = Field(ge=0)
    completion_tokens: int = Field(ge=0)
    estimated_cost_usd: float = Field(ge=0)


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
        raise ScreeningExecutionError(
            "verifier", f"HUD image build failed: {result.stderr}"
        )


async def _run_episode(
    *,
    image: str,
    environment_name: str,
    model: str,
    max_steps: int,
    pricing: TokenPricing,
) -> HudEpisode:
    agent = create_agent(
        model,
        max_steps=max_steps,
        max_tokens=1024,
        auto_respond=True,
    )
    task = Task(env=environment_name, id="episode", args={"arm": "static"})
    try:
        job = await task.run(
            agent,
            runtime=DockerRuntime(image),
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
    if run.trace.stop_reason == "length":
        raise ScreeningExecutionError("budget", "HUD model response was truncated")
    if run.trace.is_error:
        raise ScreeningExecutionError(
            "agent", run.trace.error or "HUD agent run failed"
        )
    patch = run.grade.info.get("model_patch")
    if not isinstance(patch, str):
        raise ScreeningExecutionError("agent", "HUD run omitted the candidate patch")
    if not run.grade.info.get("schedule_complete"):
        raise ScreeningExecutionError(
            "agent", "HUD run ended before the static task completed"
        )
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
    if not models:
        raise ScreeningExecutionError("agent", "HUD run omitted response.model")
    cost = (
        prompt_tokens * pricing.input_usd_per_million
        + completion_tokens * pricing.output_usd_per_million
    ) / 1_000_000
    return HudEpisode(
        model_patch=patch,
        reported_model=models[-1],
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        estimated_cost_usd=cost,
    )


class HudStaticExecutor:
    def __init__(
        self,
        families: dict[str, SweScriptFamily],
        *,
        model: str,
        work_directory: Path,
        pricing: TokenPricing = CLAUDE_OPUS_PRICING,
    ) -> None:
        self.families = families
        self.model = model
        self.work_directory = work_directory
        self.pricing = pricing
        self._images: dict[str, str] = {}

    def _image(self, family: SweScriptFamily) -> str:
        problem = family.static.problem
        key = str(problem.record_id)
        instance_id = str(problem.instance_id)
        if key in self._images:
            return self._images[key]
        directory = self.work_directory / "environments" / instance_id
        directory.mkdir(parents=True, exist_ok=True)
        bundle = render_environment(family)
        bundle.write(directory)
        image = f"parallax-screening-{instance_id.lower()}:local"
        _docker_build(directory, image)
        self._images[key] = image
        return image

    def __call__(self, unit: ScreeningUnit) -> ScreeningExecution:
        source_id = str(unit.source_id)
        family = self.families[source_id]
        problem = family.static.problem
        image = self._image(family)
        episode_path = (
            self.work_directory
            / "episodes"
            / str(problem.instance_id)
            / f"trial-{unit.trial_index}.json"
        )
        if episode_path.exists():
            episode = HudEpisode.model_validate_json(episode_path.read_bytes())
        else:
            episode = asyncio.run(
                _run_episode(
                    image=image,
                    environment_name=f"parallax-{problem.instance_id}",
                    model=self.model,
                    max_steps=sum(family.static.agent_steps),
                    pricing=self.pricing,
                )
            )
            atomic_write(episode_path, canonical_bytes(episode) + b"\n")
            print(
                f"SCREENING_USAGE source={problem.instance_id} "
                f"trial={unit.trial_index} cost_usd={episode.estimated_cost_usd:.6f}",
                flush=True,
            )
        harness_directory = (
            self.work_directory
            / "official-harness"
            / source_id
            / f"trial-{unit.trial_index}"
        )
        try:
            evaluation = run_official_harness(
                problem,
                episode.model_patch,
                model=episode.reported_model,
                run_directory=harness_directory,
            )
        except OfficialHarnessError as error:
            raise ScreeningExecutionError(
                "verifier",
                str(error),
                reported_model=episode.reported_model,
                prompt_tokens=episode.prompt_tokens,
                completion_tokens=episode.completion_tokens,
                estimated_cost_usd=episode.estimated_cost_usd,
            ) from error
        return ScreeningExecution(
            outcome=evaluation.outcome,
            reported_model=episode.reported_model,
            prompt_tokens=episode.prompt_tokens,
            completion_tokens=episode.completion_tokens,
            estimated_cost_usd=episode.estimated_cost_usd,
            verifier_report_digest=evaluation.report_digest,
            harness_revision=evaluation.harness_revision,
            image_digest=evaluation.image_digest,
        )
