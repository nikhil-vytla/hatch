"""Ask the requested reviewer about a small, explicit design-only snapshot."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
JEV = HERE.parent
MODEL = "amazon-bedrock/global.anthropic.claude-fable-5-1"
files = {
    "DESIGN.md": JEV / "DESIGN.md",
    "editorial-study.html": HERE / "editorial-study.html",
    "editorial-study.css": HERE / "editorial-study.css",
    "editorial-study.ts": HERE / "editorial-study.ts",
    "engine.ts": JEV / "roadmap/materials/engine.ts",
    "additional-references.md": HERE / "additional-references.md",
    "reference-observations.md": HERE / "references/README.md",
    "desktop.webp": HERE / "output/playwright/editorial-desktop.webp",
    "mobile.webp": HERE / "output/playwright/editorial-mobile.webp",
}
prompt = """Review this original Jev design direction and working editorial study.
Read DESIGN.md, the three editorial-study source files, engine.ts, the reference
observations and both screenshots. You may read files only. Evaluate the visual
composition, taste, useful interaction, clear authorship, accuracy of the material
explanation, mobile/keyboard/reduced-motion behavior and unnecessary complexity.
Prefer a few consequential findings to a generic checklist. Identify source/line
or visible evidence. Separate a verified defect from a suggestion. You have no
browser, so do not claim interactive or accessibility verification from screenshots.
The study is a proposed page, not a shipped application. Do not infer release or
model-quality results. Recommend concrete changes and say what is already worth
keeping. Return concise Markdown, with no machine-specific absolute paths.
"""
snapshot = Path(tempfile.mkdtemp(prefix="jev-design-review-"))
inventory = []
for relative, source in files.items():
    shutil.copyfile(source, snapshot / relative)
    inventory.append({"file": relative, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
permission = {"*": "deny", "read": {"*": "allow", "*.env": "deny", "events.jsonl": "deny", "stderr.log": "deny", "session.json": "deny"}, "glob": "allow", "grep": "allow", "external_directory": "deny"}
config = {"$schema": "https://opencode.ai/config.json", "model": MODEL, "share": "disabled", "snapshot": False, "autoupdate": False, "permission": permission, "agent": {"design-review": {"description": "Read-only design critique", "mode": "primary", "model": MODEL, "steps": 20, "permission": permission}}}
env = os.environ.copy()
env.update(OPENCODE_CONFIG_CONTENT=json.dumps(config), OPENCODE_DISABLE_AUTOUPDATE="true", OPENCODE_DISABLE_LSP_DOWNLOAD="true")
started = time.time()
with (snapshot / "events.jsonl").open("w") as out, (snapshot / "stderr.log").open("w") as err:
    result = subprocess.run(["opencode", "run", "--pure", "--dir", str(snapshot), "--agent", "design-review", "--model", MODEL, "--format", "json", "--title", "Jev editorial design review", prompt], env=env, stdout=out, stderr=err, timeout=900)
rows = []
for line in (snapshot / "events.jsonl").read_text().splitlines():
    try:
        rows.append(json.loads(line))
    except ValueError:
        pass
texts = [row.get("part", {}).get("text", "") for row in rows if row.get("type") == "text"]
sessions = sorted({row["sessionID"] for row in rows if row.get("sessionID")})
models = []
if sessions:
    for _ in range(4):
        time.sleep(2)
        with (snapshot / "session.json").open("w") as out:
            exported = subprocess.run(["opencode", "export", sessions[0]], stdout=out, stderr=subprocess.PIPE, text=True)
        try:
            session = json.loads((snapshot / "session.json").read_text())
            models = [{"provider": item["info"].get("providerID"), "model": item["info"].get("modelID")} for item in session.get("messages", []) if item.get("info", {}).get("role") == "assistant"]
        except (ValueError, KeyError):
            continue
        if models:
            break
if result.returncode or not texts or not models:
    raise SystemExit("Design reviewer did not return verifiable feedback; raw diagnostic files retained locally.")
if any(model != {"provider": "amazon-bedrock", "model": "global.anthropic.claude-fable-5-1"} for model in models):
    raise SystemExit("Unexpected reviewer identity")
answer = "\n\n".join(texts).replace(str(snapshot), "[review workspace]").replace(str(JEV.parent), "[repository]") + "\n"
(HERE / "fable-feedback.md").write_text(answer)
(HERE / "fable-provenance.json").write_text(json.dumps({"requested_model": MODEL, "observed_models": [dict(item) for item in {tuple(model.items()) for model in models}], "reviewed_on": "2026-09-21", "input_files": inventory, "prompt": prompt, "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "answer_sha256": hashlib.sha256(answer.encode()).hexdigest(), "exit_code": result.returncode, "elapsed_seconds": round(time.time() - started, 2), "scope": "Explicit design source, cited observations and two study screenshots. No browser interaction by reviewer."}, indent=2) + "\n")
print("Saved design feedback and verified requested reviewer identity.")
