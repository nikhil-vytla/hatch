"""Fail closed if a required Linux/tau2 gate was skipped, even if pytest passed."""
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

report, types_status, tests_status = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
if not report.exists():
    raise SystemExit("VERIFY FAILED: pytest produced no JUnit report")
cases = list(ET.parse(report).iter("testcase"))
failures = [case for case in cases if case.find("failure") is not None or case.find("error") is not None]
skipped = [case for case in cases if case.find("skipped") is not None]
required = [case for case in cases if any(name in case.get("classname", "") for name in ("test_linux_jail", "test_tau2_live"))
            or case.get("name") in ("test_production_os_confinement_floor", "test_runtime_integrity_1_confines_candidate_and_harness")]
gated_skips = [case for case in required if case.find("skipped") is not None]
expected = {
    "test_production_os_confinement_floor",
    "test_runtime_integrity_1_confines_candidate_and_harness",
    "test_native_jail_denies_network_files_credentials_and_namespace_escape[candidate]",
    "test_native_jail_denies_network_files_credentials_and_namespace_escape[harness]",
    "test_cgroup_oom_kills_memory_bomb_without_rss_watchdog[candidate]",
    "test_cgroup_oom_kills_memory_bomb_without_rss_watchdog[harness]",
    "test_cgroup_denies_fork_bomb_and_cleans_descendants[candidate]",
    "test_cgroup_denies_fork_bomb_and_cleans_descendants[harness]",
    "test_tmpfs_enforces_aggregate_storage_quota",
    "test_cgroup_kill_covers_descendants_in_new_sessions",
    "test_live_tau2_action_comparator_equivalence",
    "test_full_inventory_certification",
    "test_live_tau2_fixed_stock_mode",
    "test_live_tau2_deterministic_scorer_against_upstream",
    "test_live_tau2_operation_store_snapshot_and_crash_recovery",
}
missing = expected - {case.get("name", "") for case in required}
okay = not (types_status or tests_status or failures or gated_skips or missing)
print(f"VERIFY {'PASSED' if okay else 'FAILED'}: {len(cases)} tests, {len(failures)} failures/errors, "
      f"{len(skipped)} skips/xfails, {len(required)} required jail/tau2 checks, "
      f"{len(gated_skips)} skipped gates; mypy exit={types_status}, pytest exit={tests_status}")
for name in sorted(missing):
    print("MISSING GATE:", name)
for case in gated_skips:
    print("UNEXECUTED GATE:", case.get("classname"), case.get("name"))
raise SystemExit(0 if okay else 1)
