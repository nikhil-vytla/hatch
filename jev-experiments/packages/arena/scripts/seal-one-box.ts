/**
 * Seals the One box sealed set: the phrases in packages/arena/sealed/one-box-sealed.json and
 * Jev's recorded answers on them (packages/arena/sealed/jev.jsonl, from record-one-box.ts
 * words ...) are encrypted into src/contest/sealed-blob.ts, which is committed. The key is
 * packages/arena/sealed/key (gitignored; created here if missing); on the server it is the
 * ONE_BOX_SEALED_KEY environment variable. Nothing readable leaves the sealed folder.
 *
 *   bun jev-experiments/packages/arena/scripts/seal-one-box.ts
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { seal, sealedSchema, unseal } from "../src/contest/sealed";
import { answersSchema } from "../src/one-box/adapter";
import { phrasesSchema } from "../src/one-box/phrases";

const dir = new URL("../sealed/", import.meta.url);
const keyFile = new URL("key", dir);

if (!existsSync(keyFile))
  writeFileSync(keyFile, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });

const key = readFileSync(keyFile, "utf8").trim();
const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("one-box-sealed.json", dir), "utf8")),
);

const round = (v: number) => Math.round(v * 1000) / 1000;
const jev: Record<string, { latencyMs: number; answers: ReturnType<typeof answersSchema.parse> }> =
  {};

for (const line of readFileSync(new URL("jev.jsonl", dir), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row: { status?: string; key?: string; latencyMs?: number; answers?: object } =
    JSON.parse(line);

  if (row.status !== "ok" || !row.key || row.latencyMs === undefined) continue;
  const answers = answersSchema.parse(row.answers);

  for (const a of Object.values(answers)) {
    if (a.probabilities)
      a.probabilities = Object.fromEntries(
        Object.entries(a.probabilities).map(([k, v]) => [k, round(v)]),
      );
    if (a.confidence !== null && a.confidence !== undefined) a.confidence = round(a.confidence);
  }

  jev[row.key] = { latencyMs: row.latencyMs, answers };
}

const sealed = sealedSchema.parse({
  schema: "one-box.sealed/1",
  sealedAt: new Date().toISOString(),
  phrases: doc.phrases.map((p) => ({
    id: p.id,
    text: p.text,
    intent: p.intent,
    acceptable: p.acceptable,
    kind: p.kind,
  })),
  jev,
});

const blob = seal(sealed, key);

// Round-trip before writing, so a bad seal never lands.
if (unseal(blob, key).phrases.length !== sealed.phrases.length)
  throw new Error("Seal did not round-trip.");

writeFileSync(
  new URL("../src/contest/sealed-blob.ts", import.meta.url),
  `/** The sealed One box set, encrypted (see sealed.ts and scripts/seal-one-box.ts). Not readable without the key. */\nexport const SEALED_BLOB =\n  "${blob}";\n`,
);
console.log(
  `Sealed ${sealed.phrases.length} phrases and ${Object.keys(jev).length} recorded Jev answers (${Math.round(blob.length / 1024)} KB).`,
);
