"""Provider-neutral model interface.

Rules (D3, D7, D11):
- every request/response crosses the kernel and is journaled with adapter
  name, model id, parameters, seed, normalized finish reason, usage, latency,
  and content-addressed prompt/completion artifacts (compact metadata + CAS
  refs — full contents are stored once in the object store, not duplicated
  into every event);
- calls, token usage, and cost are charged to the trusted budget meter, and
  the HTTP timeout of a real call is capped by the cycle's remaining wall
  time; exhaustion and adapter errors come back as ``FailureRecord`` data;
- the deterministic ``FakeModelAdapter`` ships in core so tests and default
  commands stay offline forever;
- a real adapter is configured *only* through environment variables and
  misconfiguration is a clean, typed error (``ModelConfigError``).
"""

from __future__ import annotations

import dataclasses
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
    FINISH_ERROR,
    FINISH_LENGTH,
    FINISH_STOP,
    FINISH_UNKNOWN,
    FailureRecord,
    ModelRequest,
    ModelResponse,
)
from strive.events import EventLog


class ModelConfigError(Exception):
    """Missing or invalid real-adapter configuration (clean CLI error)."""


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
        finish_reason = FINISH_STOP
        output_tokens = max(1, len(text) // 4)
        if output_tokens > request.max_tokens:  # honor the caller's output cap
            text = text[: request.max_tokens * 4]
            output_tokens = request.max_tokens
            finish_reason = FINISH_LENGTH
        return ModelResponse(
            text=text,
            model_id=self.model_id,
            input_tokens=max(1, len(request.prompt) // 4),
            output_tokens=output_tokens,
            cost=0.0,
            finish_reason=finish_reason,
        )


_FINISH_NORMALIZATION = {
    "stop": FINISH_STOP,
    "end_turn": FINISH_STOP,
    "length": FINISH_LENGTH,
    "max_tokens": FINISH_LENGTH,
    "content_filter": FINISH_ERROR,
}


class OpenAICompatAdapter:
    """Minimal real adapter for OpenAI-compatible chat endpoints (stdlib only).

    Constructed exclusively via ``adapter_from_env``; nothing in tests or
    default commands instantiates it. The request's ``timeout_s`` (already
    capped by the trusted meter to the cycle's remaining wall time) bounds
    the HTTP call.
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
        with urllib.request.urlopen(http_request, timeout=request.timeout_s) as response:
            payload = json.loads(response.read().decode("utf-8"))
        usage = payload.get("usage", {})
        raw_finish = str(payload["choices"][0].get("finish_reason", "unknown"))
        return ModelResponse(
            text=payload["choices"][0]["message"]["content"],
            model_id=str(payload.get("model", self.model_id)),
            input_tokens=int(usage.get("prompt_tokens", 0)),
            output_tokens=int(usage.get("completion_tokens", 0)),
            cost=0.0,  # provider pricing is not modeled here
            finish_reason=_FINISH_NORMALIZATION.get(raw_finish, FINISH_UNKNOWN),
        )


_ENV_PROVIDER = "STRIVE_MODEL_PROVIDER"
_ENV_REQUIRED = ("STRIVE_MODEL_BASE_URL", "STRIVE_MODEL_API_KEY", "STRIVE_MODEL_ID")


def adapter_from_env() -> ModelAdapter | None:
    """Build a real adapter from environment variables, or None when unset.

    Misconfiguration (unknown provider, missing variables) raises
    ``ModelConfigError`` with a precise message instead of a KeyError.
    """
    provider = os.environ.get(_ENV_PROVIDER)
    if not provider:
        return None
    if provider != "openai-compatible":
        raise ModelConfigError(
            f"unknown {_ENV_PROVIDER} {provider!r}; supported: openai-compatible"
        )
    missing = [name for name in _ENV_REQUIRED if not os.environ.get(name)]
    if missing:
        raise ModelConfigError(
            f"{_ENV_PROVIDER}={provider} requires {', '.join(_ENV_REQUIRED)}; "
            f"missing: {', '.join(missing)}"
        )
    return OpenAICompatAdapter(
        base_url=os.environ["STRIVE_MODEL_BASE_URL"],
        api_key=os.environ["STRIVE_MODEL_API_KEY"],
        model_id=os.environ["STRIVE_MODEL_ID"],
    )


class MeteredJournalingAdapter:
    """Kernel-side wrapper: budget enforcement, wall-capped timeouts, error
    containment, and compact journaling with content-addressed artifacts."""

    def __init__(
        self,
        inner: ModelAdapter,
        meter: BudgetMeter,
        events: EventLog,
        objects: ObjectStore,
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
        request = dataclasses.replace(
            request, timeout_s=self._meter.model_call_timeout_s(request.timeout_s)
        )
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
        # compact metadata + CAS refs; contents live once in the object store
        self._events.emit(
            "model_call",
            adapter=self._inner.adapter_name,
            model_id=response.model_id,
            latency_ms=latency_ms,
            prompt_ref=self._objects.put_text(request.prompt),
            completion_ref=self._objects.put_text(response.text),
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            seed=request.seed,
            timeout_s=request.timeout_s,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            cost=response.cost,
            finish_reason=response.finish_reason,
        )
        return response
