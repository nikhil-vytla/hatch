from __future__ import annotations

import runpy
from pathlib import Path

ROOT = Path(__file__).parent
ROUND_ONE_DRIVER = ROOT.parent / "swebench-screening-run-20260802" / "run_screening.py"
INSTANCE_DIGESTS = {
    "matplotlib__matplotlib-22871": (
        "03d760842dc6f2bc2fd313fbfbda8a3994c15305af9c6075f9032697d146a3f2"
    ),
    "mwaskom__seaborn-3069": (
        "3feccf3ece6ca73c10ee665b62679937b7dbc2db28c35c9b4a1f192ed540e2dd"
    ),
    "pydata__xarray-6721": (
        "82a4385a61a1b80eacb889fa79fe7c2f8c1d45a46c9a6c7748040e181a050ba0"
    ),
    "pylint-dev__pylint-7080": (
        "7fce42c811782808fe6d87edc55d39423742727b35128e82ae28a3c209b95fd5"
    ),
    "sympy__sympy-13091": (
        "fe5da0076aaebc81d9a54e2b3a20bfab88fea021a51f14391dc7928386137f1e"
    ),
    "astropy__astropy-14508": (
        "a6aea03ce1c6a2e897e78a4339e44f02643deb9007e0628a058034779181ce71"
    ),
}


def main() -> None:
    module = runpy.run_path(ROUND_ONE_DRIVER)
    driver = module["main"]
    driver.__globals__.update(
        {
            "ROOT": ROOT,
            "EVIDENCE": ROOT / "evidence",
            "WORK": ROOT / "evidence" / "live-work",
            "CONSTRUCTIONS": ROOT / "evidence" / "construction.jsonl",
            "SCREENING": ROOT / "evidence" / "screening.jsonl",
            "SUMMARY": ROOT / "evidence" / "screening-summary.json",
            "SPEND_CAP_USD": 5.0,
            "BOUNDARY_MODEL": "claude-opus-4-8",
            "CONSTRUCTION_SEED": 20260803,
            "TRIAL_SEEDS": (2026080301, 2026080302, 2026080303),
            "PREREGISTERED_EPISODE_UPPER_USD": 0.25,
            "INSTANCE_DIGESTS": INSTANCE_DIGESTS,
            "INSTANCE_IDS": tuple(INSTANCE_DIGESTS),
        }
    )
    driver()


if __name__ == "__main__":
    main()
