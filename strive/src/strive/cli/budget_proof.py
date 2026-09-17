"""Proof assertions operate on verified authority records and gateway receipts."""
from pathlib import Path
import sqlite3
from typing import TYPE_CHECKING

from ..codec import decode
from ..contracts.annotations import Annotation
from ..contracts.commands import ExecuteEffect
from ..contracts.primitives import ArtifactRef, ExecutionStatus, Resource
from ..contracts.records import EffectAuthorization
from ..errors import VerificationError
from ..harness.openai_live import OpenAITransport
from ..harness.provider import json_object
from ..runtime.ledger import amounts
from .data import string, write_json

if TYPE_CHECKING:
    from .campaign import Campaign


def require(value: bool, reason: str) -> None:
    if not value:
        raise VerificationError("budget proof FAILED: " + reason)


def dispatches(directory: Path) -> int:
    total = 0
    for path in directory.glob("gateway/*/spool.sqlite"):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
            total += int(db.execute("SELECT count(*) FROM spool WHERE wire IS NOT NULL").fetchone()[0])
    return total


def prove(campaign: "Campaign", *, real: bool) -> dict[str, object]:
    state = campaign.reader.verify()
    require(state.execution_status is ExecutionStatus.SUSPENDED, "campaign did not suspend")
    stops = [(i, r.payload) for i, r in enumerate(state.records) if isinstance(r.payload, Annotation)
             and r.payload.namespace == "campaign.budget_stop"]
    require(bool(stops), "no reservation denial; workload completion is not a budget proof")
    position, stop = stops[0]
    command = decode(campaign.objects.read(ArtifactRef(string(json_object(stop.payload)["command"]))))
    require(isinstance(command, ExecuteEffect), "denied command not retained")
    assert isinstance(command, ExecuteEffect)
    require(not any(isinstance(r.payload, EffectAuthorization) for r in state.records[position + 1:]), "dispatch after stop")
    measured, outstanding = amounts(state.measured), amounts(state.obligations)
    cap = campaign.config.budget.usd.nanodollars
    spend = measured.get(Resource.USD_NANODOLLARS, 0)
    overrun = sum(amounts(e.overrun).get(Resource.USD_NANODOLLARS, 0) for e in state.effects)
    require(0 < spend <= cap + overrun, "no measured spend or unexplained overspend")
    require(overrun == 0, "provider overrun recorded; do not proceed with pilot")
    require(not outstanding.get(Resource.USD_NANODOLLARS, 0), "USD remains unknown")
    # Prove USD, rather than an incidental token/call/time limit, refused it.
    from ..runtime.broker import EffectRequest
    request = EffectRequest.read(campaign.objects.read(command.request))
    plan = campaign.adapters[command.binding].prepare(command, request)
    proposed = amounts(plan.reservation.components)
    require(spend + proposed[Resource.USD_NANODOLLARS] > cap, "stop was not caused by USD ceiling")
    try:
        campaign.broker.prepare(state, command)
    except VerificationError as error:
        require(str(error) == "reservation exceeds run budget", "broker failed for a non-budget reason")
    else:
        raise VerificationError("budget proof FAILED: M3 admitted denied command")
    receipts = []
    for name, gateway in campaign.gateways.items():
        rows = gateway._db.execute("SELECT wire,response FROM spool WHERE wire IS NOT NULL").fetchall()
        for wire, response in rows:
            require(response is not None, "dispatched call has no durable receipt")
            raw = campaign.objects.read(ArtifactRef(response))
            receipt = json_object(raw)
            usage = amounts(gateway.contract.usage(raw))
            require(receipt.get("model") == gateway.contract.model and isinstance(receipt.get("id"), str), "missing provider receipt identity")
            require(Resource.USD_NANODOLLARS in usage, "receipt cannot be priced")
            receipts.append({"role": name, "provider_id": receipt["id"], "wire": wire, "receipt": response,
                             "usd_nanodollars": usage[Resource.USD_NANODOLLARS]})
        if real:
            require(isinstance(gateway.upstream, OpenAITransport), "scripted provider cannot pass a live proof")
            assert isinstance(gateway.upstream, OpenAITransport)
            calls = gateway.upstream.db.execute("SELECT request,count,response FROM calls").fetchall()
            require(len(calls) == len(rows), "gateway/transport dispatch counts differ")
            for wire, counted, response in calls:
                require((wire, response) in rows, "transport receipt absent from gateway")
                count = json_object(campaign.objects.read(ArtifactRef(counted))).get("input_tokens")
                require(type(count) is int and count <= gateway.contract.input_ceiling, "input was not bounded before paid dispatch")
    require(len(receipts) == measured.get(Resource.MODEL_CALLS, 0), "receipt and ledger call counts differ")
    require(sum(int(str(r["usd_nanodollars"])) for r in receipts) == spend, "receipt costs do not reconcile to ledger")
    before = dispatches(campaign.directory)
    campaign.drive()
    campaign.issue(command, campaign.progress())
    campaign.drive()
    require(dispatches(campaign.directory) == before, "post-stop attempts dispatched")
    proof: dict[str, object] = {"status": "passed", "live": real, "cap_usd": cap / 1e9, "settled_usd": spend / 1e9,
        "overrun_usd": overrun / 1e9, "provider_receipts": receipts, "dispatches": before, "dispatches_after_stop": 0,
        "denied_reservation_usd": proposed[Resource.USD_NANODOLLARS] / 1e9,
        "assertions": ["M3 reserved before dispatch", "provider receipts reconcile exactly", "USD admission refused next generation",
                       "no unknown USD", "no overrun", "suspended mid-episode", "post-stop dispatch refused"]}
    write_json(campaign.directory / "budget-proof.json", proof, replace=True)
    return proof
