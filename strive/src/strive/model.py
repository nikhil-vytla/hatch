"""Provider-neutral model interface.

No evolution component uses a model yet (that is the next phase); the
interface exists now so budgets, journaling, and tests are already in place
when the model-backed proposer lands. Rules:

- every request/response crosses the kernel and is journaled to the run's
  event stream (replayability, D11);
- calls and token usage are charged to the trusted budget meter (D3, D7);
  an exhausted budget yields a recorded failure, not an exception;
- the deterministic ``FakeModelAdapter`` ships in core so the entire test
  suite stays offline forever.
"""

from __future__ import annotations

import hashlib
from typing import Protocol

from strive import codec
from strive.budget import BudgetMeter
from strive.contracts import FailureRecord, ModelRequest, ModelResponse
from strive.events import EventLog


class ModelAdapter(Protocol):
    """A provider-neutral completion interface."""

    model_id: str

    def complete(self, request: ModelRequest) -> ModelResponse: ...


class FakeModelAdapter:
    """Deterministic offline adapter.

    Responses come from an exact-match script; unscripted prompts get a
    deterministic digest-based reply so tests are stable without a network.
    """

    model_id = "fake-deterministic-v1"

    def __init__(self, script: dict[str, str] | None = None) -> None:
        self._script = dict(script or {})

    def complete(self, request: ModelRequest) -> ModelResponse:
        if request.prompt in self._script:
            text = self._script[request.prompt]
        else:
            digest = hashlib.sha256(
                f"{request.prompt}|{request.seed}".encode("utf-8")
            ).hexdigest()
            text = f"fake-completion:{digest[:16]}"
        return ModelResponse(
            text=text,
            model_id=self.model_id,
            input_tokens=max(1, len(request.prompt) // 4),
            output_tokens=max(1, len(text) // 4),
            cost=0.0,
        )


class MeteredJournalingAdapter:
    """Kernel-side wrapper: budget enforcement + full I/O journaling.

    Returns a FailureRecord instead of calling the model when the budget is
    exhausted (failure-as-data).
    """

    def __init__(self, inner: ModelAdapter, meter: BudgetMeter, events: EventLog) -> None:
        self._inner = inner
        self._meter = meter
        self._events = events

    @property
    def model_id(self) -> str:
        return self._inner.model_id

    def complete(self, request: ModelRequest) -> ModelResponse | FailureRecord:
        denial = self._meter.request_model_call()
        if denial is not None:
            self._events.emit("model_call_denied", failure=codec.encode(denial))
            return denial
        response = self._inner.complete(request)
        self._meter.note_model_usage(
            tokens=response.input_tokens + response.output_tokens,
            cost=response.cost,
        )
        self._events.emit(
            "model_call",
            request=codec.encode(request),
            response=codec.encode(response),
        )
        return response
