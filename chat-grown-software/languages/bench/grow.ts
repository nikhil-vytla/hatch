// A model grows the expense tracker in one language kernel, chatting with the simulated user.
//
//   node --experimental-strip-types --no-warnings bench/grow.ts <lang> [--out results/<name>]
//   (MODEL defaults to deepseek: DeepSeek through its OpenAI-style API; NODE_USE_ENV_PROXY=1 behind a proxy)
//
// Per turn: the user's message -> the model calls observe / try / develop / execute -> develop's proposed calls
// become questions (plus repetition and coverage questions), the kernel shows what the candidate does, the
// simulated user answers from the JS reference program, only those answers go to the kernel's gates.
// After each turn a hidden goal check runs the scenario's own examples on the live code (the model never sees them).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, Message, Model, ToolDef } from "../../prototype/src/chat.ts";
import { DeepSeekModel } from "../../prototype/src/model-deepseek.ts";
import { KernelClient, ROOT } from "./kernel-client.ts";
import { type Call, fixture, intended, type Outcome, type Question, SCENARIO, SCENARIO_NAME, same, show } from "./reference.ts";

const lang = process.argv[2];
if (!lang) throw new Error("usage: grow.ts <lang> [--out dir]");
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? process.argv[outArg + 1] : join(ROOT, "results", `${SCENARIO_NAME}-${lang}`);
mkdirSync(out, { recursive: true });
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 10);

const call = { type: "object", properties: { fn: { type: "string" }, args: { type: "array", items: {} } }, required: ["fn", "args"] };
const question = { type: "object", properties: { fixture: { type: "object", description: "the state to start from, e.g. {} or {\"expenses\": [...]}" }, calls: { type: "array", items: call, description: "calls run in order; the outcome is the last call's value and the final state" } }, required: ["fixture", "calls"] };
const TOOLS: ToolDef[] = [
	{ name: "observe", description: "The live world: generation, revision, every function's source, and the state.", input_schema: { type: "object", properties: {} } },
	{ name: "try", description: "Preview: what your forms would do on some calls, without changing anything and without asking the user.", input_schema: { type: "object", properties: { forms: { type: "array", items: { type: "string" } }, questions: { type: "array", items: question } }, required: ["forms", "questions"] } },
	{
		name: "develop",
		description: "Propose a change: forms (function definitions in the kernel's language) plus example calls. The kernel shows the user what each example (and a few calls it adds) actually returns and does to the state; the user confirms or corrects; only the user's answers become the contract. Then the kernel's gates decide.",
		input_schema: { type: "object", properties: { generation: { type: "integer", description: "the generation you observed" }, intent: { type: "string" }, scope: { type: "array", items: { type: "string" }, description: "snake_case names of the functions this request is about" }, forms: { type: "array", items: { type: "string" } }, removes: { type: "array", items: { type: "string" } }, examples: { type: "array", items: question }, laws: { type: "array", items: { type: "object", properties: { name: { type: "string" }, check: { type: "string" } } }, description: "optional, only if the kernel notes say laws are supported" } }, required: ["generation", "intent", "scope", "forms", "examples"] },
	},
	{ name: "execute", description: "Run one call on the live app for real (it changes the live state).", input_schema: { type: "object", properties: { call, request_id: { type: "string" } }, required: ["call"] } },
];
const SYSTEM = `You grow a small app by changing its code while it runs, one chat request at a time. The app lives in a kernel; you change it only through the tools.

- Observe first, and pass the generation you saw to develop.
- Name functions exactly as the user does (snake_case). Calls in examples are JSON: {"fn": "total", "args": []}, never code.
- Propose examples that show the user what you built. You never say what the right answer is: the user does. If the user corrects an answer, make the code do what the user said.
- A change is done only when develop says accepted. If it is rejected, read why, fix it and develop again.
- When done, tell the user in one or two sentences what changed. Don't ask questions back; decide sensibly.

How to write code for this kernel:
${readFileSync(existsSync(join(ROOT, lang, `prompt-${SCENARIO_NAME}.md`)) ? join(ROOT, lang, `prompt-${SCENARIO_NAME}.md`) : join(ROOT, lang, "prompt.md"), "utf8")}`;

type Event = { t: number; turn: number; kind: string; text: string };
const t0 = Date.now();
const events: Event[] = [];
const log = (turn: number, kind: string, text: string) => {
	const e = { t: Date.now() - t0, turn, kind, text };
	events.push(e);
	appendFileSync(join(out, "events.jsonl"), `${JSON.stringify(e)}\n`);
	console.log(`${kind.padEnd(8)} ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
};
rmSync(join(out, "events.jsonl"), { force: true });

const model: Model & { usage?: { calls: number; prompt: number; completion: number } } = await DeepSeekModel.create();
const dir = mkdtempSync(join(tmpdir(), `grow-${lang}-`));
const k = new KernelClient(lang, dir);
await k.request({ op: "observe" });

type TurnStats = { turn: number; accepted: boolean; develops: number; rejected: Record<string, number>; load_errors: number; corrections: number; goal: string; goal_ok: number; goal_n: number; ms: number };
const stats: TurnStats[] = [];
let rid = 0;
const seenArgs = new Map<string, unknown[][]>();

/** Questions for a proposal: the model's calls, each state-changing one repeated, and a call for every uncovered function in scope. */
function questionsFor(examples: Question[], scope: string[], outcomes: Outcome[]): Question[] {
	const qs = examples.map((e) => ({ fixture: e.fixture ?? {}, calls: e.calls ?? [] }));
	examples.forEach((e, i) => {
		const o = outcomes[i];
		const last = e.calls?.at(-1);
		if (last && o?.state !== undefined && !same(o.state, e.fixture ?? {})) qs.push({ fixture: e.fixture ?? {}, calls: [...e.calls, last] });
	});
	const covered = new Set(qs.flatMap((q) => q.calls.map((c) => c.fn)));
	for (const fn of scope) if (!covered.has(fn)) qs.push({ fixture: fixture(Object.keys(SCENARIO.fixtures)[0]), calls: [{ fn, args: seenArgs.get(fn)?.[0] ?? [] }] });
	return qs;
}

async function handle(turn: number, name: string, input: any, st: TurnStats): Promise<unknown> {
	switch (name) {
		case "observe":
			return k.request({ op: "observe" });
		case "try":
			return k.request({ op: "try", forms: input.forms ?? [], removes: input.removes ?? [], questions: input.questions ?? [] });
		case "develop": {
			st.develops++;
			for (const e of input.examples ?? []) for (const c of e.calls ?? []) if (c?.fn) seenArgs.set(c.fn, [...(seenArgs.get(c.fn) ?? []), c.args ?? []]);
			const proposed: Question[] = input.examples ?? [];
			const first = await k.request({ op: "try", forms: input.forms ?? [], removes: input.removes ?? [], questions: proposed });
			if (!first.ok) { st.load_errors++; log(turn, "load", first.error); return { status: "rejected", failed: [{ layer: "static", detail: first.error }] }; }
			const qs = questionsFor(proposed, input.scope ?? [], first.outcomes);
			const shown = await k.request({ op: "try", forms: input.forms ?? [], removes: input.removes ?? [], questions: qs });
			const answers = qs.map((q) => intended(turn, q));
			const asked = qs.map((q, i) => ({ calls: q.calls, fixture: q.fixture, candidate: shown.outcomes[i], user: same(shown.outcomes[i], answers[i]) ? "yes" : answers[i] }));
			const corrected = asked.filter((a) => a.user !== "yes");
			st.corrections += corrected.length;
			log(turn, "ask", `${qs.length} questions, user corrected ${corrected.length}${corrected.length ? `: ${corrected.slice(0, 3).map((c) => `${c.calls.map((x) => `${x.fn}(${x.args.map((a) => JSON.stringify(a)).join(", ")})`).join("; ")} should be ${show(c.user)}`).join(" | ")}` : ""}`);
			const r = await k.request({ op: "develop", generation: input.generation, intent: input.intent ?? "", scope: input.scope ?? [], forms: input.forms ?? [], removes: input.removes ?? [], laws: input.laws ?? [], examples: qs.map((q, i) => ({ ...q, expect: answers[i] })), asked: { message: turn, text: SCENARIO.turns[turn].user } });
			for (const f of r.failed ?? []) st.rejected[f.layer] = (st.rejected[f.layer] ?? 0) + 1;
			if (r.status === "accepted") st.accepted = true;
			log(turn, "develop", `[${(input.scope ?? []).join(", ")}] -> ${r.status}${r.revision ? ` (${r.revision})` : ""}${r.failed?.length ? `: ${r.failed.map((f: any) => `${f.layer}: ${String(f.detail).slice(0, 160)}`).join("; ")}` : ""}`);
			return { ...r, user_answers: asked.map((a) => ({ calls: a.calls, fixture: a.fixture, your_code_gave: a.candidate, user: a.user === "yes" ? "yes, that's right" : { should_be: a.user } })) };
		}
		case "execute": {
			const r = await k.request({ op: "execute", call: input.call, request_id: input.request_id ?? `m-${++rid}` });
			log(turn, "execute", `${input.call?.fn}(${(input.call?.args ?? []).map((a: unknown) => JSON.stringify(a)).join(", ")}) => ${show(r)}`);
			return r;
		}
		default:
			throw new Error(`no tool ${name}`);
	}
}

const messages: Message[] = [];
for (const [turn, spec] of SCENARIO.turns.entries()) {
	const started = Date.now();
	const st: TurnStats = { turn: turn + 1, accepted: false, develops: 0, rejected: {}, load_errors: 0, corrections: 0, goal: "", goal_ok: 0, goal_n: 0, ms: 0 };
	log(turn, "user", spec.user);
	messages.push({ role: "user", content: spec.user });
	for (let step = 0; step < MAX_STEPS; step++) {
		let reply: { content: Block[]; stop: string };
		try {
			reply = await model.next(SYSTEM, messages, TOOLS);
		} catch (e) {
			log(turn, "error", String((e as Error).message));
			break;
		}
		messages.push({ role: "assistant", content: reply.content });
		for (const b of reply.content) if (b.type === "text" && String((b as any).text).trim()) log(turn, "model", String((b as any).text).trim());
		const calls = reply.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
		if (calls.length === 0 || reply.stop !== "tool_use") break;
		const results: Block[] = [];
		for (const c of calls) {
			if (c.name === "develop" || c.name === "try") for (const f of (c.input.forms as string[]) ?? []) log(turn, "form", f);
			let content: string;
			let isError = false;
			try {
				content = JSON.stringify(await handle(turn, c.name, c.input, st));
			} catch (e) {
				content = String((e as Error).message);
				isError = true;
			}
			results.push({ type: "tool_result", tool_use_id: c.id, content, ...(isError ? { is_error: true } : {}) });
		}
		messages.push({ role: "user", content: results });
		if (step === MAX_STEPS - 1) {
			// keep the transcript well-formed: the model must answer the tool results before the next user message
			messages.push({ role: "assistant", content: [{ type: "text", text: "(out of steps for this request)" }] });
			log(turn, "model", "(out of steps for this request)");
		}
	}
	// hidden goal check: the scenario's own examples on the live code, against the intended program
	const qs: Question[] = spec.examples.map((e: any) => ({ fixture: fixture(e.fixture), calls: e.calls as Call[] }));
	const got = await k.request({ op: "try", forms: [], questions: qs });
	const oks = qs.map((q, i) => got.ok && same(got.outcomes[i], intended(turn, q)));
	st.goal_ok = oks.filter(Boolean).length;
	st.goal_n = qs.length;
	st.goal = oks.map((o) => (o ? "✓" : "✗")).join("");
	log(turn, "goal", `${st.goal_ok}/${st.goal_n} of the scenario's examples behave as intended ${st.goal}`);
	// the user then uses the app for real
	for (const c of spec.use) {
		const r = await k.request({ op: "execute", call: c, request_id: `u-${++rid}` });
		log(turn, "use", `${c.fn}(${c.args.map((a: unknown) => JSON.stringify(a)).join(", ")}) => ${show(r)}`);
	}
	st.ms = Date.now() - started;
	stats.push(st);
}

// final regression: every turn's examples against the final intended program
const all: Question[] = SCENARIO.turns.flatMap((t: any) => t.examples.map((e: any) => ({ fixture: fixture(e.fixture), calls: e.calls })));
const fin = await k.request({ op: "try", forms: [], questions: all });
const finalOk = all.filter((q, i) => fin.ok && same(fin.outcomes[i], intended(SCENARIO.turns.length - 1, q))).length;
const live = await k.request({ op: "observe" });
await k.close();
rmSync(dir, { recursive: true, force: true });

const summary = {
	lang,
	scenario: SCENARIO_NAME,
	model: process.env.DEEPSEEK_MODEL ?? "deepseek-flash",
	turns_accepted: stats.filter((s) => s.accepted).length,
	turns: stats.length,
	goal_ok: stats.reduce((a, s) => a + s.goal_ok, 0),
	goal_n: stats.reduce((a, s) => a + s.goal_n, 0),
	final_regression: `${finalOk}/${all.length}`,
	develops: stats.reduce((a, s) => a + s.develops, 0),
	load_errors: stats.reduce((a, s) => a + s.load_errors, 0),
	corrections: stats.reduce((a, s) => a + s.corrections, 0),
	rejected_by_layer: stats.reduce((acc, s) => { for (const [l, n] of Object.entries(s.rejected)) acc[l] = (acc[l] ?? 0) + n; return acc; }, {} as Record<string, number>),
	usage: model.usage,
	max_tokens_hits: events.filter((e) => e.text.includes("(response hit max_tokens)")).length,
	minutes: Math.round((Date.now() - t0) / 600) / 100,
	final_functions: Object.keys(live.functions ?? {}),
	per_turn: stats,
};
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(out, "final-code.json"), `${JSON.stringify(live.functions, null, 2)}\n`);
console.log(`\n${lang}: ${summary.turns_accepted}/${summary.turns} turns accepted; goal ${summary.goal_ok}/${summary.goal_n}; final regression ${summary.final_regression}; ${summary.develops} develops (${summary.load_errors} didn't load); ${summary.corrections} corrections; ${summary.minutes} min`);
