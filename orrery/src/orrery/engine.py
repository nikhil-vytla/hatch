"""The simulation engine: activate → observe → decide → submit → reduce → trace.

One loop drives every run. Live runs call policies and record their
decisions; replays substitute the recorded decision stream and must produce a
bit-identical event log (ADR-0001). Everything else — timeline intents, chaos
windows, NPC behavior — derives from the spec and the seed.
"""

from __future__ import annotations

import importlib.metadata
from collections.abc import Callable
from dataclasses import dataclass

from orrery.actors import Actor, Decision, DecisionContext
from orrery.clock import Activation, Scheduler
from orrery.entities import EntityStore
from orrery.events import Event, Intent, ScheduledIntent
from orrery.ids import SeqCounter
from orrery.logging import get_logger
from orrery.observe import render_view
from orrery.plugins import Registry, build_registry
from orrery.rng import RngRegistry
from orrery.spec import WorldSpec
from orrery.surfaces import Observation
from orrery.trace import DecisionRecord, Trace, TraceMeta
from orrery.verify import Verdict, Verifier
from orrery.world import World

log = get_logger("orrery.engine")

# Called after each activation with (actor_id, activation_index, observation,
# decision). Fires identically in live and replay runs — the seam for dataset
# export (replay-reconstructed observations) and streaming verification.
DecisionObserver = Callable[[str, int, Observation, Decision], None]


def _version() -> str:
    try:
        return importlib.metadata.version("orrery")
    except importlib.metadata.PackageNotFoundError:
        return "0.0.0-dev"


@dataclass
class RunResult:
    trace: Trace
    store: EntityStore
    verdicts: list[Verdict]

    @property
    def passed(self) -> bool:
        return all(v.passed for v in self.verdicts)

    def verdict(self, name: str) -> Verdict:
        for v in self.verdicts:
            if v.name == name:
                return v
        raise KeyError(name)


def build_verifiers(spec: WorldSpec, registry: Registry) -> list[Verifier]:
    verifiers: list[Verifier] = []
    for item in spec.contract:
        factory = registry.verifiers.get(item.verifier)
        if factory is None:
            known = ", ".join(sorted(registry.verifiers))
            raise KeyError(f"no verifier factory {item.verifier!r}; known: {known}")
        verifiers.append(factory(item.name, item.params))
    return verifiers


def _build_actors(spec: WorldSpec, registry: Registry) -> dict[str, Actor]:
    actors: dict[str, Actor] = {}
    for actor_spec in spec.actors:
        factory = registry.policies.get(actor_spec.policy.type)
        if factory is None:
            known = ", ".join(sorted(registry.policies))
            raise KeyError(f"no policy {actor_spec.policy.type!r}; known: {known}")
        actors[actor_spec.id] = Actor(
            id=actor_spec.id,
            role=actor_spec.role,
            policy=factory(actor_spec.policy.params),
            scope=actor_spec.scope,
            priority=actor_spec.priority,
        )
    return actors


async def run(
    spec: WorldSpec,
    seed: int,
    registry: Registry | None = None,
    replay_from: Trace | None = None,
    observer: DecisionObserver | None = None,
) -> RunResult:
    registry = registry or build_registry(uses=spec.uses)
    seq = SeqCounter()
    rng = RngRegistry(seed)
    store = EntityStore()
    for entity in spec.entities:
        store.add(entity.model_copy(deep=True))
    world = World(
        store=store,
        rng=rng,
        seq=seq,
        mechanics=registry.mechanics,
        reducers=registry.reducers,
        tools=registry.tools,
    )
    scheduler = Scheduler(seq)
    actors = _build_actors(spec, registry)

    for actor_spec in spec.actors:
        for at_time in actor_spec.activate_at:
            scheduler.schedule(Activation(actor_spec.id, "initial"), at_time, actor_spec.priority)
    for entry in spec.timeline:
        scheduled = ScheduledIntent(
            at_time=entry.at,
            intent=Intent(kind=entry.intent, payload=entry.payload),
            actor_id=entry.as_actor,
        )
        scheduler.schedule(scheduled, entry.at)

    replay_decisions = replay_from.decision_map() if replay_from is not None else None
    decisions: list[DecisionRecord] = []
    activations = 0

    def react_to(events: list[Event], now: float) -> None:
        for event in events:
            for rule in spec.reactions:
                if rule.on_kind != event.kind:
                    continue
                if rule.only_if_addressed and event.payload.get("to") != rule.activate:
                    continue
                target = actors.get(rule.activate)
                if target is None:
                    continue
                scheduler.schedule(
                    Activation(rule.activate, reason=event.kind),
                    now + rule.delay,
                    rule.priority or target.priority,
                )

    while (popped := scheduler.pop()) is not None:
        now, item = popped
        if now > spec.horizon:
            log.info("horizon reached", extra={"time": now})
            break
        world.time = now

        if isinstance(item, ScheduledIntent):
            emitted = world.submit(item.actor_id, item.intent)
            react_to(emitted, now)
            continue

        actor = actors[item.actor_id]
        activations += 1
        if activations > spec.max_activations:
            log.warning("max_activations exceeded; terminating run")
            break

        visible = world.events[actor.event_cursor :]
        actor.event_cursor = len(world.events)
        view = render_view(store, visible, actor.id, actor.scope, now)
        observation = actor.surface.render(view)

        activation_index = actor.activation_count
        actor.activation_count += 1

        if replay_decisions is not None:
            decision = replay_decisions.get((actor.id, activation_index), Decision())
        else:
            context = DecisionContext(rng=rng.stream(f"actor:{actor.id}"), memory=actor.memory)
            decision = await actor.policy.decide(observation, context)

        decisions.append(
            DecisionRecord(
                actor_id=actor.id, activation=activation_index, time=now, decision=decision
            )
        )
        if observer is not None:
            observer(actor.id, activation_index, observation, decision)
        for draft in decision.scheduled:
            scheduled = ScheduledIntent(
                at_time=draft.at_time, intent=draft.intent, actor_id=actor.id
            )
            scheduler.schedule(scheduled, draft.at_time, actor.priority)
        emitted = []
        for intent in decision.intents:
            emitted.extend(world.submit(actor.id, intent))
        react_to(emitted, now)

    trace = Trace(
        meta=TraceMeta(
            spec_name=spec.name,
            spec_hash=spec.spec_hash(),
            seed=seed,
            orrery_version=_version(),
        ),
        events=world.events,
        decisions=decisions,
        final_state=store.snapshot(),
    )
    verdicts = [v.verify(trace, store) for v in build_verifiers(spec, registry)]
    log.info(
        "run complete",
        extra={
            "spec": spec.name,
            "seed": seed,
            "events": len(trace.events),
            "verdicts": {v.name: v.status for v in verdicts},
        },
    )
    return RunResult(trace=trace, store=store, verdicts=verdicts)


async def replay(
    spec: WorldSpec,
    trace: Trace,
    registry: Registry | None = None,
    observer: DecisionObserver | None = None,
) -> RunResult:
    """Re-derive the world from the recorded decision stream.

    Raises ReplayDivergence if the replayed event log does not fingerprint-
    match the original — the determinism contract of ADR-0001.
    """
    if trace.meta.spec_hash != spec.spec_hash():
        raise ReplayDivergence(
            f"spec hash mismatch: trace has {trace.meta.spec_hash[:12]}, "
            f"spec is {spec.spec_hash()[:12]}"
        )
    result = await run(
        spec, trace.meta.seed, registry=registry, replay_from=trace, observer=observer
    )
    original = trace.event_fingerprint
    replayed = result.trace.event_fingerprint
    if original != replayed:
        raise ReplayDivergence(f"event fingerprint mismatch: {original[:12]} != {replayed[:12]}")
    return result


class ReplayDivergence(AssertionError):
    """The replayed world did not reproduce the recorded one."""
