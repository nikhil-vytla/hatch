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

import hashlib
import json
import os
import socket
import urllib.error
import urllib.request
from typing import Callable, Protocol

from strive.contracts import (
    FINISH_ERROR,
    FINISH_LENGTH,
    FINISH_STOP,
    FINISH_UNKNOWN,
    ModelRequest,
    ModelResponse,
)

# a versioned identity for an adapter IMPLEMENTATION (bumped when its request/
# response wiring changes) — pinned in a refinement's intent alongside the
# resolved model + config so a changed adapter is detected on resume.
ADAPTER_IMPL_VERSIONS = {
    "fake": "fake@1",
    "openai-compatible": "openai-compatible@1",
}


class ModelConfigError(Exception):
    """Missing or invalid real-adapter configuration (clean CLI error)."""


class ModelTransportError(Exception):
    """A transport failure where a call MAY have been dispatched to the provider
    (so spend is UNKNOWN). The kernel marks the refinement `indeterminate` and
    retains the reservation, rather than assuming zero spend."""


class ModelNoCallError(Exception):
    """A failure PROVEN to have happened BEFORE any request left the process
    (e.g. a refused connection or DNS failure): no spend occurred, so the kernel
    may fail the refinement cleanly instead of marking it indeterminate."""


class ModelAdapter(Protocol):
    """A provider-neutral completion interface.

    ``reports_cost`` declares whether ``ModelResponse.cost`` is trustworthy;
    adapters that cannot model provider pricing must say so, and the kernel
    fails closed when a cost limit is configured against them.

    ``config_digest`` is a stable identity of the adapter's configuration
    (base URL / model / pricing) — bound into each refinement so a resume
    cannot silently switch models after issue. ``impl_version`` is the
    versioned identity of the adapter IMPLEMENTATION, also pinned in intent.

    ``estimate_input_tokens`` is a CONSERVATIVE (over-)bound on a prompt's input
    tokens for the pre-call reservation. ``estimate_cost`` upper-bounds a call's
    cost from its token caps; it returns None when the adapter cannot estimate
    (a finite cost budget against such an adapter then fails closed).

    A failed ``complete`` raises ``ModelNoCallError`` only when NO request left
    the process; any other failure (possible dispatch) raises
    ``ModelTransportError`` or a plain exception, which the kernel treats as
    indeterminate.
    """

    adapter_name: str
    model_id: str
    reports_cost: bool
    config_digest: str
    impl_version: str

    def complete(self, request: ModelRequest) -> ModelResponse: ...

    def estimate_input_tokens(self, prompt: str) -> int: ...

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> float | None: ...


class ModelCatalog:
    """An immutable, injected set of model adapters keyed by ROLE (e.g.
    ``"refine"``), resolved by exact name, fail-closed. The policy never sees
    an adapter — it only emits `RequestRefinement`; the kernel resolves the
    role's adapter here, so there are no provider branches in policy code."""

    def __init__(self, adapters: dict[str, ModelAdapter]) -> None:
        if not adapters:
            raise ModelConfigError("a model catalog must contain at least one adapter")
        self._by_role: dict[str, ModelAdapter] = dict(adapters)

    def roles(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_role))

    def resolve(self, role: str) -> ModelAdapter:
        adapter = self._by_role.get(role)
        if adapter is None:
            raise ModelConfigError(
                f"no model adapter for role {role!r}; known: {list(self.roles())} — "
                "refusing to substitute a different model"
            )
        return adapter


class FakeModelAdapter:
    """Deterministic offline adapter.

    Resolution order: exact-match ``script`` entry, then ``responder``
    callable (for prompts with dynamic content), then a digest-based reply.
    A fake demonstrates *pipeline* correctness, not model capability: its
    responses are fixtures standing in for a real model.
    """

    adapter_name = "fake"
    model_id = "fake-deterministic-v1"
    reports_cost = True  # its 0.0 is truthful: the fake costs nothing
    config_digest = "fake-config@1"
    impl_version = ADAPTER_IMPL_VERSIONS["fake"]
    # the fake genuinely varies its digest reply by seed (prompt|seed), so a
    # seeded trial is honestly seeded here
    seed_support = "deterministic-by-seed"

    def __init__(
        self,
        script: dict[str, str] | None = None,
        responder: Callable[[ModelRequest], str] | None = None,
    ) -> None:
        self._script = dict(script or {})
        self._responder = responder

    def estimate_input_tokens(self, prompt: str) -> int:
        return _conservative_input_tokens(prompt)

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> float | None:
        return 0.0  # the fake costs nothing, and reports so truthfully

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


def _conservative_input_tokens(prompt: str) -> int:
    """A CONSERVATIVE (over-)estimate of a prompt's input tokens for the pre-call
    reservation — ~1 token / 3 chars over-bounds the common ~1/4 ratio, plus a
    fixed envelope allowance, so the reservation never understates real usage."""
    return (len(prompt) + 2) // 3 + 8


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
    reports_cost = False  # provider pricing is not modeled; cost is unknown
    impl_version = ADAPTER_IMPL_VERSIONS["openai-compatible"]
    # the seed is SENT on every request, but whether the remote provider
    # honors it is provider-dependent and not verifiable from here
    seed_support = "sent-honored-unverified"

    def __init__(self, base_url: str, api_key: str, model_id: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.model_id = model_id
        # identity of the resolved endpoint+model (NOT the secret key), bound
        # into each refinement so a resume cannot silently switch models
        self.config_digest = hashlib.sha256(
            f"openai-compatible|{self._base_url}|{model_id}".encode("utf-8")
        ).hexdigest()[:16]

    def estimate_input_tokens(self, prompt: str) -> int:
        return _conservative_input_tokens(prompt)

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> float | None:
        return None  # provider pricing is not modeled; cost is UNKNOWN (never 0)

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
        try:
            with urllib.request.urlopen(http_request, timeout=request.timeout_s) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            # the server RESPONDED (with an error status) — a call was dispatched
            raise ModelTransportError(f"HTTP {exc.code} from provider") from exc
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (ConnectionRefusedError, socket.gaierror)):
                # refused/DNS failure: PROVEN no request left the process
                raise ModelNoCallError(f"connection not established: {reason}") from exc
            # timeout / reset / other transport error AFTER connect: possible dispatch
            raise ModelTransportError(f"transport error: {reason}") from exc
        try:
            payload = json.loads(raw)
            choice = payload["choices"][0]
            usage = payload.get("usage", {})
            return ModelResponse(
                text=choice["message"]["content"],
                model_id=str(payload.get("model", self.model_id)),
                input_tokens=int(usage.get("prompt_tokens", 0)),
                output_tokens=int(usage.get("completion_tokens", 0)),
                cost=0.0,  # provider pricing is not modeled here (cost unknown)
                finish_reason=_FINISH_NORMALIZATION.get(
                    str(choice.get("finish_reason", "unknown")), FINISH_UNKNOWN
                ),
            )
        except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError) as exc:
            # a response WAS received but is unparseable: the call happened, so
            # the outcome/spend is unknown — indeterminate, not a clean failure
            raise ModelTransportError(f"unparseable provider response: {exc}") from exc


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

# NOTE: the pre-vNext `MeteredJournalingAdapter` (an EventLog-journaling wrapper)
# was REMOVED — the vNext kernel `_run_refinement` is the single model boundary
# that meters, budgets, journals (as ModelDispatch/ModelResult), and contains
# errors. There is exactly one place model calls cross the trust boundary.
