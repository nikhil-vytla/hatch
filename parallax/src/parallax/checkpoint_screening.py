"""Screen one checkpoint family: reference-free perturbation, one loop.

This is the checkpoint benchmark's configuration of `experiment`, not a second
experiment loop. It builds the family's conditions, wires an agent factory with
a spend ceiling, and hands both to `execute`. The plan, journal, resume logic
and cost accounting are the shared ones.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, TypeAlias

from .checkpoint_agent import ProviderCheckpointAgent
from .checkpoint_evolution import (
    CARRY_REFERENCE,
    EVOLVED,
    CaseExecution,
    CheckpointFamily,
    SeedFamilyFixture,
    admit_family,
    build_checkpoint_variants,
    load_seed_family,
    run_case_trusted,
)
from .checkpoint_runner import (
    AdmittedFamily,
    CheckpointAgent,
    CheckpointDelivery,
    MeteredWorkspace,
    StageUsage,
    checkpoint_executor,
)
from .checkpoint_sandbox import (
    PINNED_SANDBOX,
    SandboxCaseExecution,
    SandboxRunner,
)
from .experiment import (
    CostRange,
    ExperimentConfig,
    Observation,
    execute,
    plan_experiment,
)
from .outcome import BudgetError
from .perturbation import Condition
from .provider import (
    FREE,
    HUD_GATEWAY_ENDPOINT,
    HudGatewayProvider,
    TokenPricing,
    Transport,
    pricing_for,
)
from .types import SourceId, TrialIndex

CeScreeningMode: TypeAlias = Literal["dry-run", "live"]
CeDryRunExecution: TypeAlias = Literal["trusted-fixture", "sandbox"]

CE_SCREENING_MODEL = "claude-haiku-4-5"
CE_EXPECTED_RESPONSE_MODEL = "claude-haiku-4-5-20251001"
CE_DRY_RUN_MODEL = "ce-dry-run-model-not-contacted"
CE_MAX_OUTPUT_TOKENS = 2048
CE_TRIALS = 10
CE_CONDITIONS: tuple[Condition, ...] = (CARRY_REFERENCE, EVOLVED)
SCREENING_SPEND_CAP_USD = 5.0
# Conservative chars-per-token divisor and fixed protocol overhead for the
# pre-spend upper bound; both err toward overestimating cost.
_CHARS_PER_TOKEN = 3
_PROTOCOL_OVERHEAD_TOKENS = 1024


def _stage_input_tokens_upper(spec_chars: int, workspace_bytes: int) -> int:
    return (
        spec_chars + workspace_bytes
    ) // _CHARS_PER_TOKEN + _PROTOCOL_OVERHEAD_TOKENS


def stage_cost_upper_usd(
    delivery: CheckpointDelivery,
    *,
    max_output_tokens: int,
    pricing: TokenPricing,
) -> float:
    return pricing.cost_usd(
        _stage_input_tokens_upper(
            len(delivery.public_spec),
            delivery.workspace.content_bytes,
        ),
        max_output_tokens,
    )


def family_cost_upper_usd(
    family: CheckpointFamily,
    *,
    trials: int,
    conditions: int = len(CE_CONDITIONS),
    max_output_tokens: int = CE_MAX_OUTPUT_TOKENS,
    pricing: TokenPricing | None = None,
) -> float:
    """Upper-bound one family's screening spend before contacting a provider."""

    rates = pricing or pricing_for(CE_SCREENING_MODEL)
    per_pass = sum(
        rates.cost_usd(
            _stage_input_tokens_upper(
                len(checkpoint.public_spec),
                checkpoint.max_output_bytes,
            ),
            max_output_tokens,
        )
        for checkpoint in family.checkpoints
    )
    return per_pass * trials * conditions


def _capped_factory(
    admitted: AdmittedFamily,
    provider: HudGatewayProvider,
    *,
    expected_response_model: str,
    max_output_tokens: int,
    pricing: TokenPricing,
    spend_cap_usd: float,
):
    """Wrap the agent so a single stage cannot walk past the ceiling.

    The experiment loop meters per unit, which is too coarse here: one unit is a
    whole multi-stage family, so a runaway family would only be caught after it
    had already been paid for.
    """

    ledger = {"spent_usd": 0.0}

    def factory(
        family_id: SourceId, condition: Condition, trial: TrialIndex
    ) -> CheckpointAgent:
        agent = ProviderCheckpointAgent(
            provider,
            contract=admitted.family.contract,
            expected_response_model=expected_response_model,
            max_output_tokens=max_output_tokens,
            pricing=pricing,
        )

        def guarded(delivery: CheckpointDelivery) -> MeteredWorkspace:
            projected = stage_cost_upper_usd(
                delivery,
                max_output_tokens=max_output_tokens,
                pricing=pricing,
            )
            if ledger["spent_usd"] + projected > spend_cap_usd:
                raise BudgetError(
                    f"projected spend ${ledger['spent_usd'] + projected:.2f} "
                    f"would exceed the ${spend_cap_usd:.2f} cap; stage skipped"
                )
            try:
                produced = agent(delivery)
            except Exception as error:
                usage = getattr(error, "stage_usage", None)
                if isinstance(usage, StageUsage):
                    ledger["spent_usd"] += usage.estimated_cost_usd
                raise
            ledger["spent_usd"] += produced.usage.estimated_cost_usd
            return produced

        return guarded

    return factory


def dry_run_transport(fixture: SeedFamilyFixture) -> Transport:
    """Scripted HUD-gateway replies computed from the fixture references.

    Even stages come back inside an exact ```json fence — the wire shape Haiku
    produced during the SWE-bench screening — so the committed dry-run evidence
    exercises the fence unwrap.
    """

    def transport(
        endpoint: str,
        body: bytes,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> bytes:
        if endpoint != HUD_GATEWAY_ENDPOINT:
            raise RuntimeError("unexpected HUD endpoint")
        if not headers.get("Authorization", "").startswith("Bearer "):
            raise RuntimeError("HUD credential was not forwarded")
        payload = json.loads(body)
        user_content = payload["messages"][1]["content"]
        matches = [
            checkpoint
            for checkpoint in fixture.family.checkpoints
            if checkpoint.public_spec in user_content
        ]
        if len(matches) != 1:
            raise RuntimeError("stage request does not carry exactly one spec")
        checkpoint = matches[0]
        reference = fixture.references.stages[checkpoint.index - 1]
        reply = json.dumps(
            {"files": {file.path: file.content for file in reference.files}},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        if checkpoint.index % 2 == 0:
            reply = f"```json\n{reply}\n```"
        return json.dumps(
            {
                "id": f"dry-run-stage-{checkpoint.index}",
                "model": payload["model"],
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": reply},
                    }
                ],
                "usage": {
                    "prompt_tokens": len(user_content) // 4,
                    "completion_tokens": len(reply) // 4,
                    "total_tokens": (len(user_content) + len(reply)) // 4,
                },
            }
        ).encode()

    return transport


def run_ce_screening(
    *,
    mode: CeScreeningMode,
    seed_path: Path,
    output_path: Path,
    trials: int = CE_TRIALS,
    dry_run_execution: CeDryRunExecution = "trusted-fixture",
    approve_spend: bool = False,
    spend_cap_usd: float = SCREENING_SPEND_CAP_USD,
    transport: Transport | None = None,
    environment: Mapping[str, str] | None = None,
    sandbox_runner: SandboxRunner | None = None,
) -> tuple[Observation, ...]:
    fixture = load_seed_family(seed_path)
    admitted = AdmittedFamily(
        family=fixture.family,
        references=fixture.references,
        admission=admit_family(fixture.family, fixture.references),
    )
    variants = build_checkpoint_variants(fixture.family, fixture.references)
    live = mode == "live"
    sandbox = SandboxCaseExecution(
        PINNED_SANDBOX,
        **({} if sandbox_runner is None else {"runner": sandbox_runner}),
    )
    execute_case: CaseExecution
    if live or dry_run_execution == "sandbox":
        # Model-written code executes only in the pinned container sandbox;
        # there is deliberately no host-execution branch on the live path.
        execute_case = sandbox
    else:
        # Trusted-fixture path: the scripted transport only ever replies with
        # the hand-verified reference workspaces from the fixture.
        execute_case = run_case_trusted
    if live:
        pricing = pricing_for(CE_SCREENING_MODEL)
        provider = HudGatewayProvider(
            CE_SCREENING_MODEL,
            environment=environment,
            **({} if transport is None else {"transport": transport}),
        )
        build_agent = _capped_factory(
            admitted,
            provider,
            expected_response_model=CE_EXPECTED_RESPONSE_MODEL,
            max_output_tokens=CE_MAX_OUTPUT_TOKENS,
            pricing=pricing,
            spend_cap_usd=spend_cap_usd,
        )
        model, response_model = CE_SCREENING_MODEL, CE_EXPECTED_RESPONSE_MODEL
        upper = family_cost_upper_usd(fixture.family, trials=trials)
    else:
        pricing = FREE
        provider = HudGatewayProvider(
            CE_DRY_RUN_MODEL,
            transport=transport or dry_run_transport(fixture),
            environment={"HUD_API_KEY": "offline-dry-run-credential"},
        )

        def build_agent(
            family_id: SourceId, condition: Condition, trial: TrialIndex
        ) -> CheckpointAgent:
            return ProviderCheckpointAgent(
                provider,
                contract=admitted.family.contract,
                expected_response_model=CE_DRY_RUN_MODEL,
                max_output_tokens=CE_MAX_OUTPUT_TOKENS,
                pricing=pricing,
            )

        model = response_model = CE_DRY_RUN_MODEL
        upper = 0.0
    per_episode = upper / max(1, trials * len(CE_CONDITIONS))
    plan = plan_experiment(
        ((fixture.family, variants),),
        ExperimentConfig(
            model=model,
            expected_response_model=response_model,
            conditions=CE_CONDITIONS,
            trials=trials,
            cost=CostRange(
                lower_per_episode_usd=0.0,
                upper_per_episode_usd=per_episode,
            ),
            spend_cap_usd=spend_cap_usd,
            policy=f"checkpoint-screening-{mode}",
        ),
    )
    return execute(
        plan,
        checkpoint_executor(
            {fixture.family.family_id: admitted},
            {fixture.family.family_id: variants},
            build_agent,
            model=response_model,
            execute_case=execute_case,
        ),
        journal_path=output_path,
        approve_spend=approve_spend or not live,
        spend_cap_usd=spend_cap_usd,
    )
