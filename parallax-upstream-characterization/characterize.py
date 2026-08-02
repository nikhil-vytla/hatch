#!/usr/bin/env python3
"""Characterize the pinned Microsoft Evolving Intent source without model calls."""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

PINNED_REVISION = "993d6be9597ac03854b46362ccd647eb1bfd267a"
PINNED_TREE = "7ba418a8c6bddf5e650dc1808f7316a018d76168"
PINNED_RECEIPT_SHA256 = (
    "4f2a34f999f872ed57c4a269fe08ac8537fc068d68f37d6ae7820522e8e42662"
)

# Git blob SHA-1 and SHA-256 of the checked-out bytes at PINNED_REVISION.
PINNED_FILES: dict[str, tuple[str, str]] = {
    "LICENSE": (
        "9e841e7a26e4eb057b24511e7b92d42b257a80e5",
        "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383",
    ),
    "evaluation/common/sql_evaluator.py": (
        "9758db45a7ceb7f70ee5fea164d7e9e6f839c70f",
        "620f64bb8af42f358213d78400ddaf47a01904ef104da5420d442fbac6ddcb68",
    ),
    "evaluation/common/swe_evaluator.py": (
        "f1b85bf126f027707fdf2ba79469bdd022ba5bd1",
        "2df96e66752296b1cdfced234fbb237c9074bee5500c5165e1a3d9c81659b918",
    ),
    "evaluation/common/swe_harness.py": (
        "394df62f19b6db120531ea0578bb4c3b6b3eecdf",
        "9891927ec6e4465067b5a2ee3325f9888b9b6c7c4d51ab7424777b1189aea623",
    ),
    "evaluation/runners/run_browsecomp_experiment.py": (
        "424886a74eae3f49051988f3670b31b07f6beae5",
        "340b1f343940a03e71b666ad9829383e93fee146d5aaf29bb4592bcd03d42282",
    ),
    "intent_construction/eval_indices/bird_sql_eval_ids.json": (
        "53a823da87b6f8907317be54e0481972644e3b85",
        "96f7dd75efd00bb0299f5a5db21b84ef14a1970832a6fc89cea2659a71ebefe5",
    ),
    "intent_construction/eval_indices/bird_sql_task_ids.json": (
        "6a731032554d05bed0c8686255ed06bdcc851068",
        "d1f2db3dae15f56bae777f1fb3263a83447a2780f0acca24e3f1559425654e9f",
    ),
    "intent_construction/eval_indices/browsecomp_plus_eval_ids.json": (
        "ed6bd61cb9a69dfbbec2f3d1202c8150cea7800d",
        "ced1dff9592a1f722489480a0c1fc81e3a1495ec4b7c9a6a038dc2702d105f06",
    ),
    "intent_construction/eval_indices/browsecomp_plus_task_ids.json": (
        "83e6a32f252f9d03b02403945fc1c0660460b4d3",
        "a6ac616e9ec092f22b4740b29ec0a9c644580d40c6ec9eedf22d2bd8e18a10eb",
    ),
    "intent_construction/eval_indices/gsm8k_eval_ids.json": (
        "f886ed1455a876c37c414498123f73a555813820",
        "0101f92a3378c07e265b5a501db7e9de22ea0166a5d789bfb69a2f1518389f30",
    ),
    "intent_construction/eval_indices/gsm8k_task_ids.json": (
        "8281ce7fdff9a47490fa385d6107e20459075c06",
        "e6a69bd3b770568399eef46d67358aab05cc6f416c56c4d28cb23f8ecd45ec42",
    ),
    "intent_construction/eval_indices/swe_bench_verified_eval_ids.json": (
        "687c77931dc1baea61319036f7827356bfde71b7",
        "6b0e238ecf790b7f4d62b3d4ebb4f1a57b786097ee380cfaeb7d3f8ec5c6e6b4",
    ),
    "intent_construction/eval_indices/swe_bench_verified_task_ids.json": (
        "b9e23e4bf149688e60ed8270fe52084b6971e01f",
        "ca8b598a600b4e8e42a5ce579730312d8ec445f3e339c0a7b03f59f3ce43b75d",
    ),
    "intent_construction/intent_extraction/core/base_extractor.py": (
        "fea5aadc74cb55965c7f0d0bb3b93c69ed75c131",
        "1a461ee55e6233328b1f7ffbeb9772f05ce22daf20b0e2b608aca19273a4611e",
    ),
    "intent_construction/intent_extraction/generate.py": (
        "6ae0423b2832d63f93424bdba25750218fff321b",
        "beefbc68a045c9f3c75a3d7d080d9a29157eb03feba5c0dc9f10f011454ea92b",
    ),
    "intent_construction/retrospective_expansion/counterfactual/generate_counterfactuals.py": (
        "4e2f5484e9a1c200adbffe6f134711b7eaeb0cad",
        "d72d0bcc2b3b936cdb6a2626e6d85ecae31158bfb0685ca8676bfe5d87d8d548",
    ),
    "intent_construction/retrospective_expansion/counterfactual/generate_counterfactuals_sql.py": (
        "a4883f668aa8922d8dfa3cc1b17afd5408709179",
        "05497660b6bbc425978842434a546d80b0324e7fa1d3048744545d9f50dcf261",
    ),
    "intent_construction/retrospective_expansion/predecessor/generate_predecessors.py": (
        "bc1169befd7a8183af9d52f595b0e45afb4b78a1",
        "aa2ef1d61993583d8c6f9d87272fdfc4642e8676167d4d5ff1cdb774af0baa90",
    ),
    "situated_simulation/turn_scheduler.py": (
        "4b39a4758786482d7d53c1404a60f035aaf61d47",
        "f5420d2d629f0405968db677d810a50b5d7ad8a1aa79f424d7d083826ecc90de",
    ),
    "situated_simulation/turn_scheduler_swe.py": (
        "05e92ef71bc72a8de04559274166f491fd9f3e39",
        "3449af66c4bebcd1e87410e54067812a9093ffcf966097e2230298cabaa67a48",
    ),
    "situated_simulation/user_intent.py": (
        "5b22a39636ded75547f7dacd6d0ca77c19b23254",
        "070b73e30dab118ec6698e1a5cd850f5c523e404bf5555bd514e1b580f5b8b65",
    ),
    "situated_simulation/user_simulation.py": (
        "eb88c72e9c29cdc2766944768d160eac48008ecc",
        "c40cdfa57ebb36dc6caa4935574c86d69747fe8da5e428cb24b224ce61375cda",
    ),
}

EVAL_INDEX_COUNTS = {
    "bird_sql": 100,
    "browsecomp_plus": 100,
    "gsm8k": 200,
    "swe_bench_verified": 50,
}

GENERATED_ASSET_STATUS = {
    dataset: {
        "stage_1_extraction": "unavailable",
        "stage_2_counterfactuals": "unavailable",
        "stage_3_predecessors": "unavailable",
        "final_dataset": "unavailable",
        "provider_transcript": "unavailable",
    }
    for dataset in EVAL_INDEX_COUNTS
}


class CharacterizationError(RuntimeError):
    """A pinned-source or fixture contract failed."""


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _canonical_receipt_bytes(receipt: dict[str, Any]) -> bytes:
    payload = dict(receipt)
    payload.pop("canonical_sha256", None)
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _seal_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    sealed = dict(receipt)
    sealed["canonical_sha256"] = hashlib.sha256(
        _canonical_receipt_bytes(sealed)
    ).hexdigest()
    return sealed


def _find_symbol(
    source_path: Path, symbol: str, method: str | None = None
) -> tuple[ast.AST, str]:
    source = source_path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    parent: ast.AST | None = None
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == symbol:
            parent = node
            break
    if parent is None:
        raise CharacterizationError(f"missing symbol {symbol} in {source_path}")
    target = parent
    if method is not None:
        if not isinstance(parent, ast.ClassDef):
            raise CharacterizationError(f"{symbol} is not a class")
        target = next(
            (
                node
                for node in parent.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == method
            ),
            None,
        )
        if target is None:
            raise CharacterizationError(f"missing {symbol}.{method} in {source_path}")
    segment = ast.get_source_segment(source, target)
    if segment is None:
        raise CharacterizationError(f"cannot locate source for {symbol}")
    return target, segment


def _assert_fragments(label: str, source: str, fragments: list[str]) -> None:
    missing = [fragment for fragment in fragments if fragment not in source]
    if missing:
        raise CharacterizationError(f"{label} missing source contracts: {missing}")


def _symbol_receipt(node: ast.AST, name: str) -> dict[str, Any]:
    return {
        "symbol": name,
        "line_start": getattr(node, "lineno"),
        "line_end": getattr(node, "end_lineno"),
    }


def _source_contracts(upstream: Path) -> list[dict[str, Any]]:
    extraction_path = upstream / (
        "intent_construction/intent_extraction/core/base_extractor.py"
    )
    extraction_node, extraction_source = _find_symbol(
        extraction_path, "BaseExtractor", "extract"
    )
    extraction_calls = [
        "self.decompose(sample)",
        "self.to_conversational(sample, decomposed)",
        "self.verify_coverage(sample, extracted)",
        "self.verify_solvability(sample, extracted)",
        "self.build_output(sample, extracted)",
    ]
    _assert_fragments("BaseExtractor.extract", extraction_source, extraction_calls)

    counter_path = upstream / (
        "intent_construction/retrospective_expansion/counterfactual/"
        "generate_counterfactuals.py"
    )
    counter_node, counter_source = _find_symbol(
        counter_path, "CounterfactualGenerator", "generate_counterfactuals"
    )
    _assert_fragments(
        "CounterfactualGenerator.generate_counterfactuals",
        counter_source,
        [
            "self.generate_counterfactual_argument(",
            '"counterfactual_arguments"',
            '"counterfactual_info"',
            "ThreadPoolExecutor(",
        ],
    )

    predecessor_path = upstream / (
        "intent_construction/retrospective_expansion/predecessor/"
        "generate_predecessors.py"
    )
    chain_node, chain_source = _find_symbol(
        predecessor_path, "PredecessorGenerator", "_generate_chain"
    )
    escalation_node, escalation_source = _find_symbol(
        predecessor_path, "PredecessorGenerator", "_generate_single_predecessor"
    )
    _assert_fragments(
        "PredecessorGenerator._generate_chain",
        chain_source,
        [
            "next_function=current_function",
            "next_arguments=current_arguments",
            'current_function = result["predecessor_function"]',
            'current_arguments = result["full_arguments"]',
        ],
    )
    _assert_fragments(
        "PredecessorGenerator._generate_single_predecessor",
        escalation_source,
        [
            "attempt >= self.max_attempts // 2",
            "model = self.fallback_model",
            'step="predecessor-function-generation"',
        ],
    )

    scheduler_path = upstream / "situated_simulation/turn_scheduler.py"
    schedule_node, schedule_source = _find_symbol(
        scheduler_path, "schedule_events"
    )
    create_node, create_source = _find_symbol(scheduler_path, "create_sample")
    trajectory_node, trajectory_source = _find_symbol(
        scheduler_path, "build_change_plan"
    )
    render_node, render_source = _find_symbol(scheduler_path, "render_turns")
    _assert_fragments(
        "create_sample",
        create_source,
        [
            "min_turns = 1 + actual_g + actual_p",
            "schedule_events(",
            "fill_arguments(",
            "fill_texts(",
            "render_turns(",
            "build_change_plan(",
        ],
    )
    _assert_fragments(
        "build_change_plan",
        trajectory_source,
        ["UserIntent(", "IntentTransition(", "intent_trajectory=trajectory"],
    )
    _assert_fragments(
        "render_turns",
        render_source,
        ["# 1. Function text", "# 2. Correction text", "# 3. Arguments/reveals"],
    )

    swe_path = upstream / "situated_simulation/turn_scheduler_swe.py"
    strip_node, strip_source = _find_symbol(swe_path, "_strip_symptoms")
    hook_node, hook_source = _find_symbol(swe_path, "_make_inject_hook")
    swe_node, swe_source = _find_symbol(swe_path, "create_sample_swe")
    _assert_fragments(
        "_strip_symptoms",
        strip_source,
        ['c.get("category") == "symptom"', 'c.get("category") != "symptom"'],
    )
    _assert_fragments(
        "_make_inject_hook",
        hook_source,
        [
            "_repair_phase_leaks(",
            "_redistribute_within_phase(",
            "target_slot.arguments.insert(",
            "slot.arguments.sort(key=_sort_key)",
        ],
    )
    _assert_fragments(
        "create_sample_swe",
        swe_source,
        [
            "_strip_symptoms(raw)",
            "_make_inject_hook(",
            'kwargs["post_fill_hook"] = hook',
            "create_sample(stripped, *args, **kwargs)",
        ],
    )

    return [
        {
            "stage": "extraction",
            "upstream_term": "function + argument extraction",
            "source": str(extraction_path.relative_to(upstream)),
            "symbols": [_symbol_receipt(extraction_node, "BaseExtractor.extract")],
            "observable_contract": extraction_calls,
            "provider_generated_output": "unavailable",
        },
        {
            "stage": "argument_counterfactual_expansion",
            "upstream_term": "Argument Counterfactual",
            "source": str(counter_path.relative_to(upstream)),
            "symbols": [
                _symbol_receipt(
                    counter_node, "CounterfactualGenerator.generate_counterfactuals"
                )
            ],
            "observable_contract": [
                "generate each non-injected argument through provider calls",
                "programmatically validate replacement shape",
                "retain accepted variants under counterfactual_arguments",
            ],
            "provider_generated_output": "unavailable",
        },
        {
            "stage": "function_predecessor_escalation",
            "upstream_term": "Function Predecessor",
            "source": str(predecessor_path.relative_to(upstream)),
            "symbols": [
                _symbol_receipt(chain_node, "PredecessorGenerator._generate_chain"),
                _symbol_receipt(
                    escalation_node,
                    "PredecessorGenerator._generate_single_predecessor",
                ),
            ],
            "observable_contract": [
                "condition each predecessor on the immediate successor",
                "carry predecessor full_arguments into the next reverse step",
                "switch to fallback_model after half of max_attempts",
                "reverse accepted predecessors into chronological order",
            ],
            "provider_generated_output": "unavailable",
        },
        {
            "stage": "trajectory_construction",
            "upstream_term": "ChangePlan / UserIntent",
            "source": str(scheduler_path.relative_to(upstream)),
            "symbols": [
                _symbol_receipt(trajectory_node, "build_change_plan"),
            ],
            "observable_contract": [
                "one UserIntent snapshot per retained user turn",
                "one IntentTransition between adjacent snapshots",
                "the final target_answer is the source ground truth",
            ],
        },
        {
            "stage": "turn_scheduling_and_rendering",
            "upstream_term": "plan-first turn scheduler",
            "source": str(scheduler_path.relative_to(upstream)),
            "symbols": [
                _symbol_receipt(schedule_node, "schedule_events"),
                _symbol_receipt(create_node, "create_sample"),
                _symbol_receipt(render_node, "render_turns"),
            ],
            "observable_contract": [
                "minimum turns equals 1 + actual switches + actual revisions",
                "select, schedule, fill arguments, fill text, then render",
                "within-turn order is function, correction, reveals",
            ],
        },
        {
            "stage": "swe_overlay",
            "upstream_term": "SWE-bench Verified-specific scheduling overlay",
            "source": str(swe_path.relative_to(upstream)),
            "symbols": [
                _symbol_receipt(strip_node, "_strip_symptoms"),
                _symbol_receipt(hook_node, "_make_inject_hook"),
                _symbol_receipt(swe_node, "create_sample_swe"),
            ],
            "observable_contract": [
                "strip category=symptom before generic scheduling",
                "install a post_fill_hook",
                "repair cross-phase ownership and redistribute within phases",
                "insert symptoms at index zero before the final canonical sort",
                "sort recognized categories before stripped symptom IDs",
            ],
        },
    ]


def _bird_sql_reproducibility(upstream: Path) -> dict[str, Any]:
    path = upstream / (
        "intent_construction/retrospective_expansion/counterfactual/"
        "generate_counterfactuals_sql.py"
    )
    symbols: list[dict[str, Any]] = []
    for symbol, method in [
        ("SQLCounterfactualGenerator", "generate_counterfactual"),
        ("SQLCounterfactualGenerator", "generate_having_counterfactuals"),
        ("SQLCounterfactualGenerator", "generate_limit_counterfactuals"),
    ]:
        node, source = _find_symbol(path, symbol, method)
        _assert_fragments(f"{symbol}.{method}", source, ["random.shuffle("])
        symbols.append(_symbol_receipt(node, f"{symbol}.{method}"))

    main_node, main_source = _find_symbol(path, "main")
    _assert_fragments(
        "generate_counterfactuals_sql.main",
        main_source,
        [
            '"--num_workers", type=int, default=4',
            "random.seed(args.seed)",
            "as_completed(futures)",
            "results.append(result)",
        ],
    )
    symbols.append(_symbol_receipt(main_node, "main"))
    return {
        "classification": "nondeterministic_unless_mechanically_constrained",
        "source": str(path.relative_to(upstream)),
        "symbols": symbols,
        "observations": [
            "global random.shuffle selects candidate order",
            "the CLI seeds the global RNG once",
            "the CLI defaults to four worker threads",
            "parallel results append in future completion order",
            "seed alone does not fix output order",
        ],
        "required_constraints": [
            "fixed input and database bytes",
            "fixed seed",
            "fixed worker count and runtime behavior",
            "fixed provider behavior for later stages",
            "canonical output ordering before identity or byte comparison",
        ],
    }


def _contract_probe() -> dict[str, Any]:
    """Return a synthetic probe, not a provider-generated benchmark record."""
    return {
        "task_id": "contract-probe",
        "question": "contract-probe",
        "function": "SOURCE_FUNCTION",
        "answer": "#### 42",
        "arguments": [
            {
                "argument_id": 1,
                "argument": "SOURCE_ARGUMENT_1",
                "counterfactual_arguments": [
                    {"counterfactual_argument": "COUNTERFACTUAL_1A"},
                    {"counterfactual_argument": "COUNTERFACTUAL_1B"},
                ],
            },
            {
                "argument_id": 2,
                "argument": "SOURCE_ARGUMENT_2",
                "counterfactual_arguments": [
                    {"counterfactual_argument": "COUNTERFACTUAL_2A"}
                ],
            },
            {"argument_id": 3, "argument": "SOURCE_ARGUMENT_3"},
        ],
        # Upstream stores nearest first. select_functions reverses this list.
        "predecessor_functions": [
            {
                "predecessor_function": "NEAR_PREDECESSOR",
                "is_predecessor": True,
                "counterfactual_arguments": [
                    {
                        "argument_id": 1,
                        "argument": "SOURCE_ARGUMENT_1",
                        "is_shared": True,
                    },
                    {
                        "argument_id": 2,
                        "argument": "NEAR_ARGUMENT_2",
                        "is_shared": False,
                    },
                ],
            },
            {
                "predecessor_function": "FAR_PREDECESSOR",
                "is_predecessor": True,
                "counterfactual_arguments": [
                    {
                        "argument_id": 1,
                        "argument": "SOURCE_ARGUMENT_1",
                        "is_shared": True,
                    },
                    {
                        "argument_id": 2,
                        "argument": "FAR_ARGUMENT_2",
                        "is_shared": False,
                    },
                ],
            },
        ],
    }


def _swe_overlay_probe(
    scheduler: Any,
    swe: Any,
    *,
    function_prefix: Any,
    correction_prefix: Any,
    reveal_prefix: Any,
    reveal_after_function: Any,
    correction_after_reveal: Any,
    new_info_prefix: Any,
    join: Any,
) -> dict[str, Any]:
    """Execute the pinned hook and renderer on deliberately misplaced arguments."""
    raw = {
        "function": "SOURCE.",
        "arguments": [
            {"argument_id": 1, "argument": "SOURCE_TRIGGER", "category": "trigger"},
            {"argument_id": 2, "argument": "SOURCE_LOCATION", "category": "location"},
            {
                "argument_id": 3,
                "argument": "SOURCE_CONSTRAINT",
                "category": "constraint",
            },
            {"argument_id": 90, "argument": "SOURCE_SYMPTOM", "category": "symptom"},
        ],
        "predecessor_functions": [
            {
                "predecessor_function": "PREDECESSOR.",
                "is_predecessor": True,
                "counterfactual_arguments": [
                    {
                        "argument_id": 101,
                        "argument": "PG_APPROACH",
                        "category": "approach",
                    },
                    {
                        "argument_id": 102,
                        "argument": "PG_LOCATION",
                        "category": "location",
                    },
                    {
                        "argument_id": 103,
                        "argument": "PG_CONSTRAINT",
                        "category": "constraint",
                    },
                    {
                        "argument_id": 190,
                        "argument": "PG_SYMPTOM_A",
                        "category": "symptom",
                    },
                    {
                        "argument_id": 191,
                        "argument": "PG_SYMPTOM_B",
                        "category": "symptom",
                    },
                ],
            }
        ],
    }
    stripped, target_symptoms, predecessor_symptoms = swe._strip_symptoms(raw)
    selected_functions = stripped["predecessor_functions"]
    source_arguments = stripped["arguments"]
    slots = [
        scheduler.TurnSlot(
            0,
            events=[scheduler.TurnEvent(type="function_init", function_idx=0)],
            arguments=[
                scheduler.ArgumentItem(1, "LEAKED_SOURCE_TRIGGER", True),
                scheduler.ArgumentItem(101, "PG_APPROACH"),
                scheduler.ArgumentItem(102, "PG_LOCATION"),
            ],
        ),
        scheduler.TurnSlot(1),
        scheduler.TurnSlot(
            2,
            events=[scheduler.TurnEvent(type="function_change", function_idx=-1)],
            arguments=[
                scheduler.ArgumentItem(103, "LEAKED_PG_CONSTRAINT"),
                scheduler.ArgumentItem(3, "SOURCE_CONSTRAINT"),
                scheduler.ArgumentItem(2, "SOURCE_LOCATION"),
            ],
        ),
    ]
    before_argument_ids = [
        [item.cond_id for item in slot.arguments] for slot in slots
    ]
    hook = swe._make_inject_hook(
        target_symptoms,
        predecessor_symptoms,
        stripped["function"],
    )
    hook(
        slots,
        stripped,
        selected_functions,
        source_arguments,
        set(),
        {},
        {item["argument_id"]: item for item in source_arguments},
    )
    after_argument_ids = [
        [item.cond_id for item in slot.arguments] for slot in slots
    ]
    after_argument_texts = [
        [item.text for item in slot.arguments] for slot in slots
    ]
    scheduler.fill_texts(
        slots,
        selected_functions,
        stripped["function"],
        {},
        {item["argument_id"]: item for item in source_arguments},
    )
    rendered_turns, _ = scheduler.render_turns(
        slots,
        selected_functions,
        True,
        get_function_change_prefix=function_prefix,
        get_correction_prefix=correction_prefix,
        get_reveal_prefix=reveal_prefix,
        get_reveal_after_function_prefix=reveal_after_function,
        get_corr_after_reveal_prefix=correction_after_reveal,
        get_new_info_prefix=new_info_prefix,
        join_prefix_content=join,
    )
    return {
        "probe_kind": "synthetic_slot_probe",
        "provider_output": False,
        "before_argument_ids": before_argument_ids,
        "after_argument_ids": after_argument_ids,
        "after_argument_texts": after_argument_texts,
        "rendered_turns": rendered_turns,
        "phase_owned_ids": {
            "predecessor": sorted(
                item
                for slot in after_argument_ids[:2]
                for item in slot
                if item < 190
            ),
            "source": [item for item in after_argument_ids[2] if item < 90],
        },
        "symptom_positions": [
            [index for index, item in enumerate(slot) if item in {90, 190, 191}]
            for slot in after_argument_ids
        ],
        "observed_order_note": (
            "The hook inserts symptoms at index zero, then its canonical sort "
            "uses the stripped raw record. Stripped symptom IDs have no category "
            "entry and therefore sort after recognized categories."
        ),
    }


def _scheduler_probe(upstream: Path) -> dict[str, Any]:
    sys.path.insert(0, str(upstream))
    try:
        scheduler = importlib.import_module("situated_simulation.turn_scheduler")
        swe = importlib.import_module("situated_simulation.turn_scheduler_swe")

        def function_prefix(**_: Any) -> str:
            return "[FUNCTION]"

        def correction_prefix(**_: Any) -> str:
            return "[CORRECTION]"

        def reveal_prefix(**_: Any) -> str:
            return "[REVEAL]"

        def reveal_after_function(**_: Any) -> str:
            return "[AFTER_FUNCTION]"

        def correction_after_reveal(**_: Any) -> str:
            return "[AFTER_REVEAL]"

        def new_info_prefix(**_: Any) -> str:
            return "[NEW_INFO]"

        def join(prefix: str, content: str) -> str:
            return f"{prefix} {content}"

        sample = scheduler.create_sample(
            _contract_probe(),
            g=2,
            p=2,
            t=7,
            mode="eval",
            domain="math",
            get_function_change_prefix=function_prefix,
            get_correction_prefix=correction_prefix,
            get_reveal_prefix=reveal_prefix,
            get_reveal_after_function_prefix=reveal_after_function,
            get_corr_after_reveal_prefix=correction_after_reveal,
            get_new_info_prefix=new_info_prefix,
            join_prefix_content=join,
        )
        if sample is None:
            raise CharacterizationError("pinned scheduler rejected its contract probe")
        change_plan = sample.metadata["change_plan"]

        return {
            "probe_kind": "synthetic_contract_probe",
            "provider_output": False,
            "parameters": {"mode": "eval", "g": 2, "p": 2, "requested_t": 7},
            "turns": [turn["content"] for turn in sample.turns],
            "actual_t": sample.metadata["num_turns"],
            "scenario": sample.metadata["scenario"],
            "functions": [
                intent["function"] for intent in change_plan["intent_trajectory"]
            ],
            "revealed_ids": [
                intent["revealed_ids"] for intent in change_plan["intent_trajectory"]
            ],
            "active_values": [
                intent["active_values"] for intent in change_plan["intent_trajectory"]
            ],
            "transition_types": [
                transition["type"] for transition in change_plan["transitions"]
            ],
            "final_label": change_plan["final_label"],
            "swe_overlay": _swe_overlay_probe(
                scheduler,
                swe,
                function_prefix=function_prefix,
                correction_prefix=correction_prefix,
                reveal_prefix=reveal_prefix,
                reveal_after_function=reveal_after_function,
                correction_after_reveal=correction_after_reveal,
                new_info_prefix=new_info_prefix,
                join=join,
            ),
        }
    finally:
        sys.path.pop(0)
        for name in list(sys.modules):
            if name == "situated_simulation" or name.startswith("situated_simulation."):
                del sys.modules[name]


def _index_receipts(upstream: Path) -> dict[str, Any]:
    receipts: dict[str, Any] = {}
    for dataset, expected_count in EVAL_INDEX_COUNTS.items():
        rel = f"intent_construction/eval_indices/{dataset}_eval_ids.json"
        payload = json.loads((upstream / rel).read_text(encoding="utf-8"))
        if payload["num_samples"] != expected_count:
            raise CharacterizationError(
                f"{dataset} declares {payload['num_samples']}, expected {expected_count}"
            )
        if len(payload["samples"]) != expected_count:
            raise CharacterizationError(
                f"{dataset} has {len(payload['samples'])} IDs, expected {expected_count}"
            )
        receipts[dataset] = {
            "count": expected_count,
            "eval_ids_path": rel,
            "source_file_claim": payload["source_file"],
            "generated_source_present_at_pin": (upstream / payload["source_file"]).exists(),
        }
    return receipts


def collect(upstream: Path) -> dict[str, Any]:
    upstream = upstream.resolve()
    revision = _git(upstream, "rev-parse", "HEAD")
    if revision != PINNED_REVISION:
        raise CharacterizationError(
            f"revision mismatch: got {revision}, expected {PINNED_REVISION}"
        )
    tree = _git(upstream, "rev-parse", "HEAD^{tree}")
    if tree != PINNED_TREE:
        raise CharacterizationError(f"tree mismatch: got {tree}, expected {PINNED_TREE}")
    if _git(upstream, "status", "--porcelain"):
        raise CharacterizationError("upstream checkout is dirty")

    sources: dict[str, dict[str, str]] = {}
    for relative_path, (expected_blob, expected_sha256) in PINNED_FILES.items():
        path = upstream / relative_path
        if not path.is_file():
            raise CharacterizationError(f"missing pinned file: {relative_path}")
        blob = _git(upstream, "rev-parse", f"HEAD:{relative_path}")
        sha256 = _sha256(path)
        if blob != expected_blob or sha256 != expected_sha256:
            raise CharacterizationError(
                f"source mismatch for {relative_path}: "
                f"blob={blob}, sha256={sha256}"
            )
        sources[relative_path] = {
            "git_blob_sha1": blob,
            "sha256": sha256,
        }

    return _seal_receipt({
        "schema": "parallax.microsoft-evolving-intent-characterization.v1",
        "repository": "https://github.com/microsoft/evolving-intent",
        "revision": revision,
        "tree": tree,
        "license": "MIT",
        "sources": sources,
        "contracts": _source_contracts(upstream),
        "bird_sql_reproducibility": _bird_sql_reproducibility(upstream),
        "scheduler_probe": _scheduler_probe(upstream),
        "published_eval_indices": _index_receipts(upstream),
        "generated_assets": GENERATED_ASSET_STATUS,
        "claim_limits": [
            "The scheduler probe is synthetic and characterizes code contracts only.",
            "No provider-generated extraction, counterfactual, predecessor, or final dataset is present.",
            "No paper result, model response, or byte-identical dataset reproduction is claimed.",
        ],
    })


def _validate_probe(probe: dict[str, Any]) -> None:
    if probe["probe_kind"] != "synthetic_contract_probe" or probe["provider_output"]:
        raise CharacterizationError("scheduler receipt mislabels the contract probe")
    if probe["parameters"] != {"mode": "eval", "g": 2, "p": 2, "requested_t": 7}:
        raise CharacterizationError("scheduler probe parameters drifted")
    if probe["scenario"] != "combined" or probe["actual_t"] != 6:
        raise CharacterizationError("scheduler structure drifted")
    if probe["transition_types"] != [
        "argument_change",
        "function_change",
        "argument_reveal",
        "function_change",
        "argument_change",
    ]:
        raise CharacterizationError("transition schedule drifted")
    if probe["functions"][0] != "FAR_PREDECESSOR":
        raise CharacterizationError("predecessor order is not farthest-first")
    if probe["functions"][-1] != "SOURCE_FUNCTION":
        raise CharacterizationError("trajectory did not restore the source function")
    if probe["active_values"][-1] is not None:
        raise CharacterizationError("trajectory did not restore source argument values")
    if probe["revealed_ids"][-1] != [1, 2, 3] or probe["final_label"] != "42":
        raise CharacterizationError("trajectory did not restore the terminal anchor")
    expected_turns = [
        "FAR_PREDECESSOR COUNTERFACTUAL_1A",
        "[CORRECTION] SOURCE_ARGUMENT_1",
        "[FUNCTION] NEAR_PREDECESSOR",
        "[REVEAL] COUNTERFACTUAL_2A",
        "[FUNCTION] SOURCE_FUNCTION [AFTER_FUNCTION] SOURCE_ARGUMENT_3",
        "[CORRECTION] SOURCE_ARGUMENT_2",
    ]
    if probe["turns"] != expected_turns:
        raise CharacterizationError("deterministic-prefix render receipt drifted")
    if probe["swe_overlay"] != {
        "probe_kind": "synthetic_slot_probe",
        "provider_output": False,
        "before_argument_ids": [[1, 101, 102], [], [103, 3, 2]],
        "after_argument_ids": [[102, 101, 190], [103, 191], [1, 2, 3, 90]],
        "after_argument_texts": [
            ["PG_LOCATION", "PG_APPROACH", "PG_SYMPTOM_A"],
            ["LEAKED_PG_CONSTRAINT", "PG_SYMPTOM_B"],
            [
                "SOURCE_TRIGGER",
                "SOURCE_LOCATION",
                "SOURCE_CONSTRAINT",
                "SOURCE_SYMPTOM",
            ],
        ],
        "rendered_turns": [
            "PREDECESSOR. PG_LOCATION PG_APPROACH PG_SYMPTOM_A",
            "[REVEAL] LEAKED_PG_CONSTRAINT PG_SYMPTOM_B",
            (
                "[FUNCTION] SOURCE. [AFTER_FUNCTION] SOURCE_TRIGGER "
                "SOURCE_LOCATION SOURCE_CONSTRAINT SOURCE_SYMPTOM"
            ),
        ],
        "phase_owned_ids": {
            "predecessor": [101, 102, 103],
            "source": [1, 2, 3],
        },
        "symptom_positions": [[2], [1], [3]],
        "observed_order_note": (
            "The hook inserts symptoms at index zero, then its canonical sort "
            "uses the stripped raw record. Stripped symptom IDs have no category "
            "entry and therefore sort after recognized categories."
        ),
    }:
        raise CharacterizationError("SWE overlay receipt drifted")


def verify_receipt(receipt_path: Path) -> dict[str, Any]:
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    embedded_digest = receipt.get("canonical_sha256")
    computed_digest = hashlib.sha256(_canonical_receipt_bytes(receipt)).hexdigest()
    if embedded_digest != computed_digest:
        raise CharacterizationError("canonical receipt digest mismatch")
    if embedded_digest != PINNED_RECEIPT_SHA256:
        raise CharacterizationError("receipt does not match the pinned canonical digest")
    if receipt.get("revision") != PINNED_REVISION:
        raise CharacterizationError("receipt revision is not pinned")
    if receipt.get("tree") != PINNED_TREE:
        raise CharacterizationError("receipt tree is not pinned")
    sources = receipt.get("sources", {})
    if set(sources) != set(PINNED_FILES):
        raise CharacterizationError("receipt source set drifted")
    for path, (blob, sha256) in PINNED_FILES.items():
        if sources[path] != {"git_blob_sha1": blob, "sha256": sha256}:
            raise CharacterizationError(f"receipt hash drifted for {path}")
    stages = [entry["stage"] for entry in receipt.get("contracts", [])]
    if stages != [
        "extraction",
        "argument_counterfactual_expansion",
        "function_predecessor_escalation",
        "trajectory_construction",
        "turn_scheduling_and_rendering",
        "swe_overlay",
    ]:
        raise CharacterizationError("source contract stages drifted")
    _validate_probe(receipt["scheduler_probe"])
    for dataset, expected_count in EVAL_INDEX_COUNTS.items():
        index = receipt["published_eval_indices"][dataset]
        if index["count"] != expected_count:
            raise CharacterizationError(f"{dataset} eval-index count drifted")
        if index["generated_source_present_at_pin"]:
            raise CharacterizationError(
                f"{dataset} unexpectedly claims a committed generated source"
            )
        if receipt["generated_assets"][dataset] != GENERATED_ASSET_STATUS[dataset]:
            raise CharacterizationError(f"{dataset} unavailable behavior drifted")
    return receipt


def asset_status(receipt: dict[str, Any], dataset: str, asset: str) -> dict[str, str]:
    if dataset not in receipt["generated_assets"]:
        raise CharacterizationError(f"unknown adapter: {dataset}")
    if asset not in receipt["generated_assets"][dataset]:
        raise CharacterizationError(f"unknown generated asset: {asset}")
    status = receipt["generated_assets"][dataset][asset]
    return {"adapter": dataset, "asset": asset, "status": status}


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    refresh = subparsers.add_parser("refresh")
    refresh.add_argument("--upstream", type=Path, required=True)
    refresh.add_argument("--output", type=Path, required=True)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--receipt", type=Path, required=True)

    asset = subparsers.add_parser("asset")
    asset.add_argument("--receipt", type=Path, required=True)
    asset.add_argument("--adapter", choices=sorted(EVAL_INDEX_COUNTS), required=True)
    asset.add_argument(
        "--asset",
        choices=sorted(next(iter(GENERATED_ASSET_STATUS.values()))),
        required=True,
    )

    args = parser.parse_args()
    try:
        if args.command == "refresh":
            receipt = collect(args.upstream)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(receipt, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            print(json.dumps({"status": "ok", "output": str(args.output)}))
            return 0
        if args.command == "verify":
            verify_receipt(args.receipt)
            print(json.dumps({"status": "ok", "receipt": str(args.receipt)}))
            return 0
        receipt = verify_receipt(args.receipt)
        result = asset_status(receipt, args.adapter, args.asset)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"] == "available" else 3
    except (CharacterizationError, OSError, subprocess.CalledProcessError) as error:
        print(json.dumps({"status": "error", "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
