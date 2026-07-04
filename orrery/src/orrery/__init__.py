"""Orrery: a deterministic simulation & environment-generation engine for
evaluating, training, and stress-testing autonomous AI agents.

Public API surface; see docs/architecture.md for the full picture.
"""

from orrery.actors import Actor, Decision, DecisionContext, Policy, ScheduledIntentDraft
from orrery.engine import ReplayDivergence, RunResult, replay, run
from orrery.entities import Entity, EntityStore
from orrery.events import Event, Intent
from orrery.models import ModelClient, ModelPolicy, ModelResponse, PlaybookClient, ToolCall
from orrery.observe import ObservationScope, WorldView
from orrery.plugins import Registry, build_registry
from orrery.rng import RngRegistry
from orrery.spec import ActorSpec, ContractItem, PolicySpec, ReactionRule, WorldSpec
from orrery.surfaces import Observation, Surface, TextSurface
from orrery.trace import Trace
from orrery.verify import (
    Verdict,
    Verifier,
    all_of,
    always,
    any_of,
    budget_max,
    eventually,
    match_event,
    never,
    no_secret_leak,
    not_,
    precedes,
    weighted,
)
from orrery.world import World

__all__ = [
    "Actor",
    "ActorSpec",
    "ContractItem",
    "Decision",
    "DecisionContext",
    "Entity",
    "EntityStore",
    "Event",
    "Intent",
    "ModelClient",
    "ModelPolicy",
    "ModelResponse",
    "Observation",
    "ObservationScope",
    "PlaybookClient",
    "Policy",
    "PolicySpec",
    "ReactionRule",
    "Registry",
    "ReplayDivergence",
    "RngRegistry",
    "RunResult",
    "ScheduledIntentDraft",
    "Surface",
    "TextSurface",
    "ToolCall",
    "Trace",
    "Verdict",
    "Verifier",
    "World",
    "WorldSpec",
    "WorldView",
    "all_of",
    "always",
    "any_of",
    "budget_max",
    "build_registry",
    "eventually",
    "match_event",
    "never",
    "no_secret_leak",
    "not_",
    "precedes",
    "replay",
    "run",
    "weighted",
]
