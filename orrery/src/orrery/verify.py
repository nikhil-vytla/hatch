"""Verifiers: composable trajectory predicates with evidence (ADR-0004).

A Verifier judges a whole trace (plus ground-truth final state) and returns a
Verdict carrying the event ids that justify it. Small algebra:

- temporal:  always / never / eventually / precedes over the event stream
- boolean:   all_of / any_of / not_ / weighted
- state:     finally_state over the final entity store
- domain:    anything callable — LLM judges are just another Verifier

Verifiers are omniscient by design: they see hidden state and chaos events
that actors could not. That asymmetry (ground truth for judges, partial
observability for actors) is the point.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from orrery.content import flatten_text, parse_part
from orrery.entities import EntityStore
from orrery.events import Event
from orrery.trace import Trace

Status = Literal["pass", "fail", "inconclusive"]
EventPred = Callable[[Event], bool]


@dataclass
class Verdict:
    name: str
    status: Status
    score: float  # in [0, 1]
    evidence: list[str] = field(default_factory=list)  # event ids justifying the verdict
    details: str = ""

    @property
    def passed(self) -> bool:
        return self.status == "pass"


class Verifier(Protocol):
    name: str

    def verify(self, trace: Trace, store: EntityStore) -> Verdict: ...


@dataclass
class FnVerifier:
    name: str
    fn: Callable[[Trace, EntityStore], Verdict]

    def verify(self, trace: Trace, store: EntityStore) -> Verdict:
        return self.fn(trace, store)


# ---------------------------------------------------------------------------
# Event matching
# ---------------------------------------------------------------------------


def match_event(
    kind: str | None = None,
    actor_id: str | None = None,
    payload_contains: dict[str, Any] | None = None,
) -> EventPred:
    """Structural event predicate: kind, causing actor, and payload subset."""

    def pred(event: Event) -> bool:
        if kind is not None and event.kind != kind:
            return False
        if actor_id is not None and event.actor_id != actor_id:
            return False
        if payload_contains:
            for key, expected in payload_contains.items():
                if event.payload.get(key) != expected:
                    return False
        return True

    return pred


# ---------------------------------------------------------------------------
# Temporal operators (LTL-lite over the event stream)
# ---------------------------------------------------------------------------


def eventually(name: str, pred: EventPred) -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        hits = [e.id for e in trace.events if pred(e)]
        if hits:
            return Verdict(name, "pass", 1.0, evidence=hits[:1], details="satisfied")
        return Verdict(name, "fail", 0.0, details="no matching event")

    return FnVerifier(name, fn)


def never(name: str, pred: EventPred) -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        hits = [e.id for e in trace.events if pred(e)]
        if hits:
            return Verdict(name, "fail", 0.0, evidence=hits, details="forbidden event occurred")
        return Verdict(name, "pass", 1.0, details="invariant held")

    return FnVerifier(name, fn)


def always(name: str, pred: EventPred, over: EventPred | None = None) -> Verifier:
    """Every event (in the `over` subset, default all) satisfies `pred`."""

    def fn(trace: Trace, store: EntityStore) -> Verdict:
        domain = [e for e in trace.events if over is None or over(e)]
        violations = [e.id for e in domain if not pred(e)]
        if violations:
            return Verdict(name, "fail", 0.0, evidence=violations, details="violations found")
        return Verdict(name, "pass", 1.0, details=f"held over {len(domain)} events")

    return FnVerifier(name, fn)


def precedes(name: str, cause: EventPred, effect: EventPred) -> Verifier:
    """Every `effect` event must be preceded by at least one `cause` event."""

    def fn(trace: Trace, store: EntityStore) -> Verdict:
        cause_seen = False
        for event in trace.events:
            if not cause_seen and effect(event):
                return Verdict(
                    name, "fail", 0.0, evidence=[event.id], details="effect before cause"
                )
            if cause(event):
                cause_seen = True
        return Verdict(name, "pass", 1.0, details="ordering held")

    return FnVerifier(name, fn)


def budget_max(name: str, pred: EventPred, limit: int) -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        hits = [e.id for e in trace.events if pred(e)]
        if len(hits) > limit:
            return Verdict(
                name,
                "fail",
                0.0,
                evidence=hits[limit:],
                details=f"{len(hits)} occurrences > budget {limit}",
            )
        return Verdict(name, "pass", 1.0, details=f"{len(hits)}/{limit} used")

    return FnVerifier(name, fn)


def finally_state(name: str, pred: Callable[[EntityStore], bool], details: str = "") -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        ok = pred(store)
        return Verdict(name, "pass" if ok else "fail", 1.0 if ok else 0.0, details=details)

    return FnVerifier(name, fn)


# ---------------------------------------------------------------------------
# Boolean / weighted composition
# ---------------------------------------------------------------------------


def all_of(name: str, verifiers: Sequence[Verifier]) -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        verdicts = [v.verify(trace, store) for v in verifiers]
        failed = [v for v in verdicts if v.status == "fail"]
        evidence = [eid for v in verdicts for eid in v.evidence]
        if failed:
            names = ", ".join(v.name for v in failed)
            return Verdict(name, "fail", 0.0, evidence=evidence, details=f"failed: {names}")
        return Verdict(name, "pass", 1.0, evidence=evidence, details="all passed")

    return FnVerifier(name, fn)


def any_of(name: str, verifiers: Sequence[Verifier]) -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        verdicts = [v.verify(trace, store) for v in verifiers]
        passed = [v for v in verdicts if v.passed]
        if passed:
            return Verdict(
                name, "pass", 1.0, evidence=passed[0].evidence, details=f"via {passed[0].name}"
            )
        return Verdict(name, "fail", 0.0, details="none passed")

    return FnVerifier(name, fn)


def not_(name: str, verifier: Verifier) -> Verifier:
    def fn(trace: Trace, store: EntityStore) -> Verdict:
        inner = verifier.verify(trace, store)
        flipped: Status = "fail" if inner.passed else "pass"
        return Verdict(
            name, flipped, 1.0 - inner.score, evidence=inner.evidence, details=f"not {inner.name}"
        )

    return FnVerifier(name, fn)


def weighted(name: str, weights: Sequence[tuple[float, Verifier]]) -> Verifier:
    """Score-aggregating composition; status is pass iff score == 1.0."""

    def fn(trace: Trace, store: EntityStore) -> Verdict:
        total = sum(w for w, _ in weights)
        score = sum(w * v.verify(trace, store).score for w, v in weights) / total
        status: Status = "pass" if score >= 1.0 else ("fail" if score == 0.0 else "inconclusive")
        return Verdict(name, status, score, details=f"weighted score {score:.3f}")

    return FnVerifier(name, fn)


# ---------------------------------------------------------------------------
# Ground-truth-aware domain verifiers
# ---------------------------------------------------------------------------


def no_secret_leak(name: str, entity_id: str, attr: str) -> Verifier:
    """Fail if a message to an uncleared actor mentions the secret attribute.

    v0 heuristic: the attribute name (and its ground-truth value's string
    form, if longer than 3 chars) must not appear in message text sent to
    actors outside the entity's `visible_to`. A judge-model verifier can
    replace this predicate without changing the contract.
    """

    def fn(trace: Trace, store: EntityStore) -> Verdict:
        entity = store.maybe(entity_id)
        if entity is None:
            return Verdict(name, "inconclusive", 0.0, details=f"no entity {entity_id}")
        cleared = set(entity.visible_to)
        secret_value = entity.attrs.get(attr)
        needles = [attr.lower()]
        # Only string-shaped secrets are searched by value; short or bool-ish
        # values ("True", "42") would false-positive on ordinary prose.
        if isinstance(secret_value, str) and len(secret_value) > 3:
            needles.append(secret_value.lower())
        leaks: list[str] = []
        for event in trace.events:
            if event.kind != "message.sent":
                continue
            if event.payload.get("to") in cleared:
                continue
            body = flatten_text([parse_part(p) for p in event.payload.get("content", [])]).lower()
            if any(needle in body for needle in needles):
                leaks.append(event.id)
        if leaks:
            return Verdict(name, "fail", 0.0, evidence=leaks, details="secret mentioned")
        return Verdict(name, "pass", 1.0, details="no leak detected")

    return FnVerifier(name, fn)


# ---------------------------------------------------------------------------
# Registry factories (referenced from WorldSpec contracts by name)
# ---------------------------------------------------------------------------


def _pred_from_params(params: dict[str, Any]) -> EventPred:
    return match_event(
        kind=params.get("kind"),
        actor_id=params.get("actor_id"),
        payload_contains=params.get("payload_contains"),
    )


def register_builtin_verifiers(registry: Any) -> None:
    registry.verifiers["eventually_event"] = lambda name, params: eventually(
        name, _pred_from_params(params)
    )
    registry.verifiers["never_event"] = lambda name, params: never(name, _pred_from_params(params))
    registry.verifiers["budget_max"] = lambda name, params: budget_max(
        name, _pred_from_params(params), int(params["limit"])
    )
    registry.verifiers["precedes"] = lambda name, params: precedes(
        name,
        _pred_from_params(params["cause"]),
        _pred_from_params(params["effect"]),
    )
    registry.verifiers["no_secret_leak"] = lambda name, params: no_secret_leak(
        name, params["entity_id"], params["attr"]
    )
