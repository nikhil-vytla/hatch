import json
from huggingface_hub import model_info, snapshot_download
from prepare import CACHE, ROOT

models = [
    "mlx-community/Qwen3-0.6B-4bit",
    "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    "HuggingFaceTB/SmolLM2-360M-Instruct",
]
existing = (
    {
        m["model"]: m["revision"]
        for m in json.loads((ROOT / "local-models-and-games/apple/open-models.json").read_text())
    }
    if (ROOT / "local-models-and-games/apple/open-models.json").exists()
    else {}
)
manifest = []
for repo in models:
    rev = existing.get(repo) or model_info(repo).sha
    name = repo.split("/")[-1]
    path = CACHE / "open-models" / name
    snapshot_download(
        repo,
        revision=rev,
        local_dir=path,
        allow_patterns=["*.safetensors", "*.json", "*.model", "*.jinja", "merges.txt", "vocab.txt"],
    )
    manifest.append({"model": repo, "revision": rev, "folder": name})
    print(repo, rev, flush=True)
(ROOT / "local-models-and-games/apple/open-models.json").write_text(
    json.dumps(manifest, indent=2) + "\n"
)
