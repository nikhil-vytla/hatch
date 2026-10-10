// The "try it for real" experiment: a fresh forge on any chosen model, a fixed script of four user messages about growing
// a tool, upgrading it, using it and asking where it came from. Nothing is tuned to make it pass: whatever the model does
// with the harness (rejected proposals, malformed arguments, refusals) is printed as it happened.
//
//   node --experimental-strip-types --no-warnings src/live-run.ts [--model provider/modelId] [--data DIR]   (`npm run live-run`)
//
// Writes results/live-<provider>-run.txt (everything printed) and results/live-<provider>-usage.json (one row per model
// request: kind, input, cache-read and output tokens, cost). The models come from src/model-config.ts, so the flags,
// environment and auto-pick are the same as `./forge`; a run with no configured credential exits instead of pretending
// to be a demo. The run has its own spending limits (LIVE_MAX_CALLS, LIVE_MAX_COST_USD).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachePercent, describeCatalogue, openLive, show, type UsageRow } from "./live.ts";
import { chooseModels, describeModel, flagValue } from "./model-config.ts";

const root = join(import.meta.dirname, "..");

const argv = process.argv.slice(2);

const choice = await chooseModels({ env: process.env, argv });

if (choice.kind === "error") {
	console.error(choice.message);
	process.exit(1);
}

if (choice.kind === "demo") {
	console.error(`no model configured (${choice.why}); live-run needs a real model`);
	process.exit(1);
}

const dataDir = flagValue(argv, "--data") ?? join(root, "data", "live-run");

const SCRIPT = [
	"I want to log how many cups of coffee I drink and see the total. Just added 2.",
	"Track decaf separately from regular, please. I had a decaf.",
	"What's my breakdown?",
	"Why does the coffee tool track decaf? Who asked for that?",
];

const printed: string[] = [];

const out = (text: string): void => {
	printed.push(text);
	console.log(text);
};

const limit = (name: string, fallback: number): number => {
	const raw = process.env[name];

	return raw === undefined ? fallback : Number(raw);
};

rmSync(dataDir, { recursive: true, force: true });

const live = await openLive(dataDir, { limits: { maxCalls: limit("LIVE_MAX_CALLS", 100), maxCostUsd: limit("LIVE_MAX_COST_USD", 0.3) }, turn: choice.turn, summary: choice.summary });

out(`limits: ${live.meter.limits.maxCalls} model calls or $${live.meter.limits.maxCostUsd}, whichever first; turn ${describeModel(choice.turn)}, summary ${describeModel(choice.summary)}`);

const perMessage: { message: string; rows: UsageRow[] }[] = [];

for (const [k, text] of SCRIPT.entries()) {
	out(`\nuser ${k + 1}> ${text}`);
	const from = live.meter.rows.length;
	const turn = await live.ask(text, (event) => out(show(event, false)));
	out(`  -> ${turn.status}${turn.reason === "" ? "" : ` ${turn.reason}`}`);
	await live.memory.idle(); // the compactions this turn caused, so their rows land in this turn's slice
	perMessage.push({ message: text, rows: live.meter.rows.slice(from) });

	if (turn.capped !== undefined) {
		out(`STOPPED: ${turn.capped.message}`);
		break;
	}
}

await live.memory.idle();

out(`\n=== catalog ===\n${describeCatalogue(await live.catalogue())}`);

out(`\n=== OptChat view (${live.memory.length} messages in ${live.memory.view.length} lines, ${live.memory.viewBytes()} bytes) ===\n${live.memory.render()}`);

out("\n=== usage per request (input = cache misses) ===");

const header = `${"#".padStart(3)} ${"msg".padEnd(3)} ${"kind".padEnd(10)} ${"input".padStart(7)} ${"cache-read".padStart(10)} ${"output".padStart(7)} ${"cache%".padStart(7)} ${"cost".padStart(9)}`;

out(header);

for (const [k, slice] of perMessage.entries()) {
	for (const r of slice.rows) out(`${String(r.n).padStart(3)} ${String(k + 1).padEnd(3)} ${r.kind.padEnd(10)} ${String(r.input).padStart(7)} ${String(r.cacheRead).padStart(10)} ${String(r.output).padStart(7)} ${String(cachePercent(r)).padStart(7)} ${`$${r.costUsd.toFixed(5)}`.padStart(9)}`);
}

out(`\n${live.meter.summary()}`);

await live.close();

const providerId = choice.turn.model.provider;

mkdirSync(join(root, "results"), { recursive: true });

writeFileSync(join(root, "results", `live-${providerId}-run.txt`), `${printed.join("\n")}\n`);

const usage = { model: describeModel(choice.turn), summaryModel: describeModel(choice.summary), limits: live.meter.limits, totals: live.meter.totals(), turns: live.meter.totals("turn"), compactions: live.meter.totals("compaction"), perMessage: perMessage.map((m, k) => ({ n: k + 1, message: m.message, rows: m.rows })) };

writeFileSync(join(root, "results", `live-${providerId}-usage.json`), `${JSON.stringify(usage, null, "\t")}\n`);
