"""Property tests for named RNG streams (ADR-0003)."""

from hypothesis import given
from hypothesis import strategies as st

from windtunnel.rng import RngRegistry

names = st.text(min_size=1, max_size=30)


@given(seed=st.integers(min_value=0, max_value=2**32), name=names)
def test_same_seed_same_stream(seed: int, name: str) -> None:
    a = RngRegistry(seed).stream(name)
    b = RngRegistry(seed).stream(name)
    assert [a.random() for _ in range(5)] == [b.random() for _ in range(5)]


@given(seed=st.integers(min_value=0, max_value=2**32), name=names, other=names)
def test_stream_independence(seed: int, name: str, other: str) -> None:
    """Creating/consuming another stream never shifts an existing stream's draws."""
    solo = RngRegistry(seed)
    baseline = [solo.stream(name).random() for _ in range(5)]

    noisy = RngRegistry(seed)
    noisy.stream(other).random()  # interleaved foreign draw
    observed = []
    for _ in range(5):
        observed.append(noisy.stream(name).random())
        noisy.stream(other).random()
    assert baseline == observed or name == other


@given(seed=st.integers(min_value=0, max_value=2**32))
def test_distinct_names_distinct_sequences(seed: int) -> None:
    registry = RngRegistry(seed)
    a = [registry.stream("alpha").random() for _ in range(4)]
    b = [registry.stream("beta").random() for _ in range(4)]
    assert a != b
