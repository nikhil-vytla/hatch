"""Verifier algebra: temporal operators and composition laws (ADR-0004)."""

from hypothesis import given
from hypothesis import strategies as st

from orrery.entities import EntityStore
from orrery.events import Event
from orrery.trace import Trace, TraceMeta
from orrery.verify import (
    FnVerifier,
    Verdict,
    all_of,
    any_of,
    budget_max,
    eventually,
    match_event,
    never,
    not_,
    precedes,
    weighted,
)


def make_trace(kinds: list[str]) -> Trace:
    events = [
        Event(id=f"ev-{i:06d}", seq=i, time=float(i), kind=kind, payload={})
        for i, kind in enumerate(kinds)
    ]
    meta = TraceMeta(spec_name="t", spec_hash="h", seed=0, orrery_version="test")
    return Trace(meta=meta, events=events)


STORE = EntityStore()
kind_lists = st.lists(st.sampled_from(["a", "b", "c"]), max_size=20)


@given(kinds=kind_lists)
def test_eventually_iff_present(kinds: list[str]) -> None:
    verdict = eventually("e", match_event(kind="a")).verify(make_trace(kinds), STORE)
    assert verdict.passed == ("a" in kinds)
    if verdict.passed:
        assert verdict.evidence  # evidence always cites the witnessing event


@given(kinds=kind_lists)
def test_never_is_not_eventually(kinds: list[str]) -> None:
    trace = make_trace(kinds)
    assert (
        never("n", match_event(kind="a")).verify(trace, STORE).passed
        != eventually("e", match_event(kind="a")).verify(trace, STORE).passed
        or "a" not in kinds
    )
    # not_(eventually(x)) ≡ never(x)
    assert (
        not_("ne", eventually("e", match_event(kind="a"))).verify(trace, STORE).passed
        == never("n", match_event(kind="a")).verify(trace, STORE).passed
    )


@given(kinds=kind_lists)
def test_precedes_semantics(kinds: list[str]) -> None:
    verdict = precedes("p", match_event(kind="a"), match_event(kind="b")).verify(
        make_trace(kinds), STORE
    )
    first_b = kinds.index("b") if "b" in kinds else None
    expected = first_b is None or "a" in kinds[:first_b]
    assert verdict.passed == expected


@given(kinds=kind_lists, limit=st.integers(min_value=0, max_value=10))
def test_budget_max(kinds: list[str], limit: int) -> None:
    verdict = budget_max("b", match_event(kind="a"), limit).verify(make_trace(kinds), STORE)
    assert verdict.passed == (kinds.count("a") <= limit)


def const(name: str, passed: bool) -> FnVerifier:
    status = "pass" if passed else "fail"
    return FnVerifier(name, lambda t, s: Verdict(name, status, 1.0 if passed else 0.0))


@given(flags=st.lists(st.booleans(), min_size=1, max_size=6))
def test_boolean_composition_laws(flags: list[bool]) -> None:
    trace = make_trace([])
    verifiers = [const(f"v{i}", flag) for i, flag in enumerate(flags)]
    assert all_of("all", verifiers).verify(trace, STORE).passed == all(flags)
    assert any_of("any", verifiers).verify(trace, STORE).passed == any(flags)


@given(flags=st.lists(st.booleans(), min_size=1, max_size=6))
def test_weighted_score_bounds_and_mean(flags: list[bool]) -> None:
    trace = make_trace([])
    pairs: list[tuple[float, FnVerifier]] = [
        (1.0, const(f"v{i}", flag)) for i, flag in enumerate(flags)
    ]
    verdict = weighted("w", pairs).verify(trace, STORE)
    assert 0.0 <= verdict.score <= 1.0
    assert abs(verdict.score - sum(flags) / len(flags)) < 1e-9
