"""Hidden state: observation policies must enforce partial observability (ADR-0005)."""

from orrery.entities import Entity, EntityStore
from orrery.events import Event
from orrery.observe import ObservationScope, render_view


def build_store() -> EntityStore:
    store = EntityStore()
    store.add(
        Entity(
            id="account-1",
            kind="account",
            attrs={"balance": 10.0, "fraud_flag": True},
            visible_to=["agent"],
            secret_attrs=["fraud_flag"],
        )
    )
    store.add(Entity(id="ticket-1", kind="ticket", attrs={"status": "open"}))
    return store


def test_secret_attr_hidden_from_uncleared_actor() -> None:
    view = render_view(
        build_store(), [], "customer", ObservationScope(entity_kinds=["account", "ticket"]), 0.0
    )
    account = next(e for e in view.entities if e.id == "account-1")
    assert "fraud_flag" not in account.attrs
    assert account.attrs["balance"] == 10.0


def test_secret_attr_visible_to_cleared_actor_and_omniscient() -> None:
    store = build_store()
    agent_view = render_view(store, [], "agent", ObservationScope(), 0.0)
    account = next(e for e in agent_view.entities if e.id == "account-1")
    assert account.attrs["fraud_flag"] is True

    judge_view = render_view(store, [], "judge", ObservationScope(omniscient=True), 0.0)
    account = next(e for e in judge_view.entities if e.id == "account-1")
    assert account.attrs["fraud_flag"] is True


def test_entity_kind_scoping() -> None:
    view = render_view(
        build_store(), [], "customer", ObservationScope(entity_kinds=["ticket"]), 0.0
    )
    assert [e.id for e in view.entities] == ["ticket-1"]


def test_direct_events_only_visible_to_participants() -> None:
    event = Event(
        id="ev-000001",
        seq=1,
        time=0.0,
        kind="message.sent",
        actor_id="agent",
        visibility="direct",
        payload={"from": "agent", "to": "customer", "content": []},
    )
    store = build_store()
    for actor, expected in [("customer", True), ("agent", True), ("bystander", False)]:
        view = render_view(store, [event], actor, ObservationScope(), 0.0)
        assert (len(view.events) == 1) is expected, actor
    judge = render_view(store, [event], "judge", ObservationScope(omniscient=True), 0.0)
    assert len(judge.events) == 1
