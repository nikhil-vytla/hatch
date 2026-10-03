/** Run from any directory with Bun. No API calls or dataset downloads. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { readRecord, decodeRecord, encodeRecord } from "../experience-prototypes/scripts/records";
const lab = resolve(import.meta.dir, ".."), app = resolve(lab, "experience-prototypes"), repo = resolve(lab, "..");
const paths = ["results", "experience-prototypes/results"].flatMap(dir => readdirSync(resolve(lab, dir)).filter(name => name.endsWith(".jsonl")).map(name => `${dir}/${name}`));
let unchanged = 0;
for (const path of paths) {
  const document = readRecord(resolve(lab, path));
  assert.deepEqual(decodeRecord(encodeRecord(document)), document);
  const py = execFileSync(resolve(lab, ".venv/bin/python"), ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from jev_lab.records import read_record;print(json.dumps(read_record(sys.argv[2]),ensure_ascii=False))", resolve(lab, "src"), resolve(lab, path)], { maxBuffer: 30_000_000 });
  assert.deepEqual(JSON.parse(py.toString()), document);
  const prior = JSON.parse(execFileSync("git", ["show", `f6926cc:jev-experiments/${path.replace(/\.jsonl$/, ".json")}`], { cwd: repo, maxBuffer: 30_000_000 }).toString());
  if (path === "experience-prototypes/results/classify.jsonl") {
    for (const [name, group] of Object.entries(prior.result.experiments) as any) {
      const next = document.result.experiments[name];
      assert.equal(next.rows.length, group.rows.length);
      group.rows.forEach((row: any, i: number) => {
        for (const field of ["id", "prediction", "target", "probabilities", "answers", "error", "recovery"]) assert.deepEqual(next.rows[i][field], row[field]);
        assert.equal(typeof next.rows[i].text, "string");
      });
    }
  } else { assert.deepEqual(document, prior); unchanged++; }
}
execFileSync("bun", ["scripts/prepare.ts"], { cwd: app });
const publication = JSON.parse(readFileSync(resolve(app, "publication.json"), "utf8"));
let snapshotMatches = 0;
for (const name of Object.keys(publication)) {
  const generated = JSON.parse(readFileSync(resolve(app, `public/data/${name}.json`), "utf8"));
  const snapshot = resolve(app, `.cache/pre-jsonl-public/${name}.json`);
  if (existsSync(snapshot)) { assert.deepEqual(generated, JSON.parse(readFileSync(snapshot, "utf8"))); snapshotMatches++; }
}
const unlisted = resolve(app, "public/data/private-publication-test.json");
assert(!existsSync(unlisted));
try {
  writeFileSync(unlisted, "{}");
  let rejected = false;
  try { execFileSync("bun", ["scripts/prepare.ts"], { cwd: app, stdio: "pipe" }); } catch { rejected = true; }
  assert(rejected, "unlisted public files must fail the build");
} finally { unlinkSync(unlisted); }
const report = { jsonl_files: paths.length, exact_original_documents: unchanged, classification_preserves_predictions_and_adds_published_text: true, all_typescript_python_roundtrips_equal: true, public_json_files: Object.keys(publication).length, pre_migration_snapshot_matches: snapshotMatches, publication_allowlist_rejects_unlisted_files: true };
writeFileSync(resolve(import.meta.dir, "evidence-verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
