"""Frozen reference plan and stateful acceptance scenarios, without execution."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Final, Literal

from .feedback import FeedbackContract


class BenchmarkOperation(StrEnum):
    INITIALIZE_EPISODE = "initialize_episode"
    AGENT_TOOL = "agent_tool"
    USER_TOOL = "user_tool"
    DELIVER_MESSAGE = "deliver_message"
    TERMINATE = "terminate"
    SNAPSHOT = "snapshot"
    OPERATION_LOOKUP = "operation_lookup"


class EpisodeOutcome(StrEnum):
    NORMAL_TERMINATION = "normal_termination"
    TASK_FAILURE = "task_failure"
    BUDGET_EXHAUSTION = "budget_exhaustion"
    INFRASTRUCTURE_FAILURE = "infrastructure_failure"
    UNRESOLVED_EXECUTION = "unresolved_execution"


@dataclass(frozen=True, slots=True)
class SimulatorScenario:
    name: str
    operation: BenchmarkOperation
    given: str
    interruption_or_attack: str
    required_observation: str
    closing_milestone: str


SIMULATOR_SCENARIOS: Final = (
    SimulatorScenario("crash_after_agent_mutation", BenchmarkOperation.AGENT_TOOL,
                      "Known agent/device state and effect ID with argument digest",
                      "Crash after atomic mutation and receipt, before strive records return",
                      "Lookup returns original state and receipt; mutation occurs once", "Complete stateful operation"),
    SimulatorScenario("crash_after_user_mutation", BenchmarkOperation.USER_TOOL,
                      "Known user/device state and effect ID with argument digest",
                      "Crash after atomic mutation and receipt, before strive records return",
                      "Lookup returns original state and receipt; mutation occurs once", "Complete stateful operation"),
    SimulatorScenario("same_id_different_arguments", BenchmarkOperation.AGENT_TOOL,
                      "A committed operation with effect ID and argument digest",
                      "Repeat effect ID with different arguments",
                      "Reject without changing state or the original receipt", "Complete stateful operation"),
    SimulatorScenario("snapshot_both_sides", BenchmarkOperation.SNAPSHOT,
                      "Agent state, user state, conversation position, and environment randomness",
                      "Restore snapshot into isolated fork",
                      "All four state components match; parent is unchanged", "Complete stateful operation"),
    SimulatorScenario("scorer_uses_committed_state", BenchmarkOperation.TERMINATE,
                      "A task with retained deterministic reward_basis and trusted captured interactions",
                      "Candidate emits a forged success log",
                      "Reward equals upstream deterministic fixture; claim cannot alter coverage", "Complete stateful operation"),
    SimulatorScenario("episode_reset", BenchmarkOperation.INITIALIZE_EPISODE,
                      "Finished episode and active actor revision with authorized learned memory",
                      "Initialize next task from published initial state",
                      "Environment and conversation reset; actor artifacts persist", "Complete stateful operation"),
    SimulatorScenario("limit_preserves_coverage", BenchmarkOperation.TERMINATE,
                      "A planned and admitted task",
                      "Exhaust generation or transition limit",
                      "Record budget exhaustion while retaining the task in planned coverage", "Complete stateful operation"),
)


@dataclass(frozen=True, slots=True)
class ReferenceStudyPlan:
    workload: Literal["tau2-telecom-text"] = "tau2-telecom-text"
    upstream_repository: str = "https://github.com/sierra-research/tau2-bench"
    feedback_contract: FeedbackContract = FeedbackContract.A
    development_tasks: int = 60
    validation_tasks: int = 14
    audit_tasks: int = 40
    trajectory_pairs: int = 8
    arms: tuple[str, str] = ("fixed_initial_actor", "actor_adaptation")
    development_episodes_per_trajectory: int = 180
    development_passes: int = 3
    refinement_after_episodes: tuple[int, ...] = (20, 40, 60, 80, 100, 120, 140, 160)
    max_refiner_generations: int = 8
    forks_enabled: bool = False
    selection: str = "final_valid_active_actor_from_every_trajectory"
    audit_repetitions_per_task: int = 2
    pilot_episodes: int = 24
    pilot_refiner_generations: int = 4
    max_actor_generations_per_episode: int = 100
    max_user_generations_per_episode: int = 100
    max_benchmark_transitions_per_episode: int = 400
    max_input_tokens_per_episode: int = 512_000
    max_output_tokens_per_episode: int = 32_768
    actor_provider: str = "openai"
    actor_model: str = "gpt-5.6-luna"
    actor_harness: str = "opencode"
    refiner_provider: str = "openai"
    refiner_model: str = "gpt-5.6-luna"
    refiner_harness: str = "opencode"
    user_provider: str = "openai"
    user_model: str = "gpt-5.6-luna"
    user_harness: str | None = None
    primary_measure: str = "cumulative_benchmark_successes_over_180_episodes"
    independent_unit: str = "paired_trajectory"
    grouping_rule: str = "underlying_scenario_configuration_before_split"
    audit_isolation: tuple[str, ...] = (
        "lineage", "environment", "artifact_access", "retrieval_indexes", "caches",
        "provider_conversation_state", "accounting", "reporting_destination",
    )


REFERENCE_STUDY_PLAN: Final = ReferenceStudyPlan()
