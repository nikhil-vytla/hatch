"""Freeze first; copy selected actor bytes one way; release through reporting."""
from pathlib import Path
from contextlib import ExitStack
from decimal import Decimal
import fcntl
import tomllib

from ..cli.data import integer, json_bytes, mapping, read_json, sequence, string, toml, write_json
from ..cli.runner import Session, reader, run_directory
from ..codec import content_ref
from ..contracts.lifecycle import EffectState
from ..contracts.primitives import ArtifactRef, ExecutionStatus
from ..errors import VerificationError
from ..policy.data import Bundle, FileVersion, loads
from ..report.compare import export
from ..report.history import history, total_expenditure
from ..report.history import suspension_reason
from ..store.cas import atomic_file, durable_directory, fsync_directory


def freeze(root: Path, directory: Path, allocation: dict[str, object]) -> dict[str, object]:
    with ExitStack() as locks:
        for value in sequence(allocation["runs"]):
            lease = locks.enter_context((run_directory(root, string(mapping(value)["run"])) / "workflow.lease").open("r+b"))
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _freeze_locked(root, directory, allocation)


def _freeze_locked(root: Path, directory: Path, allocation: dict[str, object]) -> dict[str, object]:
    path = directory / "freeze.json"
    if path.exists():
        return read_json(path.read_bytes())
    selected: list[dict[str, object]] = []
    for value in sequence(allocation["runs"]):
        row = mapping(value)
        run_id = string(row["run"])
        read = reader(root, run_id)
        state = read.verify()
        if state.execution_status is ExecutionStatus.CONTINUE and suspension_reason(read, state) is None and not (run_directory(root, run_id) / "FROZEN").exists():
            raise VerificationError("campaign must be finished or explicitly stopped before freeze")
        eligible = state.active_bundle is not None and state.pending_command is None and all(e.state is EffectState.CONSUMED for e in state.effects)
        selection = {"run": run_id, "head": state.head.digest if state.head else None,
            "bundle": state.active_bundle.digest if eligible and state.active_bundle else None,
            "arm": row["arm"], "repetition": row["repetition"], "seed": row["seed"],
            "status": state.execution_status.value,
            "audit_run": run_id + "-audit", "ineligible_reason": None if eligible else "unresolved execution"}
        selected.append(selection)
    frozen = {"selection": allocation["selection"], "spec_digest": allocation["spec_digest"], "selected": selected}
    # Individual barriers are installed before exposing the campaign freeze.
    # Restart completes this same barrier set; it cannot select new candidates.
    for selection in selected:
        barrier = run_directory(root, string(selection["run"])) / "FROZEN"
        if barrier.exists():
            if read_json(barrier.read_bytes()) != selection:
                raise VerificationError("frozen selection changed")
        else:
            write_json(barrier, selection)
    write_json(path, frozen)
    return frozen


def _check_frozen(root: Path, frozen: dict[str, object]) -> None:
    for raw in sequence(frozen["selected"]):
        selected = mapping(raw)
        run_id = string(selected["run"])
        state = reader(root, run_id).verify()
        if state.head is None or state.head.digest != selected["head"] or read_json((run_directory(root, run_id) / "FROZEN").read_bytes()) != selected:
            raise VerificationError("development changed after campaign freeze")


def actor_bytes(root: Path, selected: dict[str, object]) -> dict[str, bytes]:
    read = reader(root, string(selected["run"]))
    bundle = loads(read.objects.read(ArtifactRef(string(selected["bundle"]))), Bundle)
    if bundle.dependencies or bundle.capabilities:
        raise VerificationError("audit fixture cannot silently omit actor dependencies/capabilities")
    return {path: read.objects.read(loads(read.objects.read(ref), FileVersion).content)
            for path, ref in bundle.files if not path.startswith("controller/")}


def execute_audit(root: Path, directory: Path, allocation: dict[str, object]) -> None:
    freeze_path = directory / "freeze.json"
    if not freeze_path.exists():
        raise VerificationError("blind audit requires completed campaign freeze")
    frozen = read_json(freeze_path.read_bytes())
    _check_frozen(root, frozen)
    spec = mapping(allocation["spec"])
    audit = mapping(spec["audit"])
    boundary = root / "audit" / directory.name
    durable_directory(boundary)
    # Configuration is public, task-level audit inputs stay under this root.
    # No callback, selector, writer, dashboard or budget handle returns to policy.
    destination = string(audit["destination"])
    if not destination.startswith("audit:"):
        raise VerificationError("audit destination must be isolated")
    audit_rows = sequence(frozen["selected"])
    count = len(audit_rows)
    allocation_values = mapping(allocation["audit_allocation"])
    source_by_run = {string(mapping(r)["run"]): string(mapping(r)["source"]) for r in sequence(allocation["runs"])}
    for raw in audit_rows:
        selected = mapping(raw)
        if selected["bundle"] is None:
            continue
        run_id = string(selected["audit_run"])
        target = run_directory(boundary, run_id)
        if target.exists():
            with Session(target, run_id) as session:
                session.drive()
            continue
        source = mapping(tomllib.loads(source_by_run[string(selected["run"])]))
        source["run"] = {**mapping(source["run"]), "editable": []}
        budget = mapping(source["budget"])
        digits = tuple(int(digit) for digit in str(integer(allocation_values["usd_nanodollars"]) // count))
        budget["usd"] = Decimal((0, digits, -9))
        for key in ("tokens", "model_calls", "wall_seconds"):
            budget[key] = integer(allocation_values[key]) // count
        source["budget"] = budget
        durable_directory(target.parent)
        target.mkdir(mode=0o700)
        fsync_directory(target.parent)
        files = actor_bytes(root, selected)
        with Session(target, run_id, source=toml(source), base=Path(string(allocation["base_directory"])),
                     lineage="audit", imported_actor=files, audit_target=integer(audit["target"], -10),
                     context={"campaign": directory.name, "arm": string(selected["arm"])}) as session:
            # Retain the exact one-way handoff and source selection in audit CAS.
            imported = {k: content_ref(v).digest for k, v in files.items()}
            write_json(target / "IMPORT.json", {"freeze": content_ref(freeze_path.read_bytes()).digest,
                "selected": selected, "files": imported, "destination": destination})
            session.drive()
    _check_frozen(root, frozen)
    write_json(boundary / "RELEASED", {"freeze": content_ref(freeze_path.read_bytes()).digest,
        "destination": destination}, replace=True)


def release(root: Path, directory: Path) -> dict[str, object]:
    frozen = read_json((directory / "freeze.json").read_bytes())
    boundary = root / "audit" / directory.name
    release_marker = read_json((boundary / "RELEASED").read_bytes())
    if release_marker["freeze"] != content_ref((directory / "freeze.json").read_bytes()).digest:
        raise VerificationError("audit release does not match frozen campaign")
    _check_frozen(root, frozen)
    reports = []
    missing = []
    for raw in sequence(frozen["selected"]):
        selected = mapping(raw)
        if selected["bundle"] is None:
            missing.append(selected)
        else:
            reports.append(history(reader(boundary, string(selected["audit_run"]))))
    report: dict[str, object] = {"claim": "Frozen actor transfer only; audit results cannot select another candidate or resume development.",
        "freeze": frozen, "runs": reports, "ineligible": missing, "comparison_strength": "descriptive audit transfer",
        "destination": release_marker["destination"]}
    development = [history(reader(root, string(mapping(row)["run"]))) for row in sequence(frozen["selected"])]
    report["development_expenditure"] = total_expenditure(development)
    report["audit_expenditure"] = total_expenditure(reports)
    report["campaign_expenditure"] = total_expenditure([*development, *reports])
    export(report, boundary / "reports")
    return {"development_report": str(directory / "reports/report.md"), "audit_report": str(boundary / "reports/report.md"),
            "frozen": True, "audited": len(reports), "ineligible": len(missing)}
