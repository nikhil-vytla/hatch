// OptChat's turn shape on pi-durable (spec sections 5 and 6): a `beforeRequest` hook that mirrors the transcript into
// the memory log and replaces everything before the current run with the rendered view, plus the system prompt as
// sections. The current run (its user message and tool rounds) stays verbatim, as in the spec ("each user message
// starts a fresh model call"; steps within the call are kept).
//
// A run starts at its user message. Before that message is logged, the hook waits until every earlier message is
// summarized (`memory.settle`), renders the view once, and keeps that exact text for the rest of the run, so a batch
// that merges lines mid-run never changes what the run was shown. After the view, the model gets the run's own messages;
// per-turn state (a date, open devices) would go there too, never into the system prompt, which stays constant so that
// tools and prompt are cached across all calls. There is none today.
//
// The `zoom` and `date` tools are the kernel's (forge.ts): cells may not take their names.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, SystemMessage, TextContent, Tool } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { isCount, isRecord, type Kind, type Memory, parseJson } from "./optchat.ts";
import { PROMPT_SECTIONS } from "./optchat-prompt.ts";

export type MirrorState = { logged: number; runStartLog?: number; lastRequestChars?: number };

function parseMirror(text: string): MirrorState {
	const raw = parseJson(text);

	if (!isRecord(raw) || !isCount(raw.logged)) throw new Error("mirror.json is malformed");
	const state: MirrorState = { logged: raw.logged };

	if (isCount(raw.runStartLog)) state.runStartLog = raw.runStartLog;

	if (isCount(raw.lastRequestChars)) state.lastRequestChars = raw.lastRequestChars;

	return state;
}

/** How far the transcript is mirrored into the log survives restarts in the memory's own directory. */
export function loadMirror(memory: Memory): MirrorState {
	const path = join(memory.dir, "mirror.json");

	return existsSync(path) ? parseMirror(readFileSync(path, "utf8")) : { logged: 0 };
}

function isSystem(message: Message): message is SystemMessage {
	return message.role === "system";
}

/**
 * What the model is sent for a transcript: the system prompt, the view of everything before this run, then the run
 * itself. Logs what the transcript holds that the log does not, in the order the spec asks (section 6).
 */
export function requestFor(memory: Memory, state: MirrorState): (messages: readonly Message[]) => Promise<Message[]> {
	// The view the current run was shown. Not persisted: after a restart in the middle of a run it is rendered again.
	let shown: { runStart: number; message: Message } | undefined;

	const mirror = (messages: readonly Message[], from: number, to: number): void => {
		for (let k = from; k < to; k++) {
			for (const [kind, line] of toLog(messages[k])) memory.log(kind, line);
		}
	};

	return async (messages) => {
		let cut = messages.length;

		while (cut > 0) {
			const prev = messages[cut - 1];

			if (prev.role === "assistant" && prev.stopReason !== "toolUse") break;

			cut--;
		}

		// The transcript is immutable, so a count says what is logged. A new run starts at `cut`: log what came
		// before it, wait for those messages' summaries, render the view, and only then log the run's own words.
		if (state.logged <= cut) {
			mirror(messages, state.logged, cut);
			state.runStartLog = memory.length;
		}

		const runStart = state.runStartLog ?? memory.length;

		if (shown?.runStart !== runStart) {
			await memory.settle(runStart);
			shown = { runStart, message: { role: "user", content: [{ type: "text", text: memory.render(runStart) }], timestamp: 0 } };
		}

		mirror(messages, Math.max(state.logged, cut), messages.length);
		state.logged = Math.max(state.logged, messages.length);
		writeFileSync(join(memory.dir, "mirror.json"), JSON.stringify(state));

		// pi-durable announces prompt sections and tools as positional system messages, the first one right after the
		// first user message. That one is the system prompt: it goes first, ahead of the view, so prompt and tools stay
		// a constant, cacheable head (spec section 3.3). Later ones before the cut (a self-written tool, say) are
		// folded into one delta placed after the view, so a new tool stays on offer without rewriting the head of every
		// cached prefix; later ones inside the run stay where they were announced.
		const first = messages.findIndex(isSystem);
		const head = first < 0 ? [] : [messages[first]];
		const delta = foldSystem(messages.slice(0, cut).filter((_, k) => k !== first).filter(isSystem));
		const run = messages.slice(cut).filter((_, k) => cut + k !== first);
		const out = [...head, shown.message, ...(delta === undefined ? [] : [delta]), ...run];
		state.lastRequestChars = JSON.stringify(out).length;

		return out;
	};
}

export function memoryExtension(memory: Memory, state: MirrorState) {
	const build = requestFor(memory, state);

	return defineExtension({
		name: "memory",
		sections: PROMPT_SECTIONS.map((p) => section(p.key, () => p.text, { tag: false })),
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request) => ({ messages: await build(request.messages) }),
				// A final answer is logged as it happens (the spec logs everything as it happens); the next request's
				// transcript will hold it as one more message, already mirrored.
				onYield: (answer) => {
					for (const [kind, line] of toLog(answer)) memory.log(kind, line);

					state.logged += 1;
					writeFileSync(join(memory.dir, "mirror.json"), JSON.stringify(state));

					return undefined;
				},
			}),
		],
	});
}

function foldSystem(systems: SystemMessage[]): SystemMessage | undefined {
	if (systems.length === 0) return undefined;

	const sections: Record<string, string | null> = {};
	const tools = new Map<string, Tool>();
	const removed = new Set<string>();
	const content: string[] = [];

	for (const m of systems) {
		const written = Array.isArray(m.content) ? m.content.map((part) => part.text).join("") : m.content;

		if (written) content.push(written);

		Object.assign(sections, m.sections ?? {});

		for (const t of m.toolsRemoved ?? []) {
			tools.delete(t.name);
			removed.add(t.name);
		}

		for (const t of m.toolsAdded ?? []) {
			tools.set(t.name, t);
			removed.delete(t.name);
		}
	}

	const folded: SystemMessage = { role: "system", content: content.join("\n"), timestamp: systems[systems.length - 1].timestamp };

	if (Object.keys(sections).length > 0) folded.sections = sections;

	if (tools.size > 0) folded.toolsAdded = [...tools.values()];

	if (removed.size > 0) folded.toolsRemoved = [...removed].map((toolName) => ({ name: toolName }));

	return folded;
}

function textParts(parts: string | (TextContent | { type: string })[]): string {
	return Array.isArray(parts) ? parts.flatMap((p) => (p.type === "text" && "text" in p ? [String(p.text)] : [])).join("\n") : parts;
}

/** What a transcript message becomes in the log. Thoughts are never logged (spec section 1). */
function toLog(m: Message): [Kind, string][] {
	switch (m.role) {
		case "system":
			return [];
		case "user":
			return [["user", textParts(m.content)]];
		case "toolResult":
			return [["echo", textParts(m.content)]]; // Memory.log clips it to head and tail
		case "assistant": {
			const out: [Kind, string][] = [];
			const talk = textParts(m.content);

			if (talk) out.push(["agent", talk]);

			for (const p of m.content) {
				if (p.type === "toolCall") out.push(["tool", `${p.name} ${JSON.stringify(p.arguments)}`]);
			}

			return out;
		}
	}
}
