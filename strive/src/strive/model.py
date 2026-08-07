"""Provider-neutral model interface.

Rules (D3, D7, D11):
- every request/response crosses the kernel: journaled to the run's event
  stream with adapter name, model id, parameters, seed, usage, latency, and
  content-addressed prompt/completion artifacts;
- calls and token usage are charged to the trusted budget meter; exhaustion
  and adapter errors come back as ``FailureRecord`` data, never exceptions;
- the deterministic ``FakeModelAdapter`` ships in core so tests and default
  commands stay offline forever;
- a real adapter exists but is configured *only* through environment
  variables (``STRIVE_MODEL_PROVIDER=openai-compatible`` plus base URL / key /
  model id) and is never used by tests or defaults.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from typing import Callable, Protocol

from strive import codec
from strive.budget import BudgetMeter
from strive.cas import ObjectStore
from strive.contracts import (
    FAILURE_MODEL_ERROR,
    FailureRecord,
    ModelRequest,
    ModelResponse,
)
from strive.events import EventLog


class ModelAdapter(Protocol):
    """A provider-neutral completion interface."""

    adapter_name: str
    model_id: str

    def complete(self, request: ModelRequest) -> ModelResponse: ...


class CompletingAdapter(Protocol):
    """What proposers receive: a kernel-owned handle whose failures are data."""

    @property
    def model_id(self) -> str: ...

    def complete(self, request: ModelRequest) -> ModelResponse | FailureRecord: ...


class FakeModelAdapter:
    """Deterministic offline adapter.

    Resolution order: exact-match ``script`` entry, then ``responder``
    callable (for prompts with dynamic content), then a digest-based reply.
    A fake demonstrates *pipeline* correctness, not model capability: its
    responses are fixtures standing in for a real model.
    """

    adapter_name = "fake"
    model_id = "fake-deterministic-v1"

    def __init__(
        self,
        script: dict[str, str] | None = None,
        responder: Callable[[ModelRequest], str] | None = None,
    ) -> None:
        self._script = dict(script or {})
        self._responder = responder

    def complete(self, request: ModelRequest) -> ModelResponse:
        if request.prompt in self._script:
            text = self._script[request.prompt]
        elif self._responder is not None:
            text = self._responder(request)
        else:
            digest = hashlib.sha256(
                f"{request.prompt}|{request.seed}".encode("utf-8")
            ).hexdigest()
            text = f"fake-completion:{digest[:16]}"
        output_tokens = max(1, len(text) // 4)
        if output_tokens > request.max_tokens:  # honor the caller's output cap
            text = text[: request.max_tokens * 4]
            output_tokens = request.max_tokens
        return ModelResponse(
            text=text,
            model_id=self.model_id,
            input_tokens=max(1, len(request.prompt) // 4),
            output_tokens=output_tokens,
            cost=0.0,
        )


class OpenAICompatAdapter:
    """Minimal real adapter for OpenAI-compatible chat endpoints (stdlib only).

    Constructed exclusively via ``adapter_from_env``; nothing in tests or
    default commands instantiates it.
    """

    adapter_name = "openai-compatible"

    def __init__(self, base_url: str, api_key: str, model_id: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.model_id = model_id

    def complete(self, request: ModelRequest) -> ModelResponse:
        body = json.dumps(
            {
                "model": self.model_id,
                "messages": [{"role": "user", "content": request.prompt}],
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
                "seed": request.seed,
            }
        ).encode("utf-8")
        http_request = urllib.request.Request(
            f"{self._base_url}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
        )
        with urllib.request.urlopen(http_request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
        usage = payload.get("usage", {})
        return ModelResponse(
            text=payload["choices"][0]["message"]["content"],
            model_id=str(payload.get("model", self.model_id)),
            input_tokens=int(usage.get("prompt_tokens", 0)),
            output_tokens=int(usage.get("completion_tokens", 0)),
            cost=0.0,  # provider pricing is not modeled here
        )


def adapter_from_env() -> ModelAdapter | None:
    """Build a real adapter from environment variables, or None.

    ``STRIVE_MODEL_PROVIDER=openai-compatible`` with ``STRIVE_MODEL_BASE_URL``,
    ``STRIVE_MODEL_API_KEY``, and ``STRIVE_MODEL_ID``. This is the only path
    to a real model; no test or default command sets these.
    """
    provider = os.environ.get("STRIVE_MODEL_PROVIDER")
    if not provider:
        return None
    if provider == "openai-compatible":
        return OpenAICompatAdapter(
            base_url=os.environ["STRIVE_MODEL_BASE_URL"],
            api_key=os.environ["STRIVE_MODEL_API_KEY"],
            model_id=os.environ["STRIVE_MODEL_ID"],
        )
    raise KeyError(f"unknown STRIVE_MODEL_PROVIDER {provider!r}")


class MeteredJournalingAdapter:
    """Kernel-side wrapper: budget enforcement, error containment, and full
    I/O journaling with content-addressed prompt/completion artifacts."""

    def __init__(
        self,
        inner: ModelAdapter,
        meter: BudgetMeter,
        events: EventLog,
        objects: ObjectStore | None = None,
    ) -> None:
        self._inner = inner
        self._meter = meter
        self._events = events
        self._objects = objects

    @property
    def model_id(self) -> str:
        return self._inner.model_id

    def complete(self, request: ModelRequest) -> ModelResponse | FailureRecord:
        denial = self._meter.request_model_call()
        if denial is not None:
            self._events.emit("model_call_denied", failure=codec.encode(denial))
            return denial
        started = time.monotonic()
        try:
            response = self._inner.complete(request)
        except (urllib.error.URLError, OSError, KeyError, ValueError, TypeError) as exc:
            failure = FailureRecord(
                kind=FAILURE_MODEL_ERROR,
                detail=f"{type(exc).__name__}: {exc}",
            )
            self._events.emit(
                "model_call_failed",
                adapter=self._inner.adapter_name,
                model_id=self._inner.model_id,
                latency_ms=round((time.monotonic() - started) * 1000.0, 3),
                failure=codec.encode(failure),
            )
            return failure
        latency_ms = round((time.monotonic() - started) * 1000.0, 3)
        self._meter.note_model_usage(
            tokens=response.input_tokens + response.output_tokens,
            cost=response.cost,
        )
        prompt_ref = self._objects.put_text(request.prompt) if self._objects else None
        completion_ref = self._objects.put_text(response.text) if self._objects else None
        self._events.emit(
            "model_call",
            adapter=self._inner.adapter_name,
            model_id=response.model_id,
            latency_ms=latency_ms,
            prompt_ref=prompt_ref,
            completion_ref=completion_ref,
            request=codec.encode(request),
            response=codec.encode(response),
        )
        return response
