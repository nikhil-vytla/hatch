// The chat loop: a model grows the app by calling the kernel's tools, and the user owns what "done" means.
//
//   user says something -> model calls observe / develop / execute / preview / rollback / why -> tool results -> ...
//                       -> the model replies in text, and the user says the next thing
//
// `develop` is where the user comes in: the kernel builds the candidate, asks the user about what it actually does
// (the model's proposed calls, boundaries from the user's words, uncovered functions), and only the user's answers
// become this turn's examples. The model never writes an expectation that counts.
//
// The loop speaks the Messages API wire format (content blocks with tool_use / tool_result), so the same loop runs a
// real Claude model (model-claude.ts, needs ANTHROPIC_API_KEY) or a scripted model that issues the same tool calls.
//
//   node --experimental-strip-types --no-warnings src/chat.ts               # scripted model + simulated user
//   MODEL=claude node --experimental-strip-types --no-warnings src/chat.ts  # Claude (npm install first) + simulated user
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Question } from "./ask.ts";
import { confirmed } from "./ask.ts";
import type { Example, Proposal } from "./gates.ts";
import { Kernel } from "./kernel.ts";
import type { Turn } from "./scenario.ts";
import { pick, type Scenario } from "./scenarios.ts";
import { SimulatedUser } from "./sim-user.ts";

// --- the wire format (a subset of the Messages API's content blocks) ---
export type Block =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
	| { type: string; [k: string]: unknown }; // thinking and other blocks pass through unchanged
export type Message = { role: "user" | "assistant"; content: string | Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
/** One assistant turn. `stop` is "tool_use" when it wants tool results, "end_turn" when it hands back to the user. */
export interface Model {
	next(system: string, messages: Message[], tools: ToolDef[]): Promise<{ content: Block[]; stop: string }>;
}
export interface User {
	says(): string | undefined;
	answer(questions: Question[]): unknown[];
}

const exampleSchema = {
	type: "object",
	properties: {
		fixture: { type: "object", description: "the state to run the call on, e.g. {} or {expenses: [...]}" },
		call: { type: "string", description: "a JS expression that calls the app's functions" },
	},
	required: ["fixture", "call"],
};

export const TOOLS: ToolDef[] = [
	{
		name: "observe",
		description: "The live world: generation, revision, every function's source, the state, and the user's contract so far.",
		input_schema: { type: "object", properties: {} },
	},
	{
		name: "develop",
		description:
			"Propose a change: top-level function declarations only (no other statements). Declare `scope`, the functions this request is about; edits outside scope must not change behaviour. Propose example calls (no expected values): the kernel runs them and asks the user, and only the user's answers count. Pass the generation you last observed.",
		input_schema: {
			type: "object",
			properties: {
				generation: { type: "integer" },
				intent: { type: "string" },
				scope: { type: "array", items: { type: "string" } },
				forms: { type: "array", items: { type: "string" }, description: "each a complete `function name(...) {...}` declaration" },
				removes: { type: "array", items: { type: "string" } },
				migrate: { type: "string", description: "an expression that converts the live state to the new code's shape, if the change needs it" },
				examples: { type: "array", items: exampleSchema },
				properties: {
					type: "array",
					description: "laws the user stated in words, as boolean expressions over generated states",
					items: { type: "object", properties: { name: { type: "string" }, check: { type: "string" } }, required: ["name", "check"] },
				},
			},
			required: ["generation", "intent", "scope", "forms", "examples"],
		},
	},
	{
		name: "execute",
		description: "Use the app: evaluate an expression against the live state. Changes to state persist. Give each distinct request a fresh request_id; retrying with the same id never applies twice.",
		input_schema: { type: "object", properties: { expr: { type: "string" }, request_id: { type: "string" } }, required: ["expr", "request_id"] },
	},
	{
		name: "preview",
		description: "Evaluate an expression and then restore everything: nothing persists.",
		input_schema: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
	},
	{
		name: "rollback",
		description: "Publish an earlier revision as a new one. what=code (default) keeps today's data; what=data keeps today's code; what=both restores both.",
		input_schema: { type: "object", properties: { revision: { type: "string" }, what: { type: "string", enum: ["code", "data", "both"] } }, required: ["revision"] },
	},
	{
		name: "why",
		description: "Which revision last changed a function, and the user's words that asked for it.",
		input_schema: { type: "object", properties: { function: { type: "string" } }, required: ["function"] },
	},
];

export const SYSTEM = `You grow a small application by talking with its user. The application lives in a kernel: a live JavaScript world of top-level functions and one JSON object, \`state\`. There is no build step; a redefined function is live on its next call.

Rules:
- Change code only through \`develop\`. Each form is one complete top-level \`function\` declaration; any other top-level statement is refused. No eval, no imports.
- Declare \`scope\` honestly: the functions the user's request is about. Edits to other functions must not change any recorded behaviour, or the change is rejected.
- You propose example calls, never expected answers. The kernel shows the user what each call does and the user's answers become the contract. Later changes must keep every answer the user has confirmed.
- A change is "done" only when the user's answers pass and every function in scope is exercised. If \`develop\` says accepted-incomplete or rejected, read why and fix it.
- Use \`execute\` with a fresh request_id for each thing the user asks you to do with the app.
- Observe first, and pass the generation you saw to \`develop\`.`;

type Log = { index: number; role: string; text: string };

/** Run a chat to completion. Returns the transcript and the chat log (the change log the revisions point into). */
export async function runChat(args: { kernel: Kernel; model: Model; user: User; maxSteps?: number; logFile?: string; print?: (line: string) => void }) {
	const { kernel, model, user } = args;
	const print = args.print ?? (() => {});
	const messages: Message[] = [];
	const log: Log[] = [];
	const note = (role: string, text: string) => {
		const entry = { index: log.length, role, text };
		log.push(entry);
		if (args.logFile) appendFileSync(args.logFile, `${JSON.stringify(entry)}\n`);
		return entry;
	};
	let lastUser: Log | undefined;
	const turns: { user: string; examples: Example[]; statuses: string[] }[] = [];
	for (let said = user.says(); said !== undefined; said = user.says()) {
		lastUser = note("user", said);
		turns.push({ user: said, examples: [], statuses: [] });
		print(`\n[${lastUser.index}] user> ${said}`);
		messages.push({ role: "user", content: said });
		for (let step = 0; step < (args.maxSteps ?? 12); step++) {
			const reply = await model.next(SYSTEM, messages, TOOLS);
			messages.push({ role: "assistant", content: reply.content }); // appended unchanged (thinking blocks included)
			const calls = reply.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
			for (const b of reply.content) if (b.type === "text" && (b as { text: string }).text.trim()) print(`  model: ${(b as { text: string }).text.trim()}`);
			if (calls.length === 0 || reply.stop !== "tool_use") {
				note("assistant", reply.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n"));
				break;
			}
			const results: Block[] = [];
			for (const call of calls) {
				let content: string;
				let isError = false;
				try {
					content = JSON.stringify(handle(kernel, user, call.name, call.input, lastUser, turns.at(-1)!, print));
				} catch (e) {
					content = String((e as Error).message);
					isError = true;
				}
				note("tool", `${call.name}: ${content.slice(0, 400)}`);
				results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
			}
			messages.push({ role: "user", content: results }); // all results of one assistant turn in one message
		}
	}
	return { messages, log, turns };
}

function handle(kernel: Kernel, user: User, name: string, input: Record<string, unknown>, asked: Log, turn: { examples: Example[]; statuses: string[] }, print: (l: string) => void): unknown {
	switch (name) {
		case "observe":
			return { ...kernel.observe(), sources: Object.fromEntries(kernel.world.functions), contract: { examples: kernel.spec.examples.length, properties: kernel.spec.properties.map((p) => p.name), invariants: kernel.spec.invariants.map((i) => i.name) } };
		case "develop": {
			const examples = ((input.examples as { fixture: unknown; call: string }[]) ?? []).map((e) => ({ fixture: e.fixture ?? {}, expr: e.call, call: e.call, expect: undefined }));
			const proposal: Proposal = {
				intent: String(input.intent),
				scope: (input.scope as string[]) ?? [],
				forms: (input.forms as string[]) ?? [],
				removes: input.removes as string[] | undefined,
				migrate: input.migrate as string | undefined,
				examples,
				properties: ((input.properties as { name: string; check: string }[]) ?? []).map((p) => ({ name: p.name, gen: Object.keys(kernel.generators)[0], check: p.check })),
			};
			const asks = kernel.ask(proposal, asked.text);
			if ("error" in asks) return { status: "rejected", error: asks.error };
			const answers = user.answer(asks.questions);
			const contract = confirmed(asks.questions, answers);
			const corrected = asks.questions.flatMap((q, i) => (JSON.stringify(q.answer) === JSON.stringify(answers[i]) ? [] : [{ call: q.call, fixture: q.fixture, yours: q.answer, user: answers[i] }]));
			for (const q of asks.questions) print(`    kernel asks: ${q.call} on ${JSON.stringify(q.fixture).slice(0, 60)}  (${q.why})`);
			if (corrected.length) print(`    user corrects ${corrected.length}: ${corrected.map((c) => `${c.call}: ${JSON.stringify(c.user).slice(0, 80)}`).join("; ")}`);
			const r = kernel.develop({ ...proposal, examples: contract }, Number(input.generation), { asked: { message: asked.index, text: asked.text } });
			turn.examples.push(...contract);
			turn.statuses.push(r.status);
			print(`  develop [${proposal.scope.join(", ")}] -> ${r.status}${r.revision ? ` (${r.revision})` : ""}${r.failed?.length ? `; failed ${r.failed.join(", ")}` : ""}`);
			return {
				status: r.status,
				revision: r.revision,
				failed: r.report?.verdicts.filter((v) => !v.ok).map((v) => `${v.layer}: ${v.detail}`),
				user_corrected: corrected,
				uncovered: r.uncovered,
				behaviour_diffs: r.report?.surfaced,
				fuzz_advisories: r.report?.advisories.filter((a) => !a.includes("as the accepted version")).slice(0, 5),
			};
		}
		case "execute": {
			const r = kernel.execute(String(input.expr), input.request_id === undefined ? undefined : String(input.request_id));
			print(`  execute ${input.expr} => ${JSON.stringify(r)}`);
			return r;
		}
		case "preview":
			return { value: kernel.preview(String(input.expr)) };
		case "rollback": {
			const r = kernel.rollback(String(input.revision), (input.what as "code" | "data" | "both") ?? "code");
			return { revision: r.id, reason: r.reason };
		}
		case "why":
			return kernel.why(String(input.function)) ?? { error: "no revision defines it" };
		default:
			throw new Error(`no tool ${name}`);
	}
}

/**
 * A model stand-in that makes, for each user message, the calls a model would: observe, develop with the scenario's
 * proposal (its examples sent as calls, without expectations), then the turn's real use with fresh request ids.
 */
export class ScriptedModel implements Model {
	private turn = -1;
	private phase = 0;
	private ids = 0;
	readonly turns: Turn[];
	constructor(turns: Turn[]) {
		this.turns = turns;
	}
	async next(_system: string, messages: Message[]): Promise<{ content: Block[]; stop: string }> {
		const last = messages.at(-1)!;
		if (typeof last.content === "string") {
			this.turn++;
			this.phase = 0;
		}
		const t = this.turns[this.turn];
		const id = () => `call_${++this.ids}`;
		const use = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: id(), name, input });
		this.phase++;
		if (this.phase === 1) return { content: [use("observe", {})], stop: "tool_use" };
		if (this.phase === 2) {
			const seen = JSON.parse((last.content as Extract<Block, { type: "tool_result" }>[])[0].content).generation;
			const p = t.proposal;
			return {
				content: [
					{ type: "text", text: `I'll ${p.intent}.` },
					use("develop", { generation: seen, intent: p.intent, scope: p.scope, forms: p.forms, removes: p.removes, migrate: p.migrate, examples: p.examples.map((e) => ({ fixture: e.fixture, call: e.call ?? e.expr })), properties: p.properties?.map((q) => ({ name: q.name, check: q.check })) }),
				],
				stop: "tool_use",
			};
		}
		if (this.phase === 3 && t.use.length > 0) return { content: t.use.map((expr, i) => use("execute", { expr, request_id: `req-${this.turn + 1}-${i}` })), stop: "tool_use" };
		const dev = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").map((b) => (b as { content: string }).content);
		const status = dev.map((c) => c.match(/"status":"([\w-]+)"/)?.[1]).filter(Boolean).at(-1);
		return { content: [{ type: "text", text: `Done (${status}).` }], stop: "end_turn" };
	}
}

/** Run the scripted chat with the simulated user and return each turn with exactly the examples the user confirmed. */
export async function chatContract(scenario: Scenario): Promise<Turn[]> {
	const turns = scenario.turns;
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "grown-chat-"));
	const kernel = new Kernel(dir, { spec: { invariants: scenario.invariants, examples: [], properties: [] }, generators: scenario.generators });
	const run = await runChat({ kernel, model: new ScriptedModel(turns), user: new SimulatedUser(turns) });
	rmSync(dir, { recursive: true, force: true });
	return turns.map((t, i) => ({ ...t, proposal: { ...t.proposal, examples: run.turns[i].examples } }));
}

if (import.meta.main) {
	const scenario = pick();
	const dir = join(import.meta.dirname, "..", "data", `chat-${scenario.name}`);
	rmSync(dir, { recursive: true, force: true });
	const kernel = new Kernel(dir, { spec: { invariants: scenario.invariants, examples: [], properties: [] }, generators: scenario.generators });
	let model: Model;
	if (process.env.MODEL === "claude") {
		const { ClaudeModel } = await import("./model-claude.ts");
		model = await ClaudeModel.create();
	} else model = new ScriptedModel(scenario.turns);
	const user = new SimulatedUser(scenario.turns);
	const run = await runChat({ kernel, model, user, logFile: join(dir, "chat.jsonl"), print: console.log });
	console.log(`\n${run.log.length} chat log entries; ${kernel.spec.examples.length} confirmed examples in the contract; the simulated user corrected ${user.corrections} answers`);
	const fn = scenario.name === "shop" ? "addItem" : "topCategory";
	const w = kernel.why(fn);
	console.log(`why is ${fn}() the way it is? ${w?.revision} ("${w?.reason}") was asked for by chat message ${w?.asked?.message}: "${w?.asked?.text}"`);
}
