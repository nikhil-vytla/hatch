// The spill extension and its readers: the pure store functions cover the pointer, the slices, the query and the grep
// and the idempotent write; one real openLive with the faux provider proves the `afterTool` hook fires and the
// model-visible (and OptChat-logged) result is the pointer while results.sqlite keeps the full text.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { CellRuntime } from "../src/cells.ts";
import { openLive } from "../src/live.ts";
import { isCount, isRecord, isString, parseJson } from "../src/optchat.ts";
import { DEFAULT_SPILL_POLICY, grepMatches, grepResult, NEVER_SPILLED_TOOLS, queryResult, readResult, readSlice, ResultStore, spillExtension, spillResult, type SpillPolicy } from "../src/spill.ts";
import { openForge, propose, version } from "./support.ts";

const BIG = "a".repeat(50_000);

const NOTE = "answer questions with result_query({ref, expr}) (r is the parsed value); search with result_grep({ref, pattern}); page with result_read({ref, offset, length})";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "spill-"));
}

function callFor(name: string, id: string): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function textOf(content: ToolExecutionResult["content"]): string {
	for (const part of content ?? []) if (part.type === "text") return part.text;

	return "";
}

function bigResult(): ToolExecutionResult {
	return { content: [{ type: "text", text: BIG }] };
}

type Pointer = { ref: string; size: number; preview: string; note: string; "shape"?: string; itemCount?: number; property?: string };

function pointerOf(text: string): Pointer {
	const raw = parseJson(text);

	if (!isRecord(raw) || !isString(raw.spilled) || !isCount(raw.size) || !isString(raw.preview) || !isString(raw.note)) throw new Error(`not a spill pointer: ${text.slice(0, 80)}`);

	return {
		ref: raw.spilled,
		size: raw.size,
		preview: raw.preview,
		note: raw.note,
		"shape": isString(raw.shape) ? raw.shape : undefined,
		itemCount: isCount(raw.itemCount) ? raw.itemCount : undefined,
		property: isString(raw.property) ? raw.property : undefined,
	};
}

/** A runtime, a store and a `r:q` row, with both closed when the test ends. */
function fixture(t: TestContext, text: string) {
	const dir = tempDir();
	const runtime = new CellRuntime(join(dir, "cells"));
	const store = new ResultStore(dir);

	store.put("r:q", text);
	t.after(async () => {
		store.close();
		await runtime.close();
	});

	return { runtime, store };
}

describe("the spill store and pointer", () => {
	test("a value over the limit becomes a pointer and the full text is stored", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const result: ToolExecutionResult = { content: [{ type: "text", text: BIG }], isError: true, details: { k: 1 }, diagnostics: [{ severity: "info", message: "kept" }] };
		const spilled = spillResult(store, DEFAULT_SPILL_POLICY, "task-1", callFor("some_tool", "call-1"), result);

		if (spilled === undefined) throw new Error("expected a spill");
		const pointer = pointerOf(textOf(spilled.content));

		assert.match(pointer.ref, /^r:[0-9a-f]{12}$/);
		assert.equal(pointer.size, Buffer.byteLength(BIG));
		assert.equal(pointer.preview, `${BIG.slice(0, DEFAULT_SPILL_POLICY.previewChars)}…`);
		assert.equal(pointer.note, NOTE);
		assert.equal(spilled.isError, true);
		assert.deepEqual(spilled.details, { k: 1 });
		assert.deepEqual(spilled.diagnostics, [{ severity: "info", message: "kept" }]);

		const stored = store.get(pointer.ref);

		if (stored === undefined) throw new Error("no stored row");
		assert.equal(stored.text, BIG);
		assert.equal(stored.size, pointer.size);
	});

	test("a value at or under the limit passes through", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const small: ToolExecutionResult = { content: [{ type: "text", text: "x".repeat(DEFAULT_SPILL_POLICY.spillBytes) }] };

		assert.equal(spillResult(store, DEFAULT_SPILL_POLICY, "task-1", callFor("some_tool", "call-1"), small), undefined);
		assert.equal(store.count(), 0);
	});

	test("the same task and call spill once", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const call = callFor("some_tool", "call-1");

		assert.notEqual(spillResult(store, DEFAULT_SPILL_POLICY, "task-1", call, bigResult()), undefined);
		assert.notEqual(spillResult(store, DEFAULT_SPILL_POLICY, "task-1", call, bigResult()), undefined);
		assert.equal(store.count(), 1);
	});

	test("spillBytes 0 disables spilling but keeps the reader tools", (t) => {
		const dir = tempDir();
		const store = new ResultStore(dir);
		const runtime = new CellRuntime(join(dir, "cells"));
		t.after(async () => {
			store.close();
			await runtime.close();
		});
		const off: SpillPolicy = { spillBytes: 0, previewChars: 500 };

		assert.equal(spillResult(store, off, "task-1", callFor("some_tool", "call-1"), bigResult()), undefined);

		const extension = spillExtension(dir, runtime, off);

		t.after(() => extension.close());
		assert.deepEqual(extension.tools?.map((tool) => tool.name), ["result_read", "result_grep", "result_query"]);
	});

	test("reader and memory tool outputs are never spilled", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const tiny: SpillPolicy = { spillBytes: 10, previewChars: 5 };

		for (const name of NEVER_SPILLED_TOOLS) assert.equal(spillResult(store, tiny, "task-1", callFor(name, `call-${name}`), bigResult()), undefined);

		assert.equal(store.count(), 0);
	});
});

describe("result_read", () => {
	test("returns the requested slice and more", () => {
		const stored = { text: "abcdefghij", size: 10 };

		assert.deepEqual(readSlice("r:x", stored, 2, 4), { ref: "r:x", offset: 2, length: 4, size: 10, text: "cdef", more: true });
		assert.deepEqual(readSlice("r:x", stored, 8, 4), { ref: "r:x", offset: 8, length: 4, size: 10, text: "ij", more: false });
	});

	test("reading past the end is an empty window", () => {
		assert.deepEqual(readSlice("r:x", { text: "abc", size: 3 }, 20, 4), { ref: "r:x", offset: 20, length: 4, size: 3, text: "", more: false });
	});

	test("length is capped at 8000", () => {
		const slice = readSlice("r:x", { text: "a".repeat(9_000), size: 9_000 }, 0, 50_000);

		assert.equal(slice.length, 8_000);
		assert.equal(slice.text.length, 8_000);
		assert.equal(slice.more, true);
	});
});

describe("result_query", () => {
	const roster = Array.from({ length: 300 }, (_, i) => ({ number: i + 1, name: `p${i + 1}`, job: i % 2 === 0 ? "blacksmith" : "baker" }));

	test("filters, finds, reads length, and accepts a function body", async (t) => {
		const { runtime, store } = fixture(t, JSON.stringify({ roster }));
		const filtered = parseJson(await queryResult(runtime, store, { ref: "r:q", expr: 'r.roster.filter(p => p.job === "blacksmith")' }));

		if (!Array.isArray(filtered)) throw new Error("expected an array");
		assert.equal(filtered.length, 150);

		const found = parseJson(await queryResult(runtime, store, { ref: "r:q", expr: "r.roster.find(p => p.number === 150)" }));

		if (!isRecord(found)) throw new Error("expected an object");
		assert.equal(found.number, 150);
		assert.equal(await queryResult(runtime, store, { ref: "r:q", expr: "r.roster.length" }), "300");
		assert.equal(await queryResult(runtime, store, { ref: "r:q", expr: "const n = r.roster.length; return n;" }), "300");
	});

	test("a syntax error, a throw and an unknown ref are clear errors", async (t) => {
		const { runtime, store } = fixture(t, JSON.stringify({ roster }));

		await assert.rejects(queryResult(runtime, store, { ref: "r:q", expr: "r." }), /query failed:/);
		await assert.rejects(queryResult(runtime, store, { ref: "r:q", expr: 'throw new Error("boom")' }), /query failed:.*boom/);
		await assert.rejects(queryResult(runtime, store, { ref: "r:nope", expr: "r" }), /r:nope/);
	});

	test("an answer over 8000 characters is cut", async (t) => {
		const { runtime, store } = fixture(t, JSON.stringify("x".repeat(9_000)));
		const answer = await queryResult(runtime, store, { ref: "r:q", expr: "r" });
		const marker = "…[cut: answer is 9002 chars; narrow the expression]";

		assert.equal(answer.length, 8_000 + marker.length);
		assert.ok(answer.endsWith(marker));
	});

	test("cannot write, and sees only its own empty throwaway state", async (t) => {
		const dir = tempDir();
		const runtime = new CellRuntime(join(dir, "cells"));
		const store = new ResultStore(dir);

		store.put("r:q", JSON.stringify({ ok: true }));
		t.after(async () => {
			store.close();
			await runtime.close();
		});
		await runtime.run('await kv.put("cups", 5); return 5;', {}, runtime.statePath("coffee"));

		await assert.rejects(queryResult(runtime, store, { ref: "r:q", expr: 'await kv.put("cups", 99); return 0;' }), /query failed:/);
		assert.equal(await queryResult(runtime, store, { ref: "r:q", expr: 'await kv.get("cups")' }), "null");
		assert.equal(await runtime.run('return await kv.get("cups");', {}, runtime.statePath("coffee")), 5);
	});
});

describe("result_grep", () => {
	test("windows a single-line value and merges overlapping matches", () => {
		const value = `{"roster":[${Array.from({ length: 5 }, (_, i) => `{"id":${i},"name":"target${i}"}`).join(",")}]}`;
		const found = grepMatches("target", { text: value, size: value.length }, 100);

		assert.equal(found.total, 5);
		assert.deepEqual(found.matches, [{ offset: 0, text: value }]);
	});

	test("separate windows carry the offset of their start and clip to the value", () => {
		const text = `${"x".repeat(300)}needle${"y".repeat(300)}needle${"z".repeat(300)}`;
		const found = grepMatches("NEEDLE", { text, size: text.length }, 100);

		assert.equal(found.total, 2);
		assert.deepEqual(found.matches, [
			{ offset: 180, text: text.slice(180, 426) },
			{ offset: 486, text: text.slice(486, 732) },
		]);
	});

	test("an occurrence at the start is clipped to the value", () => {
		const text = "needle at the start";

		assert.deepEqual(grepMatches("needle", { text, size: text.length }, 1), { matches: [{ offset: 0, text }], total: 1 });
	});

	test("max caps the windows but total counts every match", () => {
		const text = `${"a".repeat(300)}hit${"b".repeat(300)}hit${"c".repeat(300)}hit`;
		const found = grepMatches("hit", { text, size: text.length }, 2);

		assert.equal(found.total, 3);
		assert.equal(found.matches.length, 2);
	});

	test("JSON carries the matches and the total", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		store.put("r:g", `one${"x".repeat(300)}ONE`);
		const raw = parseJson(grepResult(store, { ref: "r:g", pattern: "one" }));

		if (!isRecord(raw) || !Array.isArray(raw.matches) || !isCount(raw.total)) throw new Error("bad grep json");
		assert.equal(raw.total, 2);
		assert.equal(raw.matches.length, 2);
	});

	test("an unknown ref is a clear error", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());

		assert.throws(() => readResult(store, { ref: "r:nope" }), /r:nope/);
		assert.throws(() => grepResult(store, { ref: "r:nope", pattern: "x" }), /r:nope/);
	});
});

describe("preview by shape", () => {
	test("a JSON array previews its first items and its shape", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const text = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
		const spilled = spillResult(store, { spillBytes: 1, previewChars: 500 }, "task-1", callFor("some_tool", "call-1"), { content: [{ type: "text", text }] });

		if (spilled === undefined) throw new Error("expected a spill");
		const pointer = pointerOf(textOf(spilled.content));

		assert.equal(pointer.preview, JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]));
		assert.equal(pointer.shape, "array of 4 items");
		assert.equal(pointer.itemCount, 4);
		assert.equal(pointer.property, undefined);
	});

	test("an object with an array property names the property", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const text = JSON.stringify({ roster: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }] });
		const spilled = spillResult(store, { spillBytes: 1, previewChars: 500 }, "task-1", callFor("some_tool", "call-1"), { content: [{ type: "text", text }] });

		if (spilled === undefined) throw new Error("expected a spill");
		const pointer = pointerOf(textOf(spilled.content));

		assert.equal(pointer.preview, JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]));
		assert.equal(pointer.shape, "object with array 'roster' of 5 items");
		assert.equal(pointer.itemCount, 5);
		assert.equal(pointer.property, "roster");
	});

	test("plain text keeps the leading-characters preview", (t) => {
		const store = new ResultStore(tempDir());
		t.after(() => store.close());
		const text = "plain ".repeat(200);
		const spilled = spillResult(store, { spillBytes: 1, previewChars: 20 }, "task-1", callFor("some_tool", "call-1"), { content: [{ type: "text", text }] });

		if (spilled === undefined) throw new Error("expected a spill");
		const pointer = pointerOf(textOf(spilled.content));

		assert.equal(pointer.preview, `${text.slice(0, 20)}…`);
		assert.equal(pointer.shape, undefined);
		assert.equal(pointer.itemCount, undefined);
	});
});

test("a big cell result is the pointer in the memory log, with the full text in results.sqlite", async () => {
	const dir = tempDir();
	const forge = await openForge(dir);
	const source = 'return "x".repeat(Math.min(Math.max(0, args.n), 60000));';

	const candidate = version("big", source, {
		description: "Return n copies of x.",
		parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
		checks: [{ args: { n: 0 }, expect: "" }, { args: { n: 2 }, expect: "xx" }],
		replay: "safe",
	});

	const seeded = await propose(forge, candidate, { expectLive: null, owned: [], changes: [] });

	if (!seeded.ok) throw new Error(`seeding big was rejected: ${seeded.reason}`);
	await forge.close();

	const turnFaux = fauxProvider();
	const summaryFaux = fauxProvider();
	const turn = { model: turnFaux.models[0], provider: turnFaux.provider, why: "test" };
	const summary = { model: summaryFaux.models[0], provider: summaryFaux.provider, why: "test" };
	turnFaux.setResponses([
		fauxAssistantMessage(fauxToolCall("big", { n: 50_000 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	summaryFaux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("summary")));
	const live = await openLive(dir, { turn, summary });

	try {
		const answer = await live.ask("run big");
		assert.equal(answer.status, "done");
		const echo = live.memory.root.find((message) => message.kind === "echo");

		if (echo === undefined) throw new Error("no tool result was logged");
		const pointer = pointerOf(echo.text);
		const store = new ResultStore(dir);

		try {
			const stored = store.get(pointer.ref);

			if (stored === undefined) throw new Error("no stored row");
			assert.ok(pointer.size > DEFAULT_SPILL_POLICY.spillBytes);
			assert.equal(pointer.preview.length, DEFAULT_SPILL_POLICY.previewChars + 1);
			assert.match(pointer.preview, /^"/);
			assert.equal(stored.size, pointer.size);
			assert.ok(stored.text.startsWith('"'));
		} finally {
			store.close();
		}
	} finally {
		await live.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
