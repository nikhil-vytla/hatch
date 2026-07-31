from __future__ import annotations

import argparse
import asyncio
from datetime import UTC, datetime
from pathlib import Path

from chat_env import env, intent_chat
from hud import Chat, LocalRuntime
from hud.agents import create_agent
from hud.telemetry.exporter import flush

from parallax.autoresearch import (
    CampaignManifest,
    IntentCondition,
    RunRecord,
    RunStatus,
    append_record,
    load_records,
    render_conversation,
    verify_response,
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _trace_id(trace: object) -> str:
    for name in ("id", "trace_id", "public_id"):
        value = getattr(trace, name, None)
        if value:
            return str(value)
    return ""


def _classify_exception(error: Exception) -> RunStatus:
    name = f"{type(error).__module__}.{type(error).__name__}".lower()
    provider_markers = ("anthropic", "openai", "http", "gateway", "provider", "timeout")
    if any(marker in name for marker in provider_markers):
        return RunStatus.PROVIDER_ERROR
    return RunStatus.HARNESS_ERROR


async def _run_one(
    manifest: CampaignManifest,
    condition: IntentCondition,
    task_index: int,
    repetition: int,
    *,
    intent_ledger: bool,
) -> RunRecord:
    task = manifest.tasks[task_index]
    variant = render_conversation(task, condition, intent_ledger=intent_ledger)
    started = _now()
    replies: list[str] = []
    trace_ids: list[str] = []
    try:
        agent = create_agent(manifest.model)
        chat = Chat(
            intent_chat(messages=[], expected=variant.expected),
            agent,
            runtime=LocalRuntime(env),
        )
        for turn in variant.turns:
            trace = await chat.send(turn)
            replies.append(str(trace.content or ""))
            trace_ids.append(_trace_id(trace))
        response = replies[-1] if replies else ""
        parsed, reward = verify_response(response, variant.expected)
        if parsed is None:
            status = RunStatus.INVALID_RESPONSE
        elif reward == 1.0:
            status = RunStatus.SUCCESS
        else:
            status = RunStatus.MODEL_FAILURE
        error = None
    except Exception as exc:
        response = replies[-1] if replies else ""
        parsed = None
        reward = None
        status = _classify_exception(exc)
        error = f"{type(exc).__name__}: {exc}"

    return RunRecord(
        campaign_id=manifest.campaign_id,
        campaign_digest=manifest.digest(),
        task_id=task.task_id,
        source_digest=task.digest(),
        conversation_digest=variant.digest(),
        condition=variant.condition,
        model=manifest.model,
        repetition=repetition,
        calls=len(variant.turns),
        expected=variant.expected,
        parsed_answer=parsed,
        reward=reward,
        status=status,
        final_response=response,
        replies=tuple(replies),
        trace_ids=tuple(trace_ids),
        started_at=started,
        finished_at=_now(),
        error=error,
        parent_condition=variant.parent_condition,
        intervention=variant.intervention,
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--conditions")
    parser.add_argument("--task-limit", type=int)
    parser.add_argument("--repetitions", type=int)
    parser.add_argument("--intent-ledger", action="store_true")
    args = parser.parse_args()

    manifest = CampaignManifest.load(args.campaign)
    conditions = (
        tuple(IntentCondition(item) for item in args.conditions.split(","))
        if args.conditions
        else manifest.conditions
    )
    tasks = manifest.tasks[: args.task_limit] if args.task_limit else manifest.tasks
    repetitions = args.repetitions or manifest.repetitions
    if args.intent_ledger and len(conditions) != 1:
        raise ValueError("--intent-ledger requires exactly one condition")

    existing = {
        record.key
        for record in load_records(args.out)
        if record.status
        not in {
            RunStatus.PROVIDER_ERROR,
            RunStatus.HARNESS_ERROR,
        }
    }
    total = 0
    for task_index, task in enumerate(tasks):
        for condition in conditions:
            for repetition in range(repetitions):
                condition_name = (
                    f"{condition}+intent-ledger" if args.intent_ledger else str(condition)
                )
                key = (manifest.campaign_id, task.task_id, condition_name, repetition)
                if key in existing:
                    continue
                record = await _run_one(
                    manifest,
                    condition,
                    task_index,
                    repetition,
                    intent_ledger=args.intent_ledger,
                )
                append_record(args.out, record)
                total += 1
                print(
                    f"{record.task_id} {record.condition} r{record.repetition}: "
                    f"{record.status} reward={record.reward}"
                )
    print(f"wrote {total} rollout record(s) to {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
    flush()
