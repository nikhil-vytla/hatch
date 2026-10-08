from __future__ import annotations

import json
import math
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, TypeAlias

from .checkpoint_agent import (
    HAIKU_STAGE_PRICING,
    ProviderCheckpointAgent,
    StagePricing,
)
from .checkpoint_evolution import (
    BUDGET_HEADROOM_FACTOR,
    BudgetMatchingError,
    CaseExecution,
    CheckpointFamily,
    SeedFamilyFixture,
    admit_family,
    budget_headroom_violations,
    load_seed_family,
    run_case_trusted,
)
from .checkpoint_runner import (
    AdmittedFamily,
    CheckpointAgent,
    CheckpointArm,
    CheckpointDelivery,
    FamilyRun,
    MeteredWorkspace,
    StageUsage,
    run_ce_experiment,
)
from .checkpoint_sandbox import (
    PINNED_SANDBOX,
    SandboxCaseExecution,
    SandboxRunner,
)
from .outcome import BudgetError
from .provider import HUD_GATEWAY_ENDPOINT, HudGatewayProvider, Transport
from .screening import SCREENING_SPEND_CAP_USD, SpendApprovalRequired
from .types import SourceId, TrialSeed

CeScreeningMode: TypeAlias = Literal["dry-run", "live"]
CeDryRunExecution: TypeAlias = Literal["trusted-fixture", "sandbox"]

CE_SCREENING_MODEL = "claude-haiku-4-5"
CE_EXPECTED_RESPONSE_MODEL = "claude-haiku-4-5-20251001"
CE_DRY_RUN_MODEL = "ce-dry-run-model-not-contacted"
CE_MAX_OUTPUT_TOKENS = 2048
CE_TRIAL_SEEDS: tuple[int, ...] = tuple(range(101, 111))
# Conservative chars-per-token divisor and fixed protocol overhead for the
# pre-spend upper bound; both err toward overestimating cost.
_CHARS_PER_TOKEN = 3
_PROTOCOL_OVERHEAD_TOKENS = 1024

DRY_RUN_PRICING = StagePricing(
    input_usd_per_million=0.0,
    output_usd_per_million=0.0,
)


def _stage_input_tokens_upper(spec_chars: int, workspace_bytes: int) -> int:
    return (
        spec_chars + workspace_bytes
    ) // _CHARS_PER_TOKEN + _PROTOCOL_OVERHEAD_TOKENS


def ce_cost_upper_usd(
    family: CheckpointFamily,
    *,
    trial_seeds: tuple[int, ...],
    max_output_tokens: int = CE_MAX_OUTPUT_TOKENS,
    pricing: StagePricing = HAIKU_STAGE_PRICING,
) -> float:
    per_family = 0.0
    for checkpoint in family.checkpoints:
        input_tokens = _stage_input_tokens_upper(
            len(checkpoint.public_spec), checkpoint.max_output_bytes
        )
        per_family += (
            input_tokens * pricing.input_usd_per_million
            + max_output_tokens * pricing.output_usd_per_million
        ) / 1_000_000
    return per_family * len(trial_seeds) * 2  # two arms


def _delivery_call_upper_usd(
    delivery: CheckpointDelivery,
    *,
    max_output_tokens: int,
    pricing: StagePricing,
) -> float:
    input_tokens = _stage_input_tokens_upper(
        len(delivery.public_spec), delivery.workspace.content_bytes
    )
    return (
        input_tokens * pricing.input_usd_per_million
        + max_output_tokens * pricing.output_usd_per_million
    ) / 1_000_000


def _capped_factory(
    admitted: AdmittedFamily,
    provider: HudGatewayProvider,
    *,
    expected_response_model: str,
    max_output_tokens: int,
    pricing: StagePricing,
    spend_cap_usd: float,
):
    ledger = {"spent_usd": 0.0}

    def factory(
        family_id: SourceId, arm: CheckpointArm, seed: TrialSeed
    ) -> CheckpointAgent:
        agent = ProviderCheckpointAgent(
            provider,
            contract=admitted.family.contract,
            expected_response_model=expected_response_model,
            max_output_tokens=max_output_tokens,
            pricing=pricing,
        )

        def guarded(delivery: CheckpointDelivery) -> MeteredWorkspace:
            projected = _delivery_call_upper_usd(
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

    Even stages come back inside an exact ```json fence — the wire shape
    Haiku produced during the SWE-bench screening — so the committed
    dry-run evidence exercises the fence unwrap.
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
    trial_seeds: tuple[int, ...] = CE_TRIAL_SEEDS,
    dry_run_execution: CeDryRunExecution = "trusted-fixture",
    approve_spend: bool = False,
    spend_cap_usd: float = SCREENING_SPEND_CAP_USD,
    max_output_tokens: int = CE_MAX_OUTPUT_TOKENS,
    min_budget_headroom: float = BUDGET_HEADROOM_FACTOR,
    transport: Transport | None = None,
    environment: Mapping[str, str] | None = None,
    sandbox_runner: SandboxRunner | None = None,
) -> tuple[FamilyRun, ...]:
    fixture = load_seed_family(seed_path)
    admitted = AdmittedFamily(
        family=fixture.family,
        references=fixture.references,
        admission=admit_family(fixture.family, fixture.references),
    )
    execute: CaseExecution
    if mode == "live":
        # Model-written code executes only in the pinned container sandbox;
        # there is deliberately no host-execution branch on this path.
        execute = (
            SandboxCaseExecution(PINNED_SANDBOX)
            if sandbox_runner is None
            else SandboxCaseExecution(PINNED_SANDBOX, runner=sandbox_runner)
        )
        execution_identity = f"sandbox:{PINNED_SANDBOX.image}"
        # Refuse budget-confounded designs before any money is spent: with
        # full-file-map replies, arms whose caps fail the headroom rule are
        # nominally matched but effectively unmatched (the evolved arm's
        # guaranteed budget for new content is the cap increment).
        headroom = budget_headroom_violations(
            fixture.family, fixture.references, factor=min_budget_headroom
        )
        if headroom:
            raise BudgetMatchingError(
                "live screening refused, arms are not budget-matched: "
                + "; ".join(headroom)
            )
        if not math.isfinite(spend_cap_usd) or spend_cap_usd <= 0:
            raise ValueError("screening spend cap must be finite and positive")
        upper = ce_cost_upper_usd(
            fixture.family,
            trial_seeds=trial_seeds,
            max_output_tokens=max_output_tokens,
        )
        if upper > spend_cap_usd:
            raise SpendApprovalRequired(
                f"screening upper estimate ${upper:.2f} exceeds "
                f"${spend_cap_usd:.2f} cap"
            )
        if not approve_spend:
            raise SpendApprovalRequired(
                f"screening requires approval for up to ${upper:.2f}"
            )
        provider = (
            HudGatewayProvider(CE_SCREENING_MODEL, environment=environment)
            if transport is None
            else HudGatewayProvider(
                CE_SCREENING_MODEL, transport=transport, environment=environment
            )
        )
        agent_model = CE_SCREENING_MODEL
        expected_response_model = CE_EXPECTED_RESPONSE_MODEL
        pricing = HAIKU_STAGE_PRICING
        agent_factory = _capped_factory(
            admitted,
            provider,
            expected_response_model=expected_response_model,
            max_output_tokens=max_output_tokens,
            pricing=pricing,
            spend_cap_usd=spend_cap_usd,
        )
    else:
        if dry_run_execution == "sandbox":
            execute = (
                SandboxCaseExecution(PINNED_SANDBOX)
                if sandbox_runner is None
                else SandboxCaseExecution(PINNED_SANDBOX, runner=sandbox_runner)
            )
            execution_identity = f"sandbox:{PINNED_SANDBOX.image}"
        else:
            # Trusted-fixture path: the scripted transport only ever replies
            # with the hand-verified reference workspaces from the fixture.
            execute = run_case_trusted
            execution_identity = "trusted-fixture"
        provider = HudGatewayProvider(
            CE_DRY_RUN_MODEL,
            transport=transport
            if transport is not None
            else dry_run_transport(fixture),
            environment={"HUD_API_KEY": "offline-dry-run-credential"},
        )
        agent_model = CE_DRY_RUN_MODEL
        expected_response_model = CE_DRY_RUN_MODEL
        pricing = DRY_RUN_PRICING

        def agent_factory(
            family_id: SourceId, arm: CheckpointArm, seed: TrialSeed
        ) -> CheckpointAgent:
            return ProviderCheckpointAgent(
                provider,
                contract=admitted.family.contract,
                expected_response_model=expected_response_model,
                max_output_tokens=max_output_tokens,
                pricing=pricing,
            )

    model_config: dict[str, object] = {
        "mode": mode,
        "endpoint": HUD_GATEWAY_ENDPOINT,
        "expected_response_model": expected_response_model,
        "max_output_tokens": max_output_tokens,
        "pricing": pricing.model_dump(mode="json"),
        "execution": execution_identity,
        "spend_cap_usd": spend_cap_usd,
    }
    return run_ce_experiment(
        (admitted,),
        agent_factory,
        trial_seeds=trial_seeds,
        agent_model=agent_model,
        model_config=model_config,
        output_path=output_path,
        execute=execute,
    )
