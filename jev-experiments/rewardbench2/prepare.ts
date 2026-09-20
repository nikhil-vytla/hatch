import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DATASET_REVISION, SCORER_REVISION } from "./protocol";
import { hashText } from "./publication";
import { createHash } from "node:crypto";

const cache = resolve(import.meta.dir, "../.cache/rewardbench2");
mkdirSync(cache, { recursive: true });
const expected =
  "c8ec60efbd75d2f9dcba4121e6101f7a6015abc38a34e034ae2c7ae886265958";
async function download(url: string, name: string) {
  const path = resolve(cache, name);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok)
      throw Error(`Download failed: ${response.status} for ${name}`);
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  }
  return readFileSync(path);
}
const [parquet, scorer] = await Promise.all([
  download(
    `https://huggingface.co/datasets/allenai/reward-bench-2/resolve/${DATASET_REVISION}/data/test-00000-of-00001.parquet`,
    "test.parquet",
  ),
  download(
    `https://raw.githubusercontent.com/allenai/reward-bench/${SCORER_REVISION}/rewardbench/utils.py`,
    "rewardbench_utils.py",
  ),
]);
if (
  hashText(scorer.toString("utf8")) !==
  "56b32e5a56af46716de3308537d9ba7bbd3ac3db07face66f4b10bd6ed38d7db"
)
  throw Error("Upstream scorer checksum mismatch");
if (createHash("sha256").update(parquet).digest("hex") !== expected)
  throw Error("Dataset checksum mismatch");
const python =
  process.env.RB2_PYTHON ?? resolve(import.meta.dir, "../.venv/bin/python");
const converted = spawnSync(
  python,
  [
    "-c",
    `import json, sys
import pyarrow.parquet as pq
rows = pq.read_table(sys.argv[1]).to_pylist()
assert len(rows) == 1865
assert len({(str(r['subset']), str(r['id'])) for r in rows}) == 1865
with open(sys.argv[2], 'w') as out:
    json.dump(rows, out)
`,
    resolve(cache, "test.parquet"),
    resolve(cache, "dataset.json"),
  ],
  { encoding: "utf8" },
);
if (converted.status !== 0)
  throw Error(
    converted.stderr || "Install pyarrow in RB2_PYTHON's environment",
  );
writeFileSync(
  resolve(cache, "sources.json"),
  JSON.stringify(
    {
      dataset: DATASET_REVISION,
      parquet_sha256: expected,
      scorer: SCORER_REVISION,
      scorer_sha256: hashText(scorer.toString("utf8")),
    },
    null,
    2,
  ),
);
console.log(
  "Prepared 1,865 pinned RewardBench 2 cases. Downloaded sources stay in the ignored cache.",
);
