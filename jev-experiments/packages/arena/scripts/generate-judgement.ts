/**
 * Writes the judgement bank: 75 café order checks and 75 routing decisions from fixed seeds.
 * Order items are kept so that about half meet every request and half break exactly one.
 * Refuses to overwrite a bank that has been recorded against.
 *
 *   bun jev-experiments/packages/arena/scripts/generate-judgement.ts [--force]
 */
import { existsSync, writeFileSync } from "node:fs";
import type { Bank, Item } from "../src/checkable/items";
import { orderItem } from "../src/checkable/order";
import { routeItem } from "../src/checkable/route";

const out = new URL("../src/checkable/judgement-bank.json", import.meta.url);
const recording = new URL("../recordings/judgement.jsonl", import.meta.url);

if (existsSync(recording) && !process.argv.includes("--force"))
  throw Error("Jev has been recorded against this bank. Do not regenerate it.");

const order: Item[] = [];
let meets = 0,
  breaks = 0;

for (let seed = 1; order.length < 75; seed++) {
  const item = orderItem(seed);

  if (!item) continue;
  const ok = item.truth.meets_all === true;

  if (ok ? meets >= 38 : breaks >= 37) continue;
  if (ok) meets++;
  else breaks++;
  order.push(item);
}

const route: Item[] = Array.from({ length: 75 }, (_, i) => routeItem(i + 1));

const bank: Bank = {
  schema: "checkable.bank/1",
  generatedWith: "scripts/generate-judgement.ts: orderItem and routeItem from seed 1 upward",
  items: [...order, ...route],
};

writeFileSync(out, `${JSON.stringify(bank)}\n`);

const teams = new Map<string, number>();

for (const r of route) teams.set(String(r.truth.team), (teams.get(String(r.truth.team)) ?? 0) + 1);

console.log(
  `${order.length} orders (${meets} meet all, ${breaks} break one; ${order.filter((i) => i.difficulty > 0).length} harder), ${route.length} routes (${route.filter((i) => i.difficulty > 0).length} hard):`,
  Object.fromEntries(teams),
);
