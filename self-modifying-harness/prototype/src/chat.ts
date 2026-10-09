// An interactive chat with the forge on DeepSeek. One directory is one chat: running it again over the same directory
// resumes the same session, reinstalls the agent-written tools from the catalogue and keeps the OptChat memory.
//
//   node --experimental-strip-types --no-warnings src/chat.ts [dataDir]      (default: data/live; `npm run chat`)
//
// Commands: /usage (spend so far), /cells (the catalogue), /view (the OptChat view the model is shown), /verbose
// (toggle full tool text), /quit. Ctrl-C leaves cleanly. Environment: see the `chat` script in package.json.
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { cachePercent, describeCatalogue, type Live, openLive, show } from "./live.ts";

const dataDir = process.argv[2] ?? join(import.meta.dirname, "..", "data", "live");

function usage(live: Live): string {
	const rows = live.meter.rows.map((r) => `  #${r.n} ${r.kind.padEnd(10)} input ${r.input} cache-read ${r.cacheRead} (${cachePercent(r)}%) output ${r.output} $${r.costUsd.toFixed(5)}`);

	return [...rows, live.meter.summary()].join("\n");
}

const live = await openLive(dataDir);

const lines = createInterface({ input: process.stdin, output: process.stdout });

let verbose = false;

let leaving = false;

const leave = async (): Promise<void> => {
	if (leaving) return;
	leaving = true;
	lines.close();
	await live.close();
	console.log(live.meter.summary());
	process.exit(0);
};

// readline swallows SIGINT while a prompt is open, so listen on both.
process.on("SIGINT", () => void leave());

lines.on("SIGINT", () => void leave());

console.log(`forge chat over ${dataDir} (${live.memory.length} messages so far). /usage /cells /view /verbose /quit`);

for await (const line of lines) {
	const text = line.trim();

	if (text === "") continue;

	if (text === "/quit") break;

	if (text === "/usage") console.log(usage(live));
	else if (text === "/cells") console.log(describeCatalogue(await live.catalogue()));
	else if (text === "/view") console.log(live.memory.render());
	else if (text === "/verbose") {
		verbose = !verbose;
		console.log(`verbose ${verbose ? "on" : "off"}`);
	} else {
		const turn = await live.ask(text, (event) => console.log(show(event, verbose)));

		if (turn.status !== "done") console.log(`  -> ${turn.status} ${turn.reason}`);

		if (turn.capped !== undefined) {
			console.log(turn.capped.message);
			break;
		}
	}
}

await leave();
