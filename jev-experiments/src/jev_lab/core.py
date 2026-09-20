"""Recorded, budgeted access to Vercel. No credentials enter saved records."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import re
import shlex
import sqlite3
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

ROOT = Path(__file__).resolve().parents[2]
JEV = "typesafe-ai/jev"
WRITER = "google/gemini-2.5-flash-lite"


def load_shell_key() -> None:
    """Read only the authorized literal assignment, without executing shell startup code."""
    if os.environ.get("AI_GATEWAY_API_KEY"):
        return
    path = Path.home() / ".zshrc"
    if path.exists():
        for line in path.read_text().splitlines():
            match = re.match(r"\s*(?:export\s+)?AI_GATEWAY_API_KEY\s*=\s*(.+)", line)
            if match and not any(c in match[1] for c in ("$", "`", ";")):
                parts = shlex.split(match[1], comments=True)
                if len(parts) == 1 and parts[0]:
                    os.environ["AI_GATEWAY_API_KEY"] = parts[0]


def now() -> str:
    return datetime.now(UTC).isoformat()


def digest(value: Any) -> str:
    # Preserve key order: changing candidate order is an experimental intervention.
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def save(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    tmp.replace(path)


class Question(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["choice", "score", "noul"]
    instructions: str = Field(min_length=1, max_length=30000)
    criteria: dict[str, str] | list[str] | None = None

    @model_validator(mode="after")
    def check_criteria(self):
        if self.type == "choice":
            if not isinstance(self.criteria, dict) or not 2 <= len(self.criteria) <= 255:
                raise ValueError("Choice requires 2..255 named options")
        elif self.type == "score":
            if not isinstance(self.criteria, list) or not 2 <= len(self.criteria) <= 255:
                raise ValueError("Score requires 2..255 ordered descriptions")
        elif self.criteria is not None:
            raise ValueError("This lab uses plain Noul instructions without criteria")
        return self


def choice(instructions: str, options: dict[str, str] | list[str]) -> dict:
    return Question(
        type="choice",
        instructions=instructions,
        criteria=options
        if isinstance(options, dict)
        else {v: v.replace("_", " ") for v in options},
    ).model_dump(exclude_none=True)


def noul(instructions: str) -> dict:
    return Question(type="noul", instructions=instructions).model_dump(exclude_none=True)


def score(instructions: str, levels: list[str]) -> dict:
    return Question(type="score", instructions=instructions, criteria=levels).model_dump(
        exclude_none=True
    )


class BudgetExceeded(RuntimeError):
    pass


class CapacityBusy(RuntimeError):
    pass


class Ledger:
    """Reserve each attempt transactionally, including attempts with unknown cost."""

    def __init__(self, path: Path | None = None, dollars: float = 25, calls: int = 10000):
        self.path = path or ROOT / "state.sqlite"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.dollars, self.calls = dollars, calls
        with self.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS spend "
                "(id INTEGER PRIMARY KEY, created TEXT, run TEXT, model TEXT, "
                "reserved REAL, cost REAL, status TEXT)"
            )

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def reserve(self, run: str, model: str, amount: float) -> int:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            # Share the four-call ceiling across CLI processes and the gallery server.
            pending = db.execute("SELECT COUNT(*) FROM spend WHERE status='pending'").fetchone()[0]
            if pending >= 4:
                raise CapacityBusy("Four calls are already in flight")
            # This gateway team explicitly reports five Gemini requests per minute.
            # Pace across processes rather than repeatedly probing a known limit.
            if model == "google/gemini-2.5-flash-lite":
                latest = db.execute(
                    "SELECT created FROM spend WHERE model=? ORDER BY id DESC LIMIT 1", (model,)
                ).fetchone()
                if (
                    latest
                    and (datetime.now(UTC) - datetime.fromisoformat(latest[0])).total_seconds() < 13
                ):
                    raise CapacityBusy("Waiting for the observed Gemini five-per-minute limit")
            count, used = db.execute(
                "SELECT COUNT(*), COALESCE(SUM(COALESCE(cost,reserved)),0) FROM spend"
            ).fetchone()
            if count >= self.calls or used + amount > self.dollars:
                raise BudgetExceeded(f"Budget reached: {count} attempts, ${used:.4f} accounted")
            cur = db.execute(
                "INSERT INTO spend VALUES (NULL,?,?,?,?,NULL,?)",
                (now(), run, model, amount, "pending"),
            )
            return cur.lastrowid

    def settle(self, ident: int, cost: float | None, status: str):
        with self.connect() as db:
            db.execute("UPDATE spend SET cost=?,status=? WHERE id=?", (cost, status, ident))

    def summary(self) -> dict:
        with self.connect() as db:
            rows = db.execute(
                "SELECT model,COUNT(*),SUM(COALESCE(cost,reserved)),"
                "SUM(cost),SUM(cost IS NULL) FROM spend GROUP BY model"
            ).fetchall()
        return {
            "limit_usd": self.dollars,
            "request_limit": self.calls,
            "attempts": sum(r[1] for r in rows),
            "accounted_usd": sum(r[2] for r in rows),
            "models": [
                {
                    "model": r[0],
                    "attempts": r[1],
                    "accounted_usd": r[2],
                    "reported_usd": r[3],
                    "unknown_cost_attempts": r[4],
                }
                for r in rows
            ],
        }


class Run:
    def __init__(self, name: str, config: dict | None = None, path: Path | None = None):
        self.id = f"{datetime.now(UTC):%Y%m%dT%H%M%S}-{name}-{uuid.uuid4().hex[:6]}"
        self.path = path or ROOT / "runs" / self.id
        self.path.mkdir(parents=True, exist_ok=True)
        self.manifest = {
            "id": self.id,
            "experiment": name,
            "created": now(),
            "config": config or {},
            "python": platform.python_version(),
            "platform": platform.platform(),
            "status": "running",
        }
        save(self.path / "manifest.json", self.manifest)

    def record(self, data: dict):
        with (self.path / "requests.jsonl").open("a") as f:
            f.write(json.dumps(data, ensure_ascii=False, allow_nan=False) + "\n")

    def finish(self, result: dict):
        save(self.path / "result.json", result)
        self.manifest.update(status=result.get("status", "complete"), finished=now())
        save(self.path / "manifest.json", self.manifest)

    def checkpoint(self, result: dict):
        save(self.path / "checkpoint.json", result)


def normalize(raw: dict, questions: dict) -> dict:
    if not isinstance(raw.get("answers"), dict):
        raise ValueError("Provider response has no answer map")
    answers = {}
    for key, q in questions.items():
        a = raw["answers"].get(key)
        if not isinstance(a, dict) or a.get("type") != q["type"]:
            raise ValueError(f"Missing or wrong answer type: {key}")
        value = a.get({"choice": "choice", "score": "score", "noul": "noul"}[q["type"]])
        if q["type"] == "choice" and value not in q["criteria"]:
            raise ValueError(f"Unknown option for {key}")
        if q["type"] in ("score", "noul"):
            upper = len(q["criteria"]) - 1 if q["type"] == "score" else 1
            if not isinstance(value, (float, int)) or not 0 <= value <= upper:
                raise ValueError(f"Out-of-range answer for {key}")
        probabilities = a.get("probabilities")
        if probabilities is not None:
            expected = (
                set(q["criteria"])
                if q["type"] == "choice"
                else {str(i) for i in range(len(q["criteria"]))}
            )
            if (
                set(probabilities) != expected
                or any(
                    not isinstance(p, (int, float)) or not 0 <= p <= 1
                    for p in probabilities.values()
                )
                or abs(sum(probabilities.values()) - 1) > 0.025
            ):
                raise ValueError(f"Malformed probability distribution: {key}")
        confidence = a.get("confidence")
        if confidence is not None and not 0 <= confidence <= 1:
            raise ValueError(f"Invalid confidence: {key}")
        answers[key] = {
            "type": q["type"],
            "value": value,
            "probabilities": probabilities,
            "confidence": confidence,
        }
    return answers


class Client:
    def __init__(self, run: Run, ledger: Ledger | None = None):
        self.run, self.ledger = run, ledger or Ledger()
        self.semaphore = asyncio.Semaphore(4)
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(60), follow_redirects=False)

    async def close(self):
        await self.http.aclose()

    async def request(self, endpoint: str, body: dict, tag: str) -> dict:
        key = os.environ.get("AI_GATEWAY_API_KEY")
        if not key:
            raise RuntimeError("AI_GATEWAY_API_KEY is missing; launch from the configured shell")
        wire = json.dumps(body, ensure_ascii=False).encode()
        if len(wire) > 110000:
            raise ValueError("Request exceeds the lab's conservative 110 KB packing limit")
        model = body["model"]
        estimate = (
            (len(wire) + 2000) * 0.042 / 1e6
            if model == JEV
            else (len(wire) + 2000) * 3 / 1e6 + body.get("max_tokens", 1024) * 15 / 1e6
        )
        reservation = max(0.002 if model == JEV else 0.03, estimate * 1.5)
        async with self.semaphore:
            for attempt in range(3):
                for wait in range(600):
                    try:
                        ident = self.ledger.reserve(self.run.id, model, reservation)
                        break
                    except CapacityBusy:
                        await asyncio.sleep(0.2)
                else:
                    raise RuntimeError(
                        "Timed out waiting for shared request capacity; inspect pending ledger entries"
                    )
                started = time.perf_counter()
                record = {
                    "at": now(),
                    "tag": tag,
                    "attempt": attempt + 1,
                    "request_hash": digest(body),
                    "request": body,
                    "ledger_id": ident,
                }
                status, cost, retry_delay = "error", None, None
                try:
                    response = await self.http.post(
                        "https://ai-gateway.vercel.sh" + endpoint,
                        json=body,
                        headers={"Authorization": f"Bearer {key}"},
                    )
                    record["http_status"] = response.status_code
                    if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                        try:
                            retry_delay = min(
                                60, max(0, float(response.headers.get("retry-after", 2**attempt)))
                            )
                        except ValueError:
                            retry_delay = 2**attempt
                    response.raise_for_status()
                    raw = response.json()
                    metadata = raw.get("provider_metadata", raw.get("providerMetadata", {}))
                    gateway = metadata.get("gateway", {})
                    cost_value = gateway.get("cost", gateway.get("gatewayCost"))
                    if cost_value is None:
                        cost_value = raw.get("usage", {}).get("cost")
                    if cost_value is not None:
                        cost = float(cost_value)
                        if not 0 <= cost < 1000:
                            cost = None
                    status = "ok"
                    record.update(
                        response=raw, cost_usd=cost, estimated_nonpromotional_usd=estimate
                    )
                    return {
                        "raw": raw,
                        "latency_ms": (time.perf_counter() - started) * 1000,
                        "cost_usd": cost,
                        "estimated_nonpromotional_usd": estimate,
                        "request_hash": record["request_hash"],
                    }
                except httpx.HTTPStatusError as exc:
                    record["error"] = (
                        f"HTTP {exc.response.status_code}: {exc.response.text[:500]}".replace(
                            key, "[redacted]"
                        )
                    )
                    if retry_delay is None:
                        raise RuntimeError(record["error"]) from None
                except (httpx.TransportError, ValueError) as exc:
                    record["error"] = str(exc).replace(key, "[redacted]")[:500]
                    if attempt == 2:
                        raise RuntimeError(record["error"]) from None
                    retry_delay = 2**attempt
                finally:
                    record.update(status=status, latency_ms=(time.perf_counter() - started) * 1000)
                    self.ledger.settle(ident, cost, status)
                    self.run.record(record)
                await asyncio.sleep(retry_delay)
        raise RuntimeError("Retry limit reached")

    async def evaluate(self, state: Any, questions: dict, tag: str = "evaluate") -> dict:
        started = time.perf_counter()
        if not questions or len(questions) > 512:
            raise ValueError("Supply 1..512 questions")
        questions = {
            k: Question.model_validate(v).model_dump(exclude_none=True)
            for k, v in questions.items()
        }
        result = await self.request(
            "/typesafe/v1/systemone", {"model": JEV, "state": state, "questions": questions}, tag
        )
        result["answers"] = normalize(result["raw"], questions)
        result["attempt_latency_ms"] = result["latency_ms"]
        result["latency_ms"] = (time.perf_counter() - started) * 1000
        result["model"] = result["raw"].get("model")
        return result

    async def generate(self, prompt: str, tag: str = "generate", max_tokens: int = 1024) -> dict:
        configuration = ROOT / ".cache" / "writer-model.json"
        writer = os.environ.get("JEV_WRITER_MODEL") or (
            json.loads(configuration.read_text())["model"] if configuration.exists() else WRITER
        )
        result = await self.request(
            "/v1/chat/completions",
            {
                "model": writer,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0.7,
            },
            tag,
        )
        result["text"] = result["raw"]["choices"][0]["message"]["content"]
        result["finish_reason"] = result["raw"]["choices"][0].get("finish_reason")
        result["model"] = writer
        return result


async def collect(items, fn):
    """Bound task creation, retain individual failures, and propagate cancellation."""
    results = []
    for start in range(0, len(items), 4):
        batch = await asyncio.gather(
            *(fn(x) for x in items[start : start + 4]), return_exceptions=True
        )
        for item, result in zip(items[start : start + 4], batch):
            if isinstance(result, BaseException):
                if isinstance(result, BudgetExceeded):
                    raise result
                context = (
                    {
                        k: item[k]
                        for k in ("id", "variant", "seed", "policy", "env", "target")
                        if k in item
                    }
                    if isinstance(item, dict)
                    else {"id": str(item)}
                )
                results.append({**context, "error": str(result)})
            else:
                results.append(result)
    return results
