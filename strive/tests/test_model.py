"""Model interface: deterministic fake, finish reasons, conservative token
bounds, OpenAI-compatible error classification, env-adapter configuration, and
budget semantics. (The pre-vNext MeteredJournalingAdapter was removed — the
kernel `_run_refinement` is the single metered/journaled model boundary.)"""

from __future__ import annotations

import urllib.error
from pathlib import Path

import pytest

from strive.budget import UNLIMITED, BudgetMeter
from strive.contracts import BudgetSpec, FINISH_LENGTH, FINISH_STOP, ModelRequest
from strive.model import (
    FakeModelAdapter,
    ModelConfigError,
    ModelNoCallError,
    ModelTransportError,
    OpenAICompatAdapter,
    adapter_from_env,
)


# -- the deterministic fake -----------------------------------------------------------------------


def test_fake_adapter_is_deterministic() -> None:
    adapter = FakeModelAdapter()
    request = ModelRequest(prompt="improve this strategy", seed=7)
    first = adapter.complete(request)
    assert first == adapter.complete(request)
    assert first.text.startswith("fake-completion:")
    assert first.finish_reason == FINISH_STOP
    assert adapter.complete(ModelRequest(prompt="improve this strategy", seed=8)).text != first.text


def test_fake_adapter_reports_length_finish_on_truncation() -> None:
    adapter = FakeModelAdapter(script={"p": "x" * 400})
    response = adapter.complete(ModelRequest(prompt="p", max_tokens=10))
    assert response.finish_reason == FINISH_LENGTH
    assert response.output_tokens == 10


def test_conservative_input_token_bound_over_estimates() -> None:
    # the reservation bound must be >= the fake's actual reported input tokens
    adapter = FakeModelAdapter()
    prompt = "some prompt text of a few dozen characters to estimate" * 3
    bound = adapter.estimate_input_tokens(prompt)
    actual = adapter.complete(ModelRequest(prompt=prompt)).input_tokens
    assert bound >= actual


# -- env-adapter configuration --------------------------------------------------------------------


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "STRIVE_MODEL_PROVIDER", "STRIVE_MODEL_BASE_URL",
        "STRIVE_MODEL_API_KEY", "STRIVE_MODEL_ID",
    ):
        monkeypatch.delenv(name, raising=False)


def test_no_env_means_no_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    assert adapter_from_env() is None


def test_unknown_provider_is_a_clean_config_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("STRIVE_MODEL_PROVIDER", "mystery-cloud")
    with pytest.raises(ModelConfigError, match="unknown STRIVE_MODEL_PROVIDER"):
        adapter_from_env()


def test_missing_variables_are_a_clean_config_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("STRIVE_MODEL_PROVIDER", "openai-compatible")
    monkeypatch.setenv("STRIVE_MODEL_BASE_URL", "http://localhost:9")
    with pytest.raises(
        ModelConfigError, match="missing: STRIVE_MODEL_API_KEY, STRIVE_MODEL_ID"
    ):
        adapter_from_env()


# -- OpenAI-compatible adapter: error classification (no network) ---------------------------------


def _openai() -> OpenAICompatAdapter:
    return OpenAICompatAdapter(
        base_url="http://localhost:1/v1", api_key="k", model_id="m",
    )


def _patch_urlopen(monkeypatch: pytest.MonkeyPatch, raiser) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr("strive.model.urllib.request.urlopen", raiser)


def test_openai_cost_is_unknown_not_zero() -> None:
    adapter = _openai()
    assert adapter.reports_cost is False
    assert adapter.estimate_cost(10, 10) is None  # UNKNOWN, never 0.0
    assert adapter.impl_version == "openai-compatible@1"


def test_openai_connection_refused_is_proven_no_call(monkeypatch: pytest.MonkeyPatch) -> None:
    def refused(*a: object, **k: object) -> object:
        raise urllib.error.URLError(ConnectionRefusedError("refused"))

    _patch_urlopen(monkeypatch, refused)
    with pytest.raises(ModelNoCallError):
        _openai().complete(ModelRequest(prompt="p"))


def test_openai_http_error_is_possible_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    def http_error(*a: object, **k: object) -> object:
        raise urllib.error.HTTPError("u", 503, "unavailable", {}, None)  # type: ignore[arg-type]

    _patch_urlopen(monkeypatch, http_error)
    with pytest.raises(ModelTransportError):
        _openai().complete(ModelRequest(prompt="p"))


def test_openai_timeout_is_possible_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(*a: object, **k: object) -> object:
        raise urllib.error.URLError(TimeoutError("timed out"))

    _patch_urlopen(monkeypatch, timeout)
    with pytest.raises(ModelTransportError):
        _openai().complete(ModelRequest(prompt="p"))


def test_openai_unparseable_response_is_transport_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Resp:
        def __enter__(self) -> "_Resp":
            return self

        def __exit__(self, *a: object) -> None:
            return None

        def read(self) -> bytes:
            return b"not json at all"

    _patch_urlopen(monkeypatch, lambda *a, **k: _Resp())
    with pytest.raises(ModelTransportError):
        _openai().complete(ModelRequest(prompt="p"))


# -- budget semantics -----------------------------------------------------------------------------


def test_budget_semantics_are_recorded_per_limit() -> None:
    semantics = BudgetMeter(BudgetSpec(tokens=100, cost=UNLIMITED, model_calls=2)).semantics()
    assert semantics["tokens"] == "enforced-between-calls+output-cap"
    assert semantics["cost"] == "accounting-only"
    assert semantics["model_calls"] == "enforced"
