"""Run in the separately pinned adapter environment against retained full data.

Usage: python -m strive_benchmark_tau2.certify DATA_ROOT OUTPUT_ROOT
DATA_ROOT/qualification_assertions.json is the reviewed function allowlist.
Nothing is excluded or reassigned when qualification fails.
"""
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
from unittest.mock import patch

from strive.vnext.benchmarks.json_data import canonical, items, obj, parse, string
from strive.vnext.store import ArtifactStore
from . import UPSTREAM_REVISION
from .native_worker import deny_network, run
from .qualification import QualificationFailure, qualify


def main() -> None:
    root, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    metadata = importlib.metadata.distribution("tau2")
    source = json.loads(metadata.read_text("direct_url.json") or "{}")
    if source.get("vcs_info", {}).get("commit_id") != UPSTREAM_REVISION:
        raise RuntimeError("certification requires the pinned tau2 distribution")
    os.environ["TAU2_DATA_DIR"] = str(root)
    allowlist_path = root / "qualification_assertions.json"
    allowlist = obj(parse(allowlist_path.read_bytes()))
    assertions = frozenset((requestor, string(name)) for requestor, names in allowlist.items() for name in items(names))
    store = ArtifactStore(output / "artifacts")
    store.objects.publish(allowlist_path.read_bytes())
    def check(task: dict[str, object]) -> None:
        with patch.object(socket.socket, "connect", deny_network), patch.object(socket, "create_connection", deny_network):
            run({"operation": "qualify", "state": None, "payload": {"task": task, "initialization": {}}})
    try:
        result = qualify(store.objects, (root / "tau2/domains/telecom/tasks.json").read_bytes(),
            (root / "tau2/domains/telecom/split_tasks.json").read_bytes(), assertion_allowlist=assertions, execute_checks=check)
    except QualificationFailure as error:
        failure_report = {"status": "blocked", "affected_ids": error.affected_ids, "failures": error.failures,
                  "proposed_campaign": error.proposed_campaign}
        (output / "qualification.json").write_bytes(canonical(failure_report))
        print(json.dumps(failure_report, indent=2))
        raise SystemExit(1)
    report = {"status": "qualified", "report": result.report.digest, "groups": result.groups,
              "development": result.development, "validation": result.validation, "audit": result.audit}
    (output / "qualification.json").write_bytes(canonical(report))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
