"""The vNext command-line interface (`uv run strive`).

Minimal, run-scoped operator surface over the substrate + kernel:

    strive run       — bind/resume a manual-change@1 run and drive it
    strive runs      — list runs under an artifact root
    strive status    — the verified view: policy, head, ok/errors, budget
    strive view      — the current composite HarnessState (surfaces + refs)
    strive history   — the ordered event stream (id, kind, causation, time)
    strive inspect   — decode one event body (or CAS object) as JSON
    strive revert    — revert an applied change exactly (operator action)
    strive repair    — quarantine + truncate an unverifiable journal tail
    strive sandbox   — report sandbox backends and enforced capabilities

Every command is `--json`-able. There is no promotion gate, no migration,
and no legacy mode.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from strive import codec
from strive.cas import InvalidRef, ObjectCorruption, ObjectMissing
from strive.contracts import BudgetSpec
from strive.kernel import KernelError, KernelServices, operator_revert, run_policy
from strive.model import ModelCatalog
from strive.policy import default_catalog
from strive.policies import continual_refine as cr
from strive.policies import manual_change as mc
from strive.sandboxes import SandboxError
from strive.substrate import Substrate, SubstrateError, new_run_id
from strive.surfaces import SurfaceValidationError
from strive.tasks import TASKS

# a control-compatible BEHAVIORAL seed prompt for the evolvable proposal
# template — it describes what a good solve() must do, WITHOUT revealing any
# specific planted fix (the refiner must learn that from observed failures).
_BASELINE_PROMPT = (
    "You improve a Python strategy solve(input_text: str) -> int for its task. "
    "Return exactly one solve() that is correct across the observed cases; react "
    "to the concrete failures reported in the refinement context."
)


class CliError(Exception):
    """A user-facing CLI error (clean message, no traceback)."""


def _latest_run(root: Path) -> str:
    runs = Substrate.list_runs(root)
    if not runs:
        raise CliError(f"no runs under {root}; start one with `strive run`")
    return runs[-1]


def _resolve_run(root: Path, run: str | None) -> str:
    return run if run else _latest_run(root)


def _model_catalog(role: str) -> ModelCatalog | None:
    """A real model catalog from `STRIVE_MODEL_*` env (opt-in), or None when
    unset. `continual-refine@1` requires this; running it offline is a clean
    error rather than a silent fake."""
    from strive.model import adapter_from_env

    adapter = adapter_from_env()
    return ModelCatalog({role: adapter}) if adapter is not None else None


def _cmd_run(args: argparse.Namespace) -> dict[str, Any]:
    task = TASKS.get(args.task)
    if task is None:
        raise CliError(f"unknown task {args.task!r}; known: {sorted(TASKS)}")
    if args.policy not in default_catalog().names():
        raise CliError(
            f"unknown policy {args.policy!r}; known: {list(default_catalog().names())}"
        )
    run_id = args.run or new_run_id()
    continual = args.policy == "continual-refine@1"
    policy_mod = cr if continual else mc
    try:
        config = policy_mod.load_config(args.config or policy_mod.DEFAULT_CONFIG_PATH)
    except (SubstrateError, SurfaceValidationError) as exc:
        raise CliError(str(exc)) from None
    # PRODUCTION continual-refine@1 runs model-authored code, so it uses a
    # SECURE backend + trusted=False + secure capabilities, and never defaults
    # to fault-only. (The offline test harness opts into fault-only explicitly.)
    required_caps: tuple[str, ...] = ()
    if continual:
        from strive.sandboxes import SECURE_EXECUTION_CAPABILITIES

        backend = args.backend if args.backend != "process-fault-only@1" else "deno-pyodide@1"
        trusted = False
        required_caps = SECURE_EXECUTION_CAPABILITIES
        model_role = getattr(config, "model_role", "refine")
        models = _model_catalog(model_role)
        if models is None:
            raise CliError(
                "continual-refine@1 needs a model: set STRIVE_MODEL_PROVIDER / "
                "STRIVE_MODEL_BASE_URL / STRIVE_MODEL_API_KEY / STRIVE_MODEL_ID "
                "(real-model runs are opt-in; offline CI drives it with a fake "
                "through the test harness)"
            )
    else:
        backend = args.backend
        trusted = args.backend == "process-fault-only@1"
        model_role, models = "refine", None
    try:
        services = KernelServices.open(
            args.root, task, run_id, seed=args.seed,
            sandbox_backend=backend, trusted=trusted,
            budget=BudgetSpec(
                executions=args.executions,
                model_calls=args.model_calls if continual else 0,
            ),
            required_capabilities=required_caps,
            models=models, model_role=model_role,
        )
    except (KernelError, SandboxError, SubstrateError, SurfaceValidationError) as exc:
        raise CliError(str(exc)) from None
    objects = services.substrate.objects
    seed_state = policy_mod.seed_state(objects, code=task.seed_source, prompt=_BASELINE_PROMPT)
    try:
        report = run_policy(
            services, default_catalog(), args.policy, config,
            prompt_refs=policy_mod.prompt_refs(objects), seed_state=seed_state,
            run_metadata={
                "backend": args.backend, "seed": str(args.seed),
                "policy": args.policy,
                "model": (
                    services.models.resolve(model_role).model_id
                    if services.models else "none"
                ),
            },
        )
    except (KernelError, SubstrateError) as exc:
        raise CliError(str(exc)) from None
    data = {
        "run_id": report.run_id, "task_id": report.task_id,
        "policy_ref": report.policy_ref, "commands": report.commands,
        "stopped_reason": report.stopped_reason, "resumed": report.resumed,
        "head": report.head, "usage": codec.encode(report.usage),
    }
    human = (
        f"run {report.run_id} [{report.policy_ref}] "
        f"{'resumed' if report.resumed else 'started'}: "
        f"{report.commands} command(s), stopped: {report.stopped_reason}; "
        f"executions charged: {report.usage.executions}"
    )
    return {"data": data, "human": human}


def _cmd_runs(args: argparse.Namespace) -> dict[str, Any]:
    runs = Substrate.list_runs(args.root)
    return {"data": {"runs": runs}, "human": "\n".join(runs) or "(no runs)"}


def _open_view(root: Path, run: str | None) -> tuple[Substrate, Any]:
    run_id = _resolve_run(root, run)
    # discover the run's task from its binding index — NEVER by string-parsing
    # the (opaque) run id.
    try:
        sub = Substrate.discover(root, run_id)
    except SubstrateError as exc:
        raise CliError(str(exc)) from None
    return sub, sub.verify()


def _cmd_status(args: argparse.Namespace) -> dict[str, Any]:
    sub, view = _open_view(args.root, args.run)
    data = {
        "run_id": view.run_id, "task_id": view.task_id, "head": view.head,
        "verified": view.ok, "errors": list(view.errors), "events": view.seq,
        "policy_ref": view.bound.policy_ref if view.bound else None,
        "seed": view.bound.seed if view.bound else None,
        "run_metadata": dict(view.bound.run_metadata) if view.bound else {},
        "surfaces": [[b.kind, b.name] for b in view.state.bindings],
    }
    lines = [
        f"run {view.run_id} ({'VERIFIED' if view.ok else 'UNVERIFIABLE'})",
        f"  policy: {data['policy_ref']}  seed: {data['seed']}  events: {view.seq}",
        f"  head: {view.head}",
        f"  surfaces: {', '.join(f'{k}/{n}' for k, n in data['surfaces']) or '(none)'}",
    ]
    for err in view.errors:
        lines.append(f"  ERROR: {err}")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_view(args: argparse.Namespace) -> dict[str, Any]:
    sub, view = _open_view(args.root, args.run)
    surfaces = [
        {"kind": b.kind, "name": b.name, "content_ref": b.content_ref}
        for b in view.state.bindings
    ]
    lines = [f"composite state @ {view.head} (verified={view.ok}):"]
    for s in surfaces:
        lines.append(f"  {s['kind']}/{s['name']} -> {s['content_ref'][:16]}…")
    return {"data": {"state_ref": view.state_ref, "surfaces": surfaces},
            "human": "\n".join(lines)}


def _cmd_history(args: argparse.Namespace) -> dict[str, Any]:
    sub, view = _open_view(args.root, args.run)
    events = [
        {"event_id": e.event_id, "seq": e.seq, "kind": e.body_kind,
         "caused_by": e.caused_by, "at": e.at}
        for e in view.envelopes
    ]
    lines = [f"{e['seq']:>3} {e['kind']:<24} caused_by={e['caused_by']}" for e in events]
    return {"data": {"events": events, "verified": view.ok},
            "human": "\n".join(lines) or "(no events)"}


def _cmd_inspect(args: argparse.Namespace) -> dict[str, Any]:
    sub, view = _open_view(args.root, args.run)
    if args.ref:
        try:
            raw = sub.objects.get_text(args.ref)
        except (ObjectMissing, ObjectCorruption) as exc:
            raise CliError(str(exc)) from None
        return {"data": {"ref": args.ref, "content": raw}, "human": raw}
    if args.event is None:
        raise CliError("inspect requires --event SEQ or --ref CAS_REF")
    match = [e for e in view.envelopes if e.seq == args.event]
    if not match:
        raise CliError(f"no event with seq {args.event} in run {view.run_id}")
    env = match[0]
    body = codec.encode(sub.load_body(env))
    data = {"envelope": codec.encode(env), "body": body}
    return {"data": data, "human": json.dumps(data, indent=2, sort_keys=True)}


def _cmd_revert(args: argparse.Namespace) -> dict[str, Any]:
    sub, view = _open_view(args.root, args.run)
    if not view.ok:
        raise CliError(f"run is unverifiable; repair first: {'; '.join(view.errors[:2])}")
    if view.bound is None:
        raise CliError("run is not bound to a policy; nothing to revert")
    task = TASKS.get(view.task_id)
    if task is None:
        raise CliError(f"run's task {view.task_id!r} is unknown to this build")
    # route the mutation through the durable command path (issue → perform →
    # terminal), NOT a direct Substrate.revert.
    try:
        services = KernelServices.open(args.root, task, view.run_id)
        result = operator_revert(services, args.change)
    except (KernelError, SubstrateError) as exc:
        raise CliError(str(exc)) from None
    if result.outcome != "ok":
        raise CliError(f"revert failed: {result.detail}")
    updated = sub.verify()
    return {
        "data": {"reverted": args.change, "command_id": result.command_id,
                 "head": updated.head, "state_ref": updated.state_ref},
        "human": f"reverted {args.change} via {result.command_id}; state @ {updated.head}",
    }


def _cmd_repair(args: argparse.Namespace) -> dict[str, Any]:
    sub, view = _open_view(args.root, args.run)
    quarantine = sub.repair("operator repair")
    if quarantine is None:
        note = (
            "nothing to repair (journal has no torn/forged tail). NOTE: a log "
            "that is intact but SEMANTICALLY invalid is refused, not "
            "auto-quarantined — inspect the errors and start a new run."
            if not view.ok else "journal is clean and verified"
        )
        return {"data": {"quarantine": None, "verified": view.ok, "errors": list(view.errors)},
                "human": note}
    return {"data": {"quarantine": quarantine},
            "human": f"quarantined the unverified tail to {quarantine} and truncated"}


def _cmd_sandbox(args: argparse.Namespace) -> dict[str, Any]:
    from strive.sandboxes import default_catalog as sandbox_catalog

    catalog = sandbox_catalog()
    backends: list[dict[str, Any]] = []
    lines = ["sandbox backends:"]
    for name in catalog.names():
        backend = catalog.resolve(name, require_available=False)
        available, reason = backend.available()
        caps = backend.capabilities()
        backends.append({
            "backend": name, "available": available, "reason": reason,
            "secure": caps.secure, "enforced": list(caps.enforced),
        })
        lines.append(
            f"  {name} [{'OK' if available else 'unavailable'}, "
            f"{'SECURE' if caps.secure else 'not-secure'}]: "
            f"{', '.join(caps.enforced) or '(none)'}"
        )
    return {"data": {"backends": backends}, "human": "\n".join(lines)}


_COMMANDS = {
    "run": _cmd_run, "runs": _cmd_runs, "status": _cmd_status, "view": _cmd_view,
    "history": _cmd_history, "inspect": _cmd_inspect, "revert": _cmd_revert,
    "repair": _cmd_repair, "sandbox": _cmd_sandbox,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="strive", description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("artifacts"))
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="command", required=True)

    run_p = sub.add_parser("run", help="bind/resume a policy run and drive it")
    run_p.add_argument("--task", default="sum-integers")
    run_p.add_argument("--run", default=None, help="resume this run id (default: new)")
    run_p.add_argument("--seed", type=int, default=0)
    run_p.add_argument(
        "--policy", default="manual-change@1",
        help="policy name (manual-change@1 | continual-refine@1)",
    )
    run_p.add_argument("--config", default=None, help="policy TOML (default: bundled)")
    run_p.add_argument("--backend", default="process-fault-only@1")
    run_p.add_argument("--executions", type=int, default=64)
    run_p.add_argument("--model-calls", type=int, default=4,
                       help="model-call budget for continual-refine@1")

    sub.add_parser("runs", help="list runs under the artifact root")
    for name in ("status", "view", "history"):
        p = sub.add_parser(name)
        p.add_argument("--run", default=None)
    insp = sub.add_parser("inspect", help="decode one event body or CAS object")
    insp.add_argument("--run", default=None)
    insp.add_argument("--event", type=int, default=None, help="event seq")
    insp.add_argument("--ref", default=None, help="a CAS ref")
    rev = sub.add_parser("revert", help="revert an applied change exactly")
    rev.add_argument("change", help="the change id to revert")
    rev.add_argument("--run", default=None)
    rep = sub.add_parser("repair", help="quarantine + truncate an unverified journal tail")
    rep.add_argument("--run", default=None)
    sub.add_parser("sandbox", help="report sandbox backends and capabilities")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = _COMMANDS[args.command](args)
    except (
        CliError, SubstrateError, KernelError, codec.SchemaError,
        ObjectCorruption, ObjectMissing, InvalidRef, SurfaceValidationError,
        SandboxError,
    ) as exc:
        message = f"{type(exc).__name__}: {exc}"
        if args.json:
            print(json.dumps({"ok": False, "command": args.command, "error": message}))
        else:
            print(f"error: {message}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(
            {"ok": True, "command": args.command, "data": result["data"]},
            sort_keys=True,
        ))
    else:
        print(result["human"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
