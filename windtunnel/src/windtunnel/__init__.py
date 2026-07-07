"""Windtunnel: a deterministic simulation & environment-generation engine for
evaluating, training, and stress-testing autonomous AI agents.

Public API surface; see docs/architecture.md for the full picture.
"""

from windtunnel.actors import Actor, Decision, DecisionContext, Policy, ScheduledIntentDraft
from windtunnel.engine import ReplayDivergence, RunResult, replay, run
from windtunnel.entities import Entity, EntityStore
from windtunnel.events import Event, Intent
from windtunnel.models import ModelClient, ModelPolicy, ModelResponse, PlaybookClient, ToolCall
from windtunnel.observe import ObservationScope, WorldView
from windtunnel.plugins import Registry, build_registry
from windtunnel.rng import RngRegistry
from windtunnel.spec import ActorSpec, ContractItem, PolicySpec, ReactionRule, WorldSpec
from windtunnel.surfaces import Observation, Surface, TextSurface
from windtunnel.trace import Trace
from windtunnel.verify import (
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
from windtunnel.world import World

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
