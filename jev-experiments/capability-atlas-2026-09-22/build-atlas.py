"""Build a self-contained, provider-free visual from the audited catalog."""

import hashlib
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
catalog = json.loads((HERE / "catalog-snapshot.json").read_text())
records = []
for source in ("playable-audit.json", "tooling-audit.json", "training-audit.json"):
    records.extend(json.loads((HERE / source).read_text())["records"])
assert len({record["id"] for record in records}) == len(records) == len(catalog)
assert {record["id"] for record in records} == {entry["id"] for entry in catalog}
by_id = {record["id"]: record for record in records}
ordered = []
for entry in catalog:
    record = by_id[entry["id"]]
    record.update({key: entry[key] for key in ("title", "category")})
    for question in record["questions"]:
        question["count_note"] = ""
        if isinstance(question["primitives"], list):
            count = question["count"]
            names = " + ".join(question["primitives"])
            question["primitives"] = names
            question["count_note"] = f"{count} question" + ("" if count == 1 else "s") if isinstance(count, int) else str(count)
    for evidence in record["evidence"]:
        path = ROOT / evidence["path"]
        assert path.is_file(), evidence["path"]
        evidence["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    ordered.append(record)
atlas = {
    "schema_version": 1,
    "audited_at": "2026-09-22",
    "scope": "Current catalog and working-tree call sites. Execution modes describe available code paths; no new provider runs were made for this audit.",
    "source_bindings": [
        {"path": path, "sha256": hashlib.sha256((ROOT / path).read_bytes()).hexdigest()}
        for path in ("jev-experiments/experience-prototypes/src/main.tsx", "jev-experiments/experience-prototypes/src/catalog.ts")
    ],
    "records": ordered,
}
(HERE / "atlas.json").write_text(json.dumps(atlas, indent=2, ensure_ascii=False) + "\n")
data = json.dumps(atlas, ensure_ascii=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
css = (HERE / "atlas.css").read_text()
script = (HERE / "atlas.js").read_text()
html = """<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Where Jev does the work</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='3' fill='%2324634c'/%3E%3Ctext x='11' y='23' fill='%23f5f4ef' font-size='23' font-family='Georgia'%3Ej%3C/text%3E%3C/svg%3E">
<style>__CSS__</style>
<div class="shell">
<header class="masthead"><a href="https://jev-experiments.vercel.app">Jev experiments / notebook</a><span>IMPLEMENTATION AUDIT<br>22 SEPTEMBER 2026</span></header>
<main>
<h1>Where Jev does the work.</h1>
<p class="lead">Follow a decision from the information the model sees to the change the code makes. Each experiment has a different division of work.</p>
<p class="note">41 entries from the local catalog, including work not yet deployed.</p>
<div class="finding"><p>We explore all three primitives. Native structured instructions and criteria are blocked by our wrappers. Preserving that part of the API is the first priority.</p></div>
<nav class="nav" aria-label="Atlas views"><button type="button" data-panel="experiments" aria-pressed="true">Experiments</button><button type="button" data-panel="structure" aria-pressed="false">The missing structure</button><button type="button" data-panel="studies" aria-pressed="false">Where to go deeper</button></nav>
<section class="workspace" data-view="experiments">
<aside class="finder" aria-label="Find an experiment">
<label for="search">Find an experiment or capability</label><input id="search" type="search" placeholder="Try probabilities or music">
<label for="category">Category</label><select id="category"><option value="">All categories</option></select>
<p id="count" class="count" aria-live="polite"></p><div class="experiment-list" id="experiment-list"></div>
</aside><article class="detail" id="detail" aria-label="Selected experiment"></article><p id="selection-status" class="sr-only" aria-live="polite"></p>
</section>
<section class="essay" data-view="structure" hidden>
<h2>The shape of the question matters.</h2>
<p>JSON in <code>state</code> gives Jev context. A structured criterion describes the meaning of an answer. Our current wrappers allow the first and reject the second.</p>
<p>This authored example asks whether a proposed edit stays within a task. Both forms carry the same information. The structured version is an interface example, with no model result attached.</p>
<div class="compare"><section><h3>Flat description</h3><pre>{
  "type": "choice",
  "instructions": "Classify the edit scope.",
  "criteria": {
    "within_scope": "Fixes only the requested bug; includes a focused test. Excludes unrelated refactors.",
    "expanded_scope": "Changes unrelated behavior or dependencies. Excludes a test needed for the fix."
  }
}</pre></section><section><h3>Native structure</h3><pre>{
  "type": "choice",
  "instructions": {"question": "Classify the edit scope."},
  "criteria": {
    "within_scope": {
      "definition": "Fixes only the requested bug",
      "includes": ["a focused test"],
      "excludes": ["unrelated refactors"]
    },
    "expanded_scope": {
      "definition": "Changes unrelated behavior or dependencies",
      "excludes": ["a test needed for the fix"]
    }
  }
}</pre></section></div>
<p>Descriptive Score levels and Noul's true/false criteria need the same preservation. The common runtime also needs a distinct expected Score value; picking the most likely level changes its meaning.</p>
<p>Structure may help, or may add cost without improving the result. Test equal information against held-out cases. Read <a href="https://docs.typesafe.ai/primitives/advanced">TypeSafe AI's advanced structure documentation</a> and <a href="https://docs.typesafe.ai/primitives/score">Score semantics</a>.</p>
</section>
<section class="essay" data-view="studies" hidden>
<h2>Go deeper before adding more tiles.</h2>
<p>A longer request is not a better experiment. Each next study should isolate a capability and measure what it changes.</p>
<div class="study"><span class="number">01</span><div><h3>Preserve the native contract</h3><p>Carry rich criterion descriptions, explicit boolean boundaries and descriptive Score levels through every adapter. Keep expected score, distributions and confidence distinct. Reject unsupported local shapes explicitly.</p><p class="scope">Foundation · app gateway, Python, TypeScript, CLI and MCP</p></div></div>
<div class="study"><span class="number">02</span><div><h3>Ask the same question three ways</h3><p>Compare prose, JSON serialized as text and native structure with equivalent information. Start with paste and verification. Freeze labels and test cases; measure accuracy, review coverage, timing and cost.</p><p class="scope">Controlled extension · Smart paste, Agent verifier, judgments</p></div></div>
<div class="study"><span class="number">03</span><div><h3>Let uncertainty change the path</h3><p>Keep several candidate branches when a taxonomy split is close. Ask for clarification when an answer lacks evidence. Compare complete task outcomes at matched action coverage.</p><p class="scope">Deeper behavior · icons, visual search, adaptive forms, browser intent</p></div></div>
<div class="study"><span class="number">04</span><div><h3>Separate the model from the controller</h3><p>Hold queues, worlds and execution policy fixed. Compare Jev with simple controls and attribute their contributions. Routing's default web path is currently heuristic; that should be visible.</p><p class="scope">Causal comparisons · routing, Tetris, crowd and music</p></div></div>
<p class="note">These are proposed studies. The atlas records implementation and existing evidence; it does not claim new model results.</p>
</section>
</main>
<footer><span>Not affiliated with or endorsed by TypeSafe AI</span><button id="download-atlas" type="button">Download the audit data</button></footer>
</div><script type="application/json" id="atlas-data">__DATA__</script><script>__SCRIPT__</script></html>
"""
html = html.replace("__CSS__", css).replace("__DATA__", data).replace("__SCRIPT__", script)
(HERE / "show-me-jev-capabilities.html").write_text(html)
print(json.dumps({"experiments": len(ordered), "html_bytes": len(html.encode())}))
