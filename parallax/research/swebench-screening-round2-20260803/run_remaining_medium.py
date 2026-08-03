from __future__ import annotations

import hashlib
import runpy
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
ROUND_ONE_DRIVER = ROOT.parent / "swebench-screening-run-20260802" / "run_screening.py"
PINNED_PARQUET = Path("/tmp/swebench-verified-91aa3ed.parquet")
PINNED_PARQUET_DIGEST = (
    "43ed5a3d1d98da36472c1ade65ddd2085d7b4ff694fcaf6a023a07c5c1f32f21"
)
PINNED_PARQUET_URL = (
    "https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/"
    "91aa3ed51b709be6457e12d00300a6a596d4c6a3/"
    "data/test-00000-of-00001.parquet"
)
INSTANCE_DIGESTS = {
    "astropy__astropy-8707": (
        "55e63ac83d4ab4a2e1e584adbd7b47f5a2fd43d131fe26d0e12103024915f13b"
    ),
    "django__django-12143": (
        "5ac2fa4efedc1a89f200f034bcee258fd76f334b253b93e8419711998bb9b55b"
    ),
    "django__django-13343": (
        "c9dd0b680810267d008f4d46ffb5b03b0b2d67c93db6d616ec89659855c1c91d"
    ),
    "django__django-13658": (
        "c4f8876b430f754f18253725d8151c0cfff10a03f33d876e8c8e5ccb3846cccf"
    ),
    "django__django-13786": (
        "28706e5b427da7f7d47bedf1df9e5b5f23e730d02f62a56da7ae70cb4998e8e5"
    ),
    "matplotlib__matplotlib-14623": (
        "f003a90c75c476d032019d669cc4dc0a5719a85d194f9d0417ec3be7f6e4fc79"
    ),
    "pydata__xarray-4695": (
        "7ef6875f4261882984f8bf90705f5acbd99151ab45bfabdf97885bf440aaee6f"
    ),
    "pylint-dev__pylint-6528": (
        "5c06fb2da69edf15900ebda1217c485fcddf38a4e6744e1d848f0e311aa5971d"
    ),
    "scikit-learn__scikit-learn-12973": (
        "d70a9c527b829019bd4c7aaeefee75ca8e16278f780d7e56a48341b8799bc081"
    ),
    "scikit-learn__scikit-learn-14087": (
        "5d9fd1159824d0c8f0b96435e3e636951acb41f063198fc1e1881b922727be02"
    ),
    "scikit-learn__scikit-learn-14894": (
        "3f5c8d6ea7cd0ddeca9ad279714ea910a5712288895595ec4fde8dc4eefa2b1f"
    ),
    "sphinx-doc__sphinx-10466": (
        "e018d387e9df8df98e19f26977de07145c3f8ba87c98e9d4ca7888753e925598"
    ),
    "sympy__sympy-15599": (
        "676a2cc13046640663a213f59f95ce42fb8d127febeac42d738e47a01a5dfc2c"
    ),
}


def main() -> None:
    if not PINNED_PARQUET.exists():
        with urllib.request.urlopen(PINNED_PARQUET_URL, timeout=120) as response:
            PINNED_PARQUET.write_bytes(response.read())
    if hashlib.sha256(PINNED_PARQUET.read_bytes()).hexdigest() != PINNED_PARQUET_DIGEST:
        raise ValueError("pinned Verified parquet digest mismatch")
    module = runpy.run_path(ROUND_ONE_DRIVER)
    driver = module["main"]
    driver.__globals__.update(
        {
            "ROOT": ROOT,
            "EVIDENCE": EVIDENCE,
            "WORK": EVIDENCE / "remaining-medium-live-work",
            "CONSTRUCTIONS": EVIDENCE / "remaining-medium-construction.jsonl",
            "SCREENING": EVIDENCE / "remaining-medium-screening.jsonl",
            "SUMMARY": EVIDENCE / "remaining-medium-screening-summary.json",
            "SPEND_CAP_USD": 4.012245,
            "BOUNDARY_MODEL": "claude-opus-4-8",
            "CONSTRUCTION_SEED": 20260803,
            "TRIAL_SEEDS": (2026080321, 2026080322),
            "PREREGISTERED_EPISODE_UPPER_USD": 0.12,
            "FETCH_BATCH_SIZE": 1,
            "PINNED_PARQUET_PATH": PINNED_PARQUET,
            "INSTANCE_DIGESTS": INSTANCE_DIGESTS,
            "INSTANCE_IDS": tuple(INSTANCE_DIGESTS),
        }
    )
    driver()


if __name__ == "__main__":
    main()
