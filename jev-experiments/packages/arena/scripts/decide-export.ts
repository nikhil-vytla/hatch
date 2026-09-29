/**
 * Writes every Decide request (decision × setup) to .cache/decide/requests.json, for recorders
 * outside TypeScript (record-decide-laya.py). The requests are exactly what the page shows.
 *
 *   bun jev-experiments/packages/arena/scripts/decide-export.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { DECK, requestFor } from "../src/decide/deck";

const dir = new URL("../../../.cache/decide/", import.meta.url);

mkdirSync(dir, { recursive: true });

const requests = Object.fromEntries(
  DECK.flatMap((d) => d.setups.map((s) => [`${d.id}:${s.id}`, requestFor(d, s)])),
);

writeFileSync(new URL("requests.json", dir), JSON.stringify(requests, null, 1));
console.log(`${Object.keys(requests).length} requests.`);
