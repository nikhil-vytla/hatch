#!/usr/bin/env python3
"""Exercise all five delivery slices in a disposable repo, without staging."""
import glob
import ast
import hashlib
import json
import re
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROADMAP = HERE.parents[2]
ROOT = ROADMAP.parents[1]
SLICES = ("runtime", "routing", "training", "playable", "integration")
FORBIDDEN_PARTS = {".cache", ".venv", "node_modules", "__pycache__", ".playwright-cli", ".git", "dist"}


def run(command, cwd=ROOT, accepted=(0,)):
    result = subprocess.run(command, cwd=cwd, capture_output=True)
    if result.returncode not in accepted:
        raise ValueError("Command failed: " + " ".join(command) + "\n" + result.stderr.decode())
    return result.stdout


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def resolve_module(source, request):
    request = request.split("?")[0]
    target = (source.parent / request).resolve()
    choices = [target]
    if target.suffix in (".js", ".mjs"):
        choices.extend(target.with_suffix(suffix) for suffix in (".ts", ".tsx"))
    if not target.suffix:
        choices.extend(Path(str(target) + suffix) for suffix in (".ts", ".tsx", ".js", ".json", ".css"))
        choices.extend(target / ("index" + suffix) for suffix in (".ts", ".tsx", ".js"))
    return next((candidate for candidate in choices if candidate.is_file()), None)


def main():
    patch_path = ROADMAP / "application.patch"
    patch = patch_path.read_bytes()
    assembler = ROADMAP / "delivery/assemble.py"
    assembler_sha = sha(assembler.read_bytes())
    tracked = set(run(["git", "ls-files", "-z"]).decode().split("\0")) - {""}
    expected_patch = run(["git", "diff", "--binary", "HEAD", "--", "jev-experiments", ":(exclude)jev-experiments/roadmap"])
    route = "jev-experiments/experience-prototypes/api/route.ts"
    if route not in tracked:
        expected_patch += run(["git", "diff", "--no-index", "--binary", "--", "/dev/null", route], accepted=(0, 1))
    require(patch == expected_patch, "Application patch is stale")
    patch_files = re.findall(r"^\+\+\+ b/(.+)$", patch.decode(), re.M)
    modified = run(["git", "diff", "--name-only", "HEAD", "--", "jev-experiments", ":(exclude)jev-experiments/roadmap"]).decode().splitlines()
    require(set(patch_files) == set(modified) | {route}, "Patch file coverage mismatch")
    selected_images = set((ROADMAP / "playable/review/artifacts/selected-binaries.txt").read_text().splitlines())
    checkpoint_manifest = json.loads((ROADMAP / "training/checkpoints/manifest.json").read_text())["files"]
    checkpoints = {"jev-experiments/roadmap/training/checkpoints/" + name for name in checkpoint_manifest}
    require(len(selected_images) == 20 and len(checkpoints) == 9, "Unexpected retained artifact count")
    slice_results, delivered, binary_rows, credential_flags = [], {}, [], []
    credential_patterns = {
        "private-key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        "aws-key": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        "provider-key": r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b",
    }
    with tempfile.TemporaryDirectory(prefix="jev-delivery-audit-") as temporary:
        destination = Path(temporary)
        run(["git", "init", "--quiet"], cwd=destination)
        # Only the patch base files are needed to check patch replay. Dependencies
        # are checked against the Git-tracked base plus actual assembled files.
        for path in modified:
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(run(["git", "show", "HEAD:" + path]))
        for name in SLICES:
            output = run(["python3", str(assembler), name, "--destination", str(destination)])
            slice_results.append(json.loads(output))
        for path in sorted((destination / "jev-experiments/roadmap").rglob("*")):
            if not path.is_file():
                continue
            relative = str(path.relative_to(destination))
            data = path.read_bytes()
            require(data == (ROOT / relative).read_bytes(), "Assembled bytes differ: " + relative)
            delivered[relative] = {"bytes": len(data), "sha256": sha(data)}
            try:
                content = data.decode("utf-8")
                for kind, pattern in credential_patterns.items():
                    for match in re.finditer(pattern, content):
                        credential_flags.append({"path": relative, "kind": kind, "line": content[:match.start()].count("\n") + 1})
            except UnicodeDecodeError:
                binary_rows.append({"path": relative, "bytes": len(data)})
        require(all(not FORBIDDEN_PARTS.intersection(Path(path).parts) and ".local." not in Path(path).name
                    and not path.endswith((".pyc", ".log", ".env", ".zip", ".tar", ".tgz", ".mlmodel", ".bin"))
                    and ".mlpackage" not in path for path in delivered), "Excluded cache/log/archive/package was assembled")
        require(selected_images <= delivered.keys(), "Selected image missing")
        require(checkpoints <= delivered.keys(), "Retained checkpoint missing")
        require({path for path in delivered if path.endswith(".safetensors")} == checkpoints, "Unexpected weight file assembled")
        for path in checkpoints:
            record = delivered[path]
            expected = checkpoint_manifest[Path(path).name]
            require(record["sha256"] == expected["sha256"] and record["bytes"] == expected["bytes"], "Checkpoint hash mismatch")
        require(all(record["bytes"] < 2_000_000 for record in binary_rows), "Oversized binary assembled")
        run(["git", "apply", "--check", str(destination / "jev-experiments/roadmap/application.patch")], cwd=destination)
        run(["git", "apply", str(destination / "jev-experiments/roadmap/application.patch")], cwd=destination)
        for path in patch_files:
            require((destination / path).read_bytes() == (ROOT / path).read_bytes(), "Patch replay differs: " + path)
        require(not run(["git", "diff", "--cached", "--name-only"], cwd=destination).strip(), "Temporary index is not empty")

    available = tracked | set(delivered) | set(patch_files)
    source_files = [ROOT / path for path in available if path.endswith((".ts", ".tsx", ".js", ".mjs"))
                    and (path.startswith("jev-experiments/roadmap/") or path.startswith("jev-experiments/experience-prototypes/") or path in patch_files)]
    dependencies, globs, unresolved = [], [], []
    for source in sorted(source_files):
        if not source.is_file() or source.name.endswith(".d.ts"):
            continue
        text = source.read_text()
        requests = set(re.findall(r"\b(?:from|import)\s*[\"'](\.[^\"']+)[\"']", text))
        requests.update(re.findall(r"\bimport\(\s*[\"'](\.[^\"']+)[\"']", text))
        requests.update(re.findall(r"new URL\(\s*[\"'](\.[^\"']+)[\"']\s*,\s*import\.meta\.url", text))
        for request in sorted(requests):
            target = resolve_module(source, request)
            reference = {"source": str(source.relative_to(ROOT)), "request": request}
            if target is None:
                unresolved.append(reference)
                continue
            relative = str(target.relative_to(ROOT))
            reference["target"] = relative
            reference["deliveredOrTracked"] = relative in available
            dependencies.append(reference)
        for match in re.finditer(r"import\.meta\.glob(?:<[^>]+>)?\(\s*(\[[\s\S]*?\]|[\"'][^\"']+[\"'])", text):
            for pattern in re.findall(r"[\"'](\.[^\"']+)[\"']", match.group(1)):
                matches = sorted(str(Path(path).resolve().relative_to(ROOT)) for path in glob.glob(str(source.parent / pattern), recursive=True))
                globs.append({"source": str(source.relative_to(ROOT)), "pattern": pattern, "matches": matches,
                              "missing": [path for path in matches if path not in available]})
    generated_sources = {
        "jev-experiments/live-worlds/crowd/demo.json": ["jev-experiments/live-worlds/crowd/demo.jsonl"],
        "jev-experiments/live-worlds/ghost-brush/examples.json": ["jev-experiments/live-worlds/ghost-brush/recording-manifest.json", "jev-experiments/live-worlds/ghost-brush/recording-events.jsonl"],
    }
    generator = ROOT / "jev-experiments/live-worlds/prepare.ts"
    build_prepare = ROOT / "jev-experiments/experience-prototypes/scripts/prepare.ts"
    package = json.loads((ROOT / "jev-experiments/experience-prototypes/package.json").read_text())
    require(str(generator.relative_to(ROOT)) in tracked and "prepareLiveWorlds();" in build_prepare.read_text()
            and package["scripts"]["build"].startswith("bun scripts/prepare.ts &&"), "Generated import preparation is missing")
    generated_checks = []
    for path, inputs in generated_sources.items():
        require(all(item in available for item in inputs), "Generated import source is missing")
        require("/".join(Path(path).parts[-2:]) in generator.read_text(), "Generator does not name expected output")
        generated_checks.append({"path": path, "generator": str(generator.relative_to(ROOT)), "inputs": inputs,
                                 "inputSha256": {item: sha((ROOT / item).read_bytes()) for item in inputs}})
    missing = [row for row in dependencies if not row["deliveredOrTracked"] and row["target"] not in generated_sources]
    require(not missing and all(not row["missing"] for row in globs), "Dependency omitted from completed delivery: " + json.dumps({"imports": missing, "globs": [row for row in globs if row["missing"]]}))
    mac_source = ast.parse((ROADMAP / "mac/package_sources.py").read_text())
    mac_paths = next(ast.literal_eval(node.value) for node in mac_source.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == "SOURCE_FILES" for target in node.targets))
    mac_files = [str((ROADMAP / "mac" / path).resolve().relative_to(ROOT)) for path in mac_paths]
    require(all(path in available for path in mac_files), "Mac installer source dependency omitted")
    require(sha(assembler.read_bytes()) == assembler_sha and patch_path.read_bytes() == patch, "Reviewed assembly source changed during check")
    result = {
        "recordedAt": datetime.now(timezone.utc).isoformat(), "passed": True,
        "baseCommit": run(["git", "rev-parse", "HEAD"]).decode().strip(), "assemblerSha256": assembler_sha,
        "applicationPatchSha256": sha(patch), "applicationPatchBytes": len(patch), "patchFiles": patch_files,
        "patchMatchesCurrentDiffAndNewRoute": True, "patchReplaysToExactCurrentBytes": True,
        "slices": slice_results, "assembledFileCount": len(delivered),
        "selectedImagePaths": sorted(selected_images), "retainedCheckpointPaths": sorted(checkpoints),
        "binaryFiles": binary_rows, "forbiddenSelectedFiles": [], "credentialPatternFlags": credential_flags,
        "dependencies": dependencies, "globDependencies": globs, "unresolvedLiteralReferences": unresolved,
        "generatedImportDependencies": generated_checks, "macInstallerSourceDependencies": mac_files,
        "selectedFileInventory": {path: value for path, value in delivered.items()
                                  if path != str((HERE / "verification.json").relative_to(ROOT))},
        "inventoryExclusion": "This verifier's own overwritten JSON output is omitted from the per-file hash inventory to avoid a recursive snapshot.",
        "scope": "All five slices assembled without --stage in a disposable initialized Git directory. Patch checked/applied only there. No commits, user-index edits, installs, model calls, browser work or builds.",
        "limits": "Static import/export/literal dynamic-import/new-URL/glob coverage against existing Git base plus actual selected files. This is not a fresh build or a general dataflow analysis of generated filenames. Review artifacts added after the run change the file count; later root changes require their own final assembly check.",
    }
    (HERE / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("passed", "slices", "assembledFileCount", "patchMatchesCurrentDiffAndNewRoute", "patchReplaysToExactCurrentBytes", "unresolvedLiteralReferences")}, indent=2))


if __name__ == "__main__":
    main()
