"""Property tests for the discrete-event scheduler's total order (ADR-0003)."""

from hypothesis import given
from hypothesis import strategies as st

from windtunnel.clock import Activation, Scheduler
from windtunnel.ids import SeqCounter

items = st.lists(
    st.tuples(
        st.floats(min_value=0.0, max_value=1000.0, allow_nan=False),
        st.integers(min_value=-10, max_value=10),
    ),
    max_size=50,
)


@given(items=items)
def test_pop_order_is_total_and_deterministic(items: list[tuple[float, int]]) -> None:
    scheduler = Scheduler(SeqCounter())
    for index, (at_time, priority) in enumerate(items):
        scheduler.schedule(Activation(f"a{index}"), at_time, priority)

    popped: list[tuple[float, int, str]] = []
    while (entry := scheduler.pop()) is not None:
        time, item = entry
        assert isinstance(item, Activation)
        original_index = int(item.actor_id[1:])
        popped.append((time, items[original_index][1], item.actor_id))

    # Sorted by (time, priority); insertion order (seq) breaks remaining ties.
    keys = [(t, p) for t, p, _ in popped]
    assert keys == sorted(keys)
    same_key_groups: dict[tuple[float, int], list[str]] = {}
    for time, priority, actor in popped:
        same_key_groups.setdefault((time, priority), []).append(actor)
    for group in same_key_groups.values():
        indices = [int(a[1:]) for a in group]
        assert indices == sorted(indices)  # FIFO among exact ties


def test_cannot_schedule_into_the_past() -> None:
    scheduler = Scheduler(SeqCounter())
    scheduler.schedule(Activation("a"), 5.0)
    scheduler.pop()
    assert scheduler.now == 5.0
    try:
        scheduler.schedule(Activation("b"), 1.0)
    except ValueError:
        return
    raise AssertionError("expected ValueError")
