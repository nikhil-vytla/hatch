/**
 * Writes the checkable item bank: 150 Tetris and 150 grid items from fixed seeds. About half
 * the Tetris items are kept from positions where some landing fills a row, so "fills a row"
 * is not almost always no. Refuses to overwrite a bank that has been recorded against.
 *
 *   bun jev-experiments/packages/arena/scripts/generate-checkable.ts [--force]
 */
import { existsSync, writeFileSync } from "node:fs";
import { gridItem } from "../src/checkable/grid";
import type { Bank, Item } from "../src/checkable/items";
import { tetrisItem } from "../src/checkable/tetris";

const out = new URL("../src/checkable/bank.json", import.meta.url);
const recording = new URL("../recordings/checkable.jsonl", import.meta.url);

if (existsSync(recording) && !process.argv.includes("--force"))
  throw Error("Jev has been recorded against this bank. Do not regenerate it.");

const tetris: Item[] = [];
let plain = 0;

for (let seed = 1; tetris.length < 150; seed++) {
  const item = tetrisItem(seed);

  if (!item) continue;
  const fills = Object.entries(item.truth).some(
    ([k, v]) => k.startsWith("completes_") && v === true,
  );

  if (!fills && plain >= 75) continue;
  if (!fills) plain++;
  tetris.push(item);
}

const grid: Item[] = [];

for (let seed = 1; grid.length < 150; seed++) {
  const item = gridItem(seed);

  if (item) grid.push(item);
}

const bank: Bank = {
  schema: "checkable.bank/1",
  generatedWith: "scripts/generate-checkable.ts: tetrisItem and gridItem from seed 1 upward",
  items: [...tetris, ...grid],
};

writeFileSync(out, `${JSON.stringify(bank)}\n`);
console.log(`${tetris.length} tetris (${150 - plain} with a row to fill), ${grid.length} grid.`);
