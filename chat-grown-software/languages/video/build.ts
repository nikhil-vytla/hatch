// Turn recorded runs into player data.
//   build.ts race <out.json> <title> <speed> <runDir>...      side by side, recorded timestamps
//   build.ts story <out.json> <title> <speed> <runDir>        one run, paced by text
//   build.ts text <out.json> <title> <speed> <file.txt>...    transcripts (showcases), one pane each, paced
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const [mode, out, title, speedArg, ...inputs] = process.argv.slice(2);
const speed = Number(speedArg);
type E = { t: number; kind: string; text: string; score?: string };

function run(dir: string): { title: string; events: E[]; summary: any } {
	const only = process.env.TURNS?.split(",").map(Number); // e.g. TURNS=2 keeps the third turn only
	const events: E[] = readFileSync(`${dir}/events.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e: any) => !only || only.includes(e.turn));
	const summary = existsSync(`${dir}/summary.json`) ? JSON.parse(readFileSync(`${dir}/summary.json`, "utf8")) : {};
	let ok = 0, n = 0;
	for (const e of events) if (e.kind === "goal") { const m = e.text.match(/^(\d+)\/(\d+)/); if (m) { ok += +m[1]; n += +m[2]; e.score = `goal ${ok}/${n}`; } }
	return { title: summary.lang ?? basename(dir), events, summary };
}

const KIND = (line: string): string => {
	if (/^(#|==|---)/.test(line)) return "head";
	if (/\b(REFUSED|REJECTED|FAIL|rejected|refused|killed|error)\b/i.test(line)) return "bad";
	if (/\b(PASS|ACCEPTED|accepted|ok|proved|migrated)\b/.test(line)) return "ok";
	if (/^\s*(\$|>|user>)/.test(line)) return "user";
	return "note";
};

let data: any;
if (mode === "race" || mode === "story") {
	const runs = inputs.map(run);
	const rows = runs.map((r) => `<tr><td>${r.title}</td><td>${r.summary.turns_accepted}/${r.summary.turns}</td><td>${r.summary.goal_ok}/${r.summary.goal_n}</td><td>${r.summary.final_regression}</td><td>${r.summary.develops} (${r.summary.load_errors})</td><td>${r.summary.corrections}</td><td>${r.summary.minutes} min</td></tr>`).join("");
	data = {
		title, mode, speed, cols: runs.length > 4 ? 3 : runs.length,
		sub: `Replay of recorded runs: ${runs[0].summary.model ?? "deepseek-flash"} grows the same expense tracker; a simulated user answers every question. ${mode === "race" ? "Real timing, sped up." : ""}`,
		panes: runs.map((r) => ({ title: r.title, events: mode === "race" ? r.events.filter((e) => e.kind !== "form") : r.events })),
		end: { title: "Results", html: `<table><tr><th>kernel</th><th>turns accepted</th><th>hidden goal checks</th><th>final regression</th><th>develops (didn't load)</th><th>user corrections</th><th>wall time</th></tr>${rows}</table><p>Hidden goal checks: the scenario's own examples, run on the live code after each turn and compared with the intended program. The model never sees them.</p>` },
	};
} else {
	data = {
		title, mode: "story", speed, cols: Math.min(inputs.length, 2), maxChars: 400,
		sub: "Replay of a recorded showcase transcript.",
		panes: inputs.map((f) => ({ title: `${basename(dirname(dirname(f)))}/${basename(f)}`, events: readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => ({ t: 0, kind: KIND(l), text: l })) })),
	};
}
writeFileSync(out, JSON.stringify(data));
console.log(`${out}: ${data.panes.map((p: any) => `${p.title} ${p.events.length} events`).join(", ")}`);
