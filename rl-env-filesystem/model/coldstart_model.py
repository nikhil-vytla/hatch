"""Back-of-envelope model for RL rollout cold start and re-grading economics.

All numbers are tunable assumptions, not measurements. The point is to see
which architecture changes matter at which order of magnitude, and to make
the "re-grade from checkpoints vs re-run rollouts" comparison concrete.
Replace the assumptions with a customer's measured phase timings when
available.

Run: python3 coldstart_model.py
"""

from dataclasses import dataclass


@dataclass
class Assumptions:
    # Cold start phases (seconds): boot instance -> pull image -> env setup
    # -> agent works.
    instance_boot_s: float = 90.0     # cloud VM request to reachable
    image_size_gb: float = 6.0        # env image (browser/desktop images run larger)
    pull_throughput_gbps: float = 0.15  # GB/s effective eager pull incl. decompress
    env_setup_s: float = 60.0         # seed DB, start services, warm caches
    agent_loop_s: float = 600.0       # 10 min of agent turns (dominates, varies wildly)
    grading_s: float = 30.0

    # Interventions
    lazy_start_s: float = 3.0         # index fetch + container start
    lazy_runtime_tax_s: float = 10.0  # on-demand fetches during the run (amortized)
    warm_pool_alloc_s: float = 2.0    # scheduler places rollout on a pre-booted instance
    checkpoint_restore_s: float = 5.0 # restore post-setup checkpoint, lazy page-in

    # Cost side
    instance_usd_per_hour: float = 0.20   # mid-size general-purpose VM
    storage_put_per_1k: float = 0.005     # object storage write requests
    storage_usd_gb_month: float = 0.023   # object storage at standard tier
    rollout_diff_gb: float = 0.5          # dirty blocks written by the agent


def scenario_table(a: Assumptions) -> str:
    pull_s = a.image_size_gb / a.pull_throughput_gbps

    scenarios = {
        "baseline (today)": a.instance_boot_s + pull_s + a.env_setup_s,
        "+ warm instance pool": a.warm_pool_alloc_s + pull_s + a.env_setup_s,
        "+ lazy image delivery": a.warm_pool_alloc_s + a.lazy_start_s
        + a.lazy_runtime_tax_s + a.env_setup_s,
        "+ post-setup checkpoint restore": a.warm_pool_alloc_s
        + a.checkpoint_restore_s + a.lazy_runtime_tax_s,
    }

    rows = ["| architecture | pre-agent latency | wasted $/rollout | overhead vs 10-min agent loop |",
            "| --- | --- | --- | --- |"]
    for name, overhead_s in scenarios.items():
        cost = overhead_s / 3600 * a.instance_usd_per_hour
        pct = overhead_s / a.agent_loop_s * 100
        rows.append(f"| {name} | {overhead_s:.0f}s | ${cost:.4f} | {pct:.0f}% |")
    return "\n".join(rows)


def regrade_table(a: Assumptions, n_rollouts: int = 10_000) -> str:
    """Compare re-running rollouts against re-grading stored checkpoints."""
    pull_s = a.image_size_gb / a.pull_throughput_gbps
    rerun_s = a.instance_boot_s + pull_s + a.env_setup_s + a.agent_loop_s + a.grading_s
    rerun_cost = rerun_s / 3600 * a.instance_usd_per_hour * n_rollouts

    # Re-grade: restore checkpoint (image is cached, only the diff is fetched),
    # run the grader.
    regrade_s = a.checkpoint_restore_s + a.grading_s
    regrade_compute = regrade_s / 3600 * a.instance_usd_per_hour * n_rollouts
    checkpoint_storage_month = a.rollout_diff_gb * n_rollouts * a.storage_usd_gb_month
    checkpoint_puts = n_rollouts / 1000 * a.storage_put_per_1k

    rows = [
        f"| approach | wall-clock per rollout | total cost ({n_rollouts:,} rollouts) |",
        "| --- | --- | --- |",
        f"| re-run rollouts (agent in the loop) | {rerun_s:.0f}s | ${rerun_cost:,.0f} + model tokens |",
        f"| re-grade stored checkpoints | {regrade_s:.0f}s | ${regrade_compute:,.0f} compute "
        f"+ ${checkpoint_storage_month:,.0f}/mo storage + ${checkpoint_puts:.2f} puts |",
    ]
    rows.append("")
    rows.append(f"(model tokens for {n_rollouts:,} x 10-minute agent loops are the real "
                "re-run cost and typically dwarf the instance cost)")
    return "\n".join(rows)


if __name__ == "__main__":
    a = Assumptions()
    print("## Cold start scenarios\n")
    print(scenario_table(a))
    print("\n## Grader update: re-run vs re-grade\n")
    print(regrade_table(a))
