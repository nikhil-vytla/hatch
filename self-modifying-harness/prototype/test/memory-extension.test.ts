// The request the model gets (spec sections 3.3, 5 and 6): the system prompt first and constant, then the view rendered
// before the run's user message is logged and only after every earlier message is summarized, then the run itself.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { Message, SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type MirrorState, requestFor } from "../src/memory-extension.ts";
import { Memory, PLACEHOLDER } from "../src/optchat.ts";
import { truncatingSummarizer, type Summarizer } from "../src/compaction.ts";

const dirs: string[] = [];

const memories: Memory[] = [];

afterEach(async () => {
	for (const memory of memories.splice(0)) await memory.idle();

	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A memory whose summaries take 15 ms, so a request that does not wait for them would show placeholders. */
type Chat = { memory: Memory; state: MirrorState };

function slowMemory(): Chat {
	const dir = mkdtempSync(join(tmpdir(), "memory-extension-"));
	dirs.push(dir);

	const slow: Summarizer = {
		compress: async (request) => {
			await new Promise((resolve) => setTimeout(resolve, 15));

			return truncatingSummarizer.compress(request);
		},
		merge: truncatingSummarizer.merge,
	};

	const memory = new Memory(dir, { fsync: false, summarizer: slow });
	memories.push(memory);

	return { memory, state: { logged: 0 } };
}

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 1 });

const prompt: SystemMessage = { role: "system", content: "", sections: { "optchat-view": "You are Forge, test prompt." }, toolsAdded: [], timestamp: 2 };

const textOf = (m: Message): string => (m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "text" ? m.content[0].text : "");

const long = (tag: string): string => `${tag} ${"detail ".repeat(120)}`;

describe("the request shaper", () => {
	test("puts the prompt first, renders the view before the run's message is logged, and waits for earlier summaries", async () => {
		const { memory, state } = slowMemory();
		const build = requestFor(memory, state);
		const first = await build([user(long("one")), prompt]);
		assert.deepEqual(first.map((m) => m.role), ["system", "user", "user"], "the announced prompt moved ahead of the view");
		assert.equal(textOf(first[1]), "<chat>\n\n</chat>", "nothing before the first run");
		assert.equal(memory.length, 1, "the user message is logged after the view was rendered");

		const transcript = [user(long("one")), prompt, fauxAssistantMessage(long("answer")), user("two")];
		const second = await build(transcript);
		const view = textOf(second[1]);
		assert.match(view, /^<chat>\n0\+1\|user: one/);
		assert.match(view, /\n1\+1\|agent: answer/);
		assert.ok(!view.includes(PLACEHOLDER), "the request waited for the summaries");
		assert.ok(!view.includes("two"), "the new message is not in its own view");
		assert.equal(memory.length, 3);
		assert.equal(state.runStartLog, 2);
	});

	test("the view is kept for the whole run, even if the log moves on", async () => {
		const { memory, state } = slowMemory();
		const build = requestFor(memory, state);
		const turn = [user("one"), prompt, fauxAssistantMessage("answer"), user("two")];
		const first = await build(turn);
		memory.log("note", "something imported mid-run");
		const call = fauxAssistantMessage(fauxToolCall("zoom", { id: 0, n: 1 }), { stopReason: "toolUse" });
		const result: Message = { role: "toolResult", toolCallId: "x", toolName: "zoom", content: [{ type: "text", text: "0+1|user: one" }], isError: false, timestamp: 3 };
		const later = await build([...turn, call, result]);
		assert.equal(textOf(later[1]), textOf(first[1]));
		assert.deepEqual(later.slice(-3).map((m) => m.role), ["user", "assistant", "toolResult"]);
	});

	test("system messages announced after the first are folded into one delta after the view", async () => {
		const { memory, state } = slowMemory();
		const build = requestFor(memory, state);
		const added: SystemMessage = { role: "system", content: "", toolsAdded: [{ name: "coffee", description: "d", parameters: { type: "object", properties: {} } }], timestamp: 5 };
		const out = await build([user("one"), prompt, fauxAssistantMessage("a"), user("two"), added, fauxAssistantMessage("b"), user("three")]);
		assert.deepEqual(out.map((m) => m.role), ["system", "user", "system", "user"]);
		assert.equal(out[0], prompt);
		const delta = out[2];
		assert.ok(delta.role === "system" && delta.toolsAdded?.[0]?.name === "coffee");
	});
});
