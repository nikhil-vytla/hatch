/**
 * Fetches the openly licensed prompt-injection data Screen sentry trains and tests on, and writes
 * it as one compact file, real.jsonl: { text, injection, source, split }.
 *
 *   bun live-worlds/sentry/data/fetch.ts
 *
 * Licences were checked at each source on 3 Oct 2026; see SOURCES.md. Splits keep each source's
 * own train/test split where it has one; otherwise a fixed hash of the text picks about 30% for
 * test. Nothing here comes from Jev: TypeSafe's MCA §2.3(b) forbids training on its outputs.
 */
import { writeFileSync } from "node:fs";

export type Row = { text: string; injection: boolean; source: string; split: "train" | "test" };

const HF = "https://datasets-server.huggingface.co/rows";
const RAW = "https://raw." + "githubusercontent.com";

/** FNV-1a of the text, so a row's split never changes between runs. */
function hashed(s: string) {
  let h = 0x811c9dc5;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0) / 4294967296;
}

const testBy = (key: string): "train" | "test" => (hashed(key) < 0.3 ? "test" : "train");

async function hfRows(dataset: string, split: string) {
  const out: Record<string, unknown>[] = [];

  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`${HF}?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=100`);

    if (!r.ok) throw new Error(`${dataset} ${split}: HTTP ${r.status}`);

    const j = (await r.json()) as { rows: { row: Record<string, unknown> }[]; num_rows_total: number };

    out.push(...j.rows.map((x) => x.row));

    if (offset + 100 >= j.num_rows_total) return out;
  }
}

/** Only English-looking, page-sized text: the sentry reads one block of a web page at a time. */
const usable = (t: unknown): t is string => typeof t === "string" && t.length >= 8 && t.length <= 600;

async function deepset(): Promise<Row[]> {
  const rows: Row[] = [];

  for (const split of ["train", "test"] as const)
    for (const r of await hfRows("deepset/prompt-injections", split))
      if (usable(r.text)) rows.push({ text: r.text, injection: r.label === 1, source: "deepset", split });

  return rows;
}

async function gandalf(): Promise<Row[]> {
  const rows: Row[] = [];

  for (const split of ["train", "validation", "test"])
    for (const r of await hfRows("Lakera/gandalf_ignore_instructions", split))
      if (usable(r.text)) rows.push({ text: r.text, injection: true, source: "gandalf", split: split === "test" ? "test" : "train" });

  return rows;
}

async function jailbreaks(): Promise<Row[]> {
  const rows: Row[] = [];

  for (const split of ["train", "test"] as const)
    for (const r of await hfRows("jackhhao/jailbreak-classification", split))
      if (usable(r.prompt)) rows.push({ text: r.prompt, injection: r.type === "jailbreak", source: "jailbreak", split });

  return rows;
}

/**
 * InjecAgent: attacker instructions that were planted inside tool output (product reviews, emails,
 * notes), plus the harmless string fields of the same tool responses. That is our setting: an
 * instruction embedded in content the helper reads. Split by text so a held-out instruction never
 * appears in training.
 */
async function injecagent(): Promise<Row[]> {
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const f of ["attacker_cases_dh.jsonl", "attacker_cases_ds.jsonl"]) {
    const text = await (await fetch(`${RAW}/uiuc-kang-lab/InjecAgent/main/data/${f}`)).text();

    for (const line of text.trim().split("\n")) {
      const a = JSON.parse(line) as { "Attacker Instruction": string };
      const t = a["Attacker Instruction"];

      if (usable(t) && !seen.has(t)) {
        seen.add(t);
        rows.push({ text: t, injection: true, source: "injecagent", split: testBy(t) });
      }
    }
  }

  const users = (await (await fetch(`${RAW}/uiuc-kang-lab/InjecAgent/main/data/user_cases.jsonl`)).text()).trim().split("\n");

  for (const line of users) {
    const u = JSON.parse(line) as { "Tool Response Template": string };

    // The templates are Python-ish dict literals; take the quoted string values that read as prose.
    for (const m of u["Tool Response Template"].matchAll(/'([^']{12,400})'/g)) {
      const t = m[1];

      if (t.includes("<Attacker Instruction>") || !/\s/.test(t) || seen.has(t)) continue;

      seen.add(t);
      rows.push({ text: t, injection: false, source: "injecagent", split: testBy(t) });
    }
  }

  return rows;
}

if (import.meta.main) {
  const all = [...(await deepset()), ...(await gandalf()), ...(await jailbreaks()), ...(await injecagent())];

  writeFileSync(new URL("./real.jsonl", import.meta.url), all.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const count: Record<string, string> = {};

  for (const s of new Set(all.map((r) => r.source))) {
    const of = (split: string, inj: boolean) => all.filter((r) => r.source === s && r.split === split && r.injection === inj).length;

    count[s] = `train ${of("train", true)} inj / ${of("train", false)} benign · test ${of("test", true)} inj / ${of("test", false)} benign`;
  }

  console.log(JSON.stringify(count, null, 1));
}
