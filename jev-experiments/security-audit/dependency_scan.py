"""Query OSV using exact versions in the non-JavaScript lockfiles. No installs."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
packages = []
for name, ecosystem in [("uv.lock", "PyPI"), ("adapters/rust/Cargo.lock", "crates.io")]:
    data = tomllib.loads((ROOT / name).read_text())
    for p in data["package"]:
        if "version" not in p or p["name"] in {"jev-experiments", "jev-schemars-lab"}:
            continue
        packages.append({"package": {"name": p["name"], "ecosystem": ecosystem}, "version": p["version"]})
for line in (ROOT / "adapters/go/go.mod").read_text().splitlines():
    words = line.strip().split()
    if len(words) >= 2 and words[1].startswith("v"):
        packages.append({"package": {"name": words[0], "ecosystem": "Go"}, "version": words[1]})

def request(url, value=None):
    args = ["curl", "--fail", "--silent", "--show-error", "--max-time", "60", url]
    if value is not None:
        args += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
    return json.loads(subprocess.check_output(args, input=None if value is None else json.dumps(value).encode()))

batch = request("https://api.osv.dev/v1/querybatch", {"queries": packages})
matches = [{**p, "vulnerabilities": r.get("vulns", [])} for p, r in zip(packages, batch["results"]) if r.get("vulns")]
ids = sorted({v["id"] for m in matches for v in m["vulnerabilities"]})
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    details = list(pool.map(lambda ident: request("https://api.osv.dev/v1/vulns/" + ident), ids))
report = {"packages_checked": len(packages), "packages_with_advisories": len(matches), "advisory_ids": len(ids), "matches": matches, "advisories": details}
(OUT / "osv-lockfile-results.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"packages_checked": len(packages), "packages_with_advisories": len(matches), "matches": [{"name": m["package"]["name"], "version": m["version"], "advisories": [v["id"] for v in m["vulnerabilities"]]} for m in matches]}, indent=2))
