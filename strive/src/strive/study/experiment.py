"""Stable arm/repetition allocation followed by the ordinary runner."""
from decimal import Decimal
from pathlib import Path
from dataclasses import fields, is_dataclass
import tomllib

from ..cli.data import integer, json_bytes, keys, local_id, mapping, read_json, sequence, string, toml, write_json
from ..cli.runner import Session, manifest_for, reader, resume, run, run_directory
from ..codec import content_ref
from ..contracts.manifest import load_authored_manifest
from ..errors import VerificationError
from ..report.compare import compare, comparison_spec, export
from ..report.history import history, unavailable, total_expenditure
from ..store.cas import atomic_file, durable_directory, fsync_directory


def study_spec(path: Path) -> dict[str, object]:
    data = mapping(tomllib.loads(path.read_text(), parse_float=Decimal))
    keys(data, "id base repetitions seeds pairing arms allocations audit analysis")
    local_id(string(data["id"]))
    reps = integer(data["repetitions"], 1)
    seeds = [integer(v) for v in sequence(data["seeds"])]
    if len(seeds) != reps or len(set(seeds)) != reps or data["pairing"] != "workload_seed":
        raise VerificationError("one distinct workload seed per paired repetition is required")
    arms = mapping(data["arms"])
    if set(arms) != {"fixed", "adapting"}:
        raise VerificationError("reference study requires fixed and adapting arms")
    audit = mapping(data["audit"])
    keys(audit, "allocation target destination selection")
    if audit["selection"] != "final_valid_active_actor_from_every_trajectory":
        raise VerificationError("audit selection must be predeclared final active actor from every trajectory")
    integer(audit["target"], -10)
    if integer(audit["target"], -10) > 10:
        raise VerificationError("audit target outside fixture bounds")
    if not string(audit["destination"]).startswith("audit:"):
        raise VerificationError("audit telemetry requires a separate audit destination boundary")
    analysis = comparison_spec(toml(mapping(data["analysis"])))
    if analysis["strictness"] != "matched" or analysis["selection"] != audit["selection"]:
        raise VerificationError("reference study requires matched analysis and consistent selection")
    return data


def override(source: str, changes: dict[str, object], seed: int) -> str:
    data = mapping(tomllib.loads(source, parse_float=Decimal))
    for name, value in changes.items():
        if name not in {"run.editable", "policy.refine_every_episodes"}:
            raise VerificationError("unsupported arm override: " + name)
        table, field = name.split(".")
        mapping_value = mapping(data[table])
        mapping_value[field] = value
        data[table] = mapping_value
    seed_data = mapping(data["seeds"])
    seed_data["workload"] = seed
    data["seeds"] = seed_data
    text = toml(data)
    load_authored_manifest(text)
    return text


def _allocation(value: object) -> dict[str, int]:
    data = mapping(value)
    keys(data, "usd_nanodollars tokens model_calls wall_seconds")
    return {k: integer(v) for k, v in data.items()}


def snapshot_inputs(source: str, base: Path, directory: Path) -> str:
    """Capture local authoring inputs once for still-unprepared repetitions."""
    authored = load_authored_manifest(source)
    refs = {authored.run.capabilities, authored.policy.package, authored.feedback.audit_plan, authored.comparison.plan,
            authored.budget.price_schedule, *(m.binding.request_options for m in authored.models)}
    for table in (authored.pins, authored.workload):
        refs.update(str(getattr(table, field.name)) for field in fields(table) if getattr(table, field.name) is not None)
    replacements: dict[str, str] = {}
    for ref in sorted(refs):
        if ref.startswith(("builtin:", "sha256:")):
            continue
        original = (base / ref).resolve()
        target = directory / "inputs" / content_ref(ref.encode()).digest[7:]
        if original.is_dir():
            for path in sorted(original.rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts and ".git" not in path.parts:
                    output = target / path.relative_to(original)
                    durable_directory(output.parent)
                    atomic_file(output, path.read_bytes())
        else:
            durable_directory(target.parent)
            atomic_file(target, original.read_bytes())
        replacements[ref] = str(target.resolve())
    def rewrite(value: object) -> object:
        if isinstance(value, str):
            return replacements.get(value, value)
        if isinstance(value, dict):
            return {str(k): rewrite(v) for k, v in value.items()}
        if isinstance(value, list):
            return [rewrite(v) for v in value]
        return value
    return toml(mapping(rewrite(tomllib.loads(source, parse_float=Decimal))))


def allocate(root: Path, path: Path) -> tuple[Path, dict[str, object]]:
    spec = study_spec(path)
    directory = root / "studies" / local_id(string(spec["id"]))
    mapping_path = directory / "allocation.json"
    signature = content_ref(json_bytes(spec)).digest
    if mapping_path.exists():
        recorded = read_json(mapping_path.read_bytes())
        if recorded["spec_digest"] != signature:
            raise VerificationError("study configuration changed; allocated repetitions cannot be replaced")
        return directory, recorded
    durable_directory(directory)
    base_path = (path.parent / string(spec["base"])).resolve()
    source = snapshot_inputs(base_path.read_text(), base_path.parent, directory)
    base = load_authored_manifest(source)
    if base.feedback.contract.value != "A":
        raise VerificationError("reference study uses feedback A")
    allocations = mapping(spec["allocations"])
    keys(allocations, "fixed adapting total")
    a, b, total = (_allocation(allocations[k]) for k in ("fixed", "adapting", "total"))
    required = {"usd_nanodollars": base.budget.usd.nanodollars, "tokens": base.budget.tokens,
                "model_calls": base.budget.model_calls, "wall_seconds": base.budget.wall_seconds}
    reps = integer(spec["repetitions"], 1)
    if a != b or a != required:
        raise VerificationError("matched per-arm per-repetition allocations must equal the run ceilings")
    if any(total[k] < 2 * reps * a[k] for k in a):
        raise VerificationError("total development allocation does not cover declared repetitions")
    audit = mapping(spec["audit"])
    audit_allocation = _allocation(audit["allocation"])
    if audit_allocation["wall_seconds"] < 2 * reps:
        raise VerificationError("separate audit allocation is too small")
    arms = mapping(spec["arms"])
    if mapping(arms["fixed"]).get("run.editable") != []:
        raise VerificationError("fixed arm must freeze actor code, prompts and memory")
    if not mapping(arms["adapting"]).get("run.editable"):
        raise VerificationError("adapting arm must declare editable scope")
    if "controller.code" in sequence(mapping(arms["adapting"])["run.editable"]):
        raise VerificationError("controller adaptation requires a separate research plan")
    runs: list[dict[str, object]] = []
    for arm in ("fixed", "adapting"):
        for rep, seed in enumerate(sequence(spec["seeds"])):
            text = override(source, mapping(arms[arm]), integer(seed))
            name = local_id(f"{spec['id']}-{arm}-{rep}")
            local_id(name + "-audit")
            if run_directory(root, name).exists():
                raise VerificationError("study allocation collides with an existing run")
            runs.append({"arm": arm, "repetition": rep, "seed": seed, "run": name, "source": text})
    recorded = {"schema": "strive.study/1", "spec_digest": signature, "spec": spec, "base_directory": str(base_path.parent),
                "runs": runs, "selection": audit["selection"], "development_allocation": total,
                "audit_allocation": audit_allocation}
    # Mapping is one durable, exclusive publication, before setup or dispatch.
    write_json(mapping_path, recorded)
    return directory, recorded


def experiment(root: Path, path: Path, *, stop_after: int | None = None, audit: bool = True) -> dict[str, object]:
    directory, allocation = allocate(root, path)
    rows = [mapping(v) for v in sequence(allocation["runs"])]
    spec = mapping(allocation["spec"])
    if (directory / "freeze.json").exists():
        from .audit import execute_audit, release
        if audit:
            execute_audit(root, directory, allocation)
            return release(root, directory)
    completed = 0
    errors: dict[str, str] = {}
    # Resolve every allocated repetition before the first dispatch. A wrapper
    # crash can leave a prepared run, which resumes with its recorded closure.
    for row in rows:
        run_id = string(row["run"])
        target = run_directory(root, run_id)
        if not target.exists():
            # Retained authored source is used on wrapper restart, never a new
            # run ID. Each setup resolves once, before that run dispatches.
            target.parent.mkdir(parents=True, exist_ok=True)
            target.mkdir(mode=0o700)
            fsync_directory(target.parent)
            try:
                with Session(target, run_id, source=string(row["source"]), base=Path(string(allocation["base_directory"])),
                             context={"campaign": directory.name, "arm": string(row["arm"])}) as session:
                    print("Resolved configuration before dispatch:\n" + json_bytes(session.manifest).decode(), flush=True)
            except (OSError, VerificationError, ValueError) as error:
                errors[run_id] = str(error)
        else:
            try:
                manifest_for(reader(root, run_id))
            except (OSError, VerificationError, ValueError) as error:
                errors[run_id] = str(error)
    if errors:
        return incomplete_report(root, directory, allocation, errors)
    left = [reader(root, string(r["run"])) for r in rows if r["arm"] == "fixed"]
    right = [reader(root, string(r["run"])) for r in rows if r["arm"] == "adapting"]
    compare(left, right, mapping(spec["analysis"]))
    for row in rows:
        try:
            resume(root, string(row["run"]))
        except (OSError, VerificationError, ValueError) as error:
            errors[string(row["run"])] = str(error)
        completed += 1
        if stop_after is not None and completed >= stop_after:
            return {"allocation": allocation, "stopped_after": completed}
    if errors:
        return incomplete_report(root, directory, allocation, errors)
    left = [reader(root, string(r["run"])) for r in rows if r["arm"] == "fixed"]
    right = [reader(root, string(r["run"])) for r in rows if r["arm"] == "adapting"]
    report = compare(left, right, mapping(spec["analysis"]))
    report["expenditure"] = total_expenditure([mapping(r) for r in sequence(report["runs"])])
    report["allocation"] = {"development": allocation["development_allocation"], "audit": allocation["audit_allocation"],
                            "inherited_preparation_cost": 0, "note": "independent trajectories; no shared charged history"}
    export(report, directory / "reports")
    if audit:
        from .audit import freeze, execute_audit, release
        freeze(root, directory, allocation)
        execute_audit(root, directory, allocation)
        return release(root, directory)
    return report


def incomplete_report(root: Path, directory: Path, allocation: dict[str, object], errors: dict[str, str]) -> dict[str, object]:
    spec = mapping(allocation["spec"])
    reports = []
    for row in sequence(allocation["runs"]):
        run_id = string(mapping(row)["run"])
        try:
            report = history(reader(root, run_id))
            if run_id in errors:
                report["status"], report["suspension_reason"] = "indeterminate", errors[run_id]
        except (OSError, VerificationError, ValueError):
            report = unavailable(run_id, integer(mapping(spec["analysis"])["horizon"]), errors.get(run_id, "unavailable history"))
        reports.append(report)
    result: dict[str, object] = {"runs": reports, "allocation": allocation,
        "expenditure": total_expenditure(reports),
        "comparison_strength": "descriptive incomplete allocation", "errors": errors,
        "claim": "Incomplete study; no matched improvement claim; every allocated run is retained.",
        "uncertainty": {"interval": None, "missing": "see full denominators and outcome bounds"}}
    export(result, directory / "reports")
    return result
