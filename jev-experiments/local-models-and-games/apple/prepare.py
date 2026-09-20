"""Fetch pinned Laya weights and typed-decisions data into the ignored cache."""

import json
from pathlib import Path
from huggingface_hub import snapshot_download, hf_hub_download

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "apple-decisions"
MODEL = "convaiinnovations/laya"
REV = "1c5edc17a7acd8701df6fc341c0d179f1c62c982"
DATA = "LocalLLaMA/typed-decisions"
DREV = "ea9306458d6e9563628369a3d1e72e362fb381d2"
if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        MODEL,
        revision=REV,
        local_dir=CACHE / "base",
        allow_patterns=[
            "model.safetensors",
            "rl_agent_config.json",
            "encoder/config.json",
            "tokenizer/*",
            "README.md",
        ],
    )
    for split in ["train", "test"]:
        path = hf_hub_download(
            DATA,
            f"all/{split}-00000-of-00001.parquet",
            revision=DREV,
            repo_type="dataset",
            local_dir=CACHE / "dataset",
        )
        import pyarrow.parquet as pq

        rows = pq.read_table(path).to_pylist()
        (CACHE / f"{split}.json").write_text(json.dumps(rows, ensure_ascii=False))
        print(split, len(rows), list(rows[0]), flush=True)
    print("Prepared pinned model and dataset", flush=True)
