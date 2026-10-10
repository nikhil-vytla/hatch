// The interactive chat loop, split out of src/chat.ts so both the thin `npm run chat` entry and src/start.ts (the
// `./forge` command) drive an already-open forge the same way: one line in, one turn out, with /usage, /cells, /view,
// /verbose and /quit. Opening the forge (models, data directory, limits) is the caller's job. `usageRow` is exported
// because the TUI's `/usage` and footer reuse the same one-row-per-request format.
import { createInterface } from "node:readline/promises";
import { cachePercent, describeCatalogue, type Live, type UsageRow, show } from "./live.ts";

/** One meter row, the same line both the plain loop and the TUI's `/usage` append. */
export function usageRow(r: UsageRow): string {
	return `  #${r.n} ${r.kind.padEnd(10)} input ${r.input} cache-read ${r.cacheRead} (${cachePercent(r)}%) output ${r.output} $${r.costUsd.toFixed(5)}`;
}

function usage(live: Live): string {
	return [...live.meter.rows.map(usageRow), live.meter.summary()].join("\n");
}

/** Read lines from stdin until /quit, Ctrl-C or end of input, then close the forge and print the spend. */
export async function runChat(live: Live): Promise<void> {
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

	console.log(`forge chat (${live.memory.length} messages so far). /usage /cells /view /verbose /quit`);

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
}
