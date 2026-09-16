"""Offline campaign materialization in the pinned telecom interpreter."""
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
from unittest.mock import patch

from strive.vnext.benchmarks.closure import retain_closure
from strive.vnext.benchmarks.json_data import canonical, obj, parse, items, string
from strive.vnext.store import ArtifactStore
from .adapter import implementation_identity
from .data import retain_data
from .native_worker import deny_network, run
from .prepare import check_install
from .process import IsolatedTau2
from .qualification import qualify


def main() -> None:
    check_install()
    data, directory, repository, count_text = sys.argv[1:]
    source, root, repo = Path(data), Path(directory), Path(repository)
    count = int(count_text)
    objects = ArtifactStore(root / "artifacts").objects
    data_index = retain_data(objects, source, root / "data")
    os.environ["TAU2_DATA_DIR"] = str(root / "data")
    telecom = source / "tau2/domains/telecom"
    allowlist = obj(parse((source / "qualification_assertions.json").read_bytes()))
    assertions = frozenset((side, string(name)) for side, names in allowlist.items() for name in items(names))
    with patch.object(socket.socket, "connect", deny_network), patch.object(socket, "create_connection", deny_network):
        def check(task: dict[str, object]) -> None:
            run({"operation": "qualify", "state": None, "payload": {"task": task, "initialization": {}}})
        qualification = qualify(objects, (telecom / "tasks.json").read_bytes(), (telecom / "split_tasks.json").read_bytes(),
            assertion_allowlist=assertions, execute_checks=check)
        inventory = parse(objects.read(qualification.inventory))
        if isinstance(inventory, dict):
            inventory = inventory["tasks"]
        index = {string(obj(task)["id"]): obj(task) for task in items(inventory)}
        selected = qualification.development[:count]
        schemas = {}
        for task_id in selected:
            initial = run({"operation": "initialize", "state": None, "payload": {"task": index[task_id],
                "initialization": {"model": "gpt-5.6-luna", "model_settings": {}, "seed": 17}}})
            result = run({"operation": "user_schemas", "state": initial["state"], "payload": {}})
            schemas[task_id] = [{"type": "function", **tool["function"]} for tool in result["output"]]
    distribution = importlib.metadata.distribution("tau2")
    installed = tuple(sorted(Path(str(distribution.locate_file(f))) for f in distribution.files or []
                             if Path(str(distribution.locate_file(f))).is_file() and str(f).endswith(".py")))
    dependencies = tuple(sorted({Path(str(d.locate_file(f))) for d in importlib.metadata.distributions()
        for f in d.files or [] if Path(str(d.locate_file(f))).is_file() and not str(f).endswith((".pyc", ".pyo"))}))
    lock = repo / "adapters/tau2/uv.lock"
    closure = retain_closure(objects, {"source": installed, "wheel": (Path(str(distribution.locate_file("tau2-1.0.1.dist-info/METADATA"))),),
        "licenses": tuple(source.rglob("*LICENSE*")), "dependencies": dependencies, "lock": (lock,),
        "runtime": (Path(sys.executable).resolve(),), "build": (repo / "scripts/install-tau2.sh",),
        "tasks": (telecom / "tasks.json",), "splits": (telecom / "split_tasks.json",),
        "databases": tuple(telecom.rglob("*.json")), "policies": tuple(telecom.rglob("*.md")),
        "schemas": installed, "environment": installed, "scorer": installed, "user": installed,
        "qualification": (source / "qualification_assertions.json",)})
    backend = IsolatedTau2(Path(sys.executable), root / "data", objects, closure, data_index)
    identity = implementation_identity(objects, backend, qualification, closure)
    (root / "telecom.json").write_bytes(canonical({"closure": closure.digest, "data": data_index.digest,
        "qualification": qualification.report.digest, "identity": identity.digest, "tasks": selected, "user_schemas": schemas}))
    print(json.dumps({"prepared": len(selected), "split": "adaptive-development", "model_calls": 0}))


if __name__ == "__main__":
    main()
