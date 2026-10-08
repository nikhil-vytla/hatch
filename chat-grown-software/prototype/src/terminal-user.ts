// You, at the keyboard, as the user of the chat loop (INTERACTIVE=1). You say what you want; when the model calls
// `develop`, the kernel shows what each question's call returns and does to the state, and you confirm it (Enter)
// or type what it should give instead. Only your answers become the contract.
//
// Reads stdin synchronously, so it needs a real terminal (or piped lines).
import { readSync } from "node:fs";
import type { Question } from "./ask.ts";

function readLine(prompt: string): string | undefined {
	process.stdout.write(prompt);
	const bytes: number[] = [];
	const buf = Buffer.alloc(1);
	for (;;) {
		let n: number;
		try {
			n = readSync(0, buf, 0, 1, null);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
			throw e;
		}
		if (n === 0) return bytes.length ? Buffer.from(bytes).toString("utf8") : undefined; // end of input
		if (buf[0] === 0x0a) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
		bytes.push(buf[0]);
	}
}

const HELP = `    Enter = yes, that's right
    t     = it should throw (refuse)
    v <json>      = it should return <json> and leave the state as shown
    {"value": ..., "state": ...} or {"throws": true, "state": ...} = the full answer`;

export class TerminalUser {
	corrections = 0;
	/** The next thing you say; an empty line or end of input ends the chat. */
	says(): string | undefined {
		const line = readLine("\nyou> ");
		return line?.trim() ? line.trim() : undefined;
	}
	/** One answer per question: what the call should return and the state it should leave. */
	answer(qs: Question[]): unknown[] {
		console.log(`\n  The kernel has ${qs.length} question(s) about the proposed code.\n${HELP}`);
		return qs.map((q, i) => {
			const shown = q.answer as { value?: unknown; throws?: boolean; state?: unknown } | string;
			console.log(`\n  [${i + 1}/${qs.length}] ${q.call}\n      on state ${JSON.stringify(q.fixture)}   (${q.why})`);
			console.log(`      it ${typeof shown === "object" && shown.throws ? "THROWS" : `returns ${JSON.stringify(typeof shown === "object" ? shown.value : shown)}`}`);
			if (typeof shown === "object") console.log(`      and leaves state ${JSON.stringify(shown.state)}`);
			for (;;) {
				const line = (readLine("      right? ") ?? "").trim();
				if (line === "") return q.answer;
				this.corrections++;
				const state = typeof shown === "object" ? shown.state : undefined;
				if (line === "t") return { throws: true, state: q.fixture };
				try {
					if (line.startsWith("v ")) return { value: JSON.parse(line.slice(2)), state };
					return JSON.parse(line);
				} catch {
					this.corrections--;
					console.log(`      not JSON; try again.\n${HELP}`);
				}
			}
		});
	}
}
