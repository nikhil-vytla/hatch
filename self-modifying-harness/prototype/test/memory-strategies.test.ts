// Why: the memory strategies must be comparable on one session, so these tests pin the request each builds, the
// rolling summary call and its durable state, the pi thresholds, the kernel tool set per strategy, and the fork copy.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import type { Message, SystemMessage, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { truncatingSummarizer } from "../src/compaction.ts";
import { forkDataDir } from "../src/fork.ts";
import { kernelExtension } from "../src/forge.ts";
import { openLive } from "../src/live.ts";
import { buildMemoryStrategy } from "../src/memory/build.ts";
import { piCompaction, piShouldCompact, repairToolSchemas } from "../src/memory/pi.ts";
import { rollingPlan, rollingRequest } from "../src/memory/rolling.ts";
import { contentText, resolveMemory } from "../src/memory/strategy.ts";
import { windowRequest } from "../src/memory/window.ts";
import { requestFor } from "../src/memory-extension.ts";
import { Memory } from "../src/optchat.ts";
import { CellRuntime } from "../src/cells.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "memory-strategies-"));

	dirs.push(dir);

	return dir;
}

const system = (content: string): SystemMessage => ({ role: "system", content, timestamp: 1 });

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 2 });

function textOf(message: Message): string {
	if (message.role === "assistant" || message.role === "toolResult") return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

	return contentText(message.content);
}

const says = (message: Message | undefined, needle: string): boolean => message !== undefined && textOf(message).includes(needle);

describe("the window strategy", () => {
	const messages: Message[] = [user("first question"), system("SYS"), fauxAssistantMessage("A".repeat(2_000)), user("second question"), fauxAssistantMessage("b2"), user("third question")];

	test("drops the oldest runs, notes the count, and keeps the prompt first and the run last", () => {
		const tiny = windowRequest(messages, 1_000);

		assert.equal(tiny[0], messages[1], "the system prompt stays first");
		assert.equal(tiny[tiny.length - 1], messages[messages.length - 1], "the current run stays last");
		assert.ok(says(tiny.find((message) => message.role === "user" && textOf(message).startsWith("[earlier")), "dropped: 2 messages"));
		assert.ok(tiny.some((message) => says(message, "second question")), "the newest earlier run is kept");
		assert.ok(!tiny.some((message) => says(message, "first question")), "the oldest run is gone");
	});

	test("a budget that fits every run keeps them all and adds no note", () => {
		const whole = windowRequest(messages, 1_000_000);

		assert.equal(whole[0], messages[1]);
		assert.ok(!whole.some((message) => textOf(message).startsWith("[earlier")));
		assert.ok(whole.some((message) => says(message, "first question")));
	});
});

describe("the rolling strategy", () => {
	test("plans a run-boundary cut and a summary-led request", () => {
		const messages: Message[] = [user("u1"), system("SYS"), fauxAssistantMessage("A".repeat(2_000)), user("u2"), fauxAssistantMessage("a2"), user("u3")];
		const plan = rollingPlan(messages, { through: 0, summary: "" }, 1_000, 0.05, 1);

		assert.deepEqual(plan.summarize.map((message) => message.role), ["user", "assistant"], "only the oldest whole run is cut");
		assert.equal(plan.through, 3, "the cut falls on the second run's user message");

		const request = rollingRequest(plan, "THE-SUMMARY", plan.through);

		assert.equal(request[0], messages[1]);
		assert.ok(says(request[1], "THE-SUMMARY"), "the summary comes first");
		assert.equal(request[2], messages[3], "the kept tail follows the summary");
		assert.equal(request[request.length - 1], messages[5]);
	});

	test("summarizes at the trigger, persists rolling.json, and resumes from it on reopen", async () => {
		const dir = tempDir();
		const turnFaux = fauxProvider();

		turnFaux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);

		const summaryFaux = fauxProvider();
		let firstInput = "";
		let secondInput = "";

		summaryFaux.setResponses([
			(context) => {
				firstInput = context.messages.map((message) => textOf(message)).join("\n");

				return fauxAssistantMessage("FIRST-SUM");
			},
			(context) => {
				secondInput = context.messages.map((message) => textOf(message)).join("\n");

				return fauxAssistantMessage("SECOND-SUM");
			},
		]);

		const summary = { model: summaryFaux.models[0], provider: summaryFaux.provider, why: "test" };
		const spec = { strategy: "rolling" as const, budgetBytes: 400, rolling: { triggerRatio: 0.05, retainRatio: 0.1 } };
		const first = await openLive(dir, { turn: { model: turnFaux.models[0], provider: turnFaux.provider, why: "test" }, summary, memory: spec });

		await first.ask("first question ".repeat(5));
		await first.ask("second question ".repeat(5));
		await first.memory.idle();
		await first.close();

		assert.match(firstInput, /first question/, "the first summary got the cut messages");
		assert.match(readFileSync(join(dir, "memory", "rolling.json"), "utf8"), /FIRST-SUM/);

		const reopenedFaux = fauxProvider();

		reopenedFaux.setResponses([fauxAssistantMessage("ok")]);

		const reopened = await openLive(dir, { turn: { model: reopenedFaux.models[0], provider: reopenedFaux.provider, why: "test" }, summary, memory: spec });

		await reopened.ask("third question ".repeat(5));
		await reopened.memory.idle();
		await reopened.close();

		assert.match(secondInput, /FIRST-SUM/, "the reopened forge folds the new cut into the persisted summary");
		assert.match(readFileSync(join(dir, "memory", "rolling.json"), "utf8"), /SECOND-SUM/);
	});

	test("below the trigger nothing is summarized and no file is written", async () => {
		const dir = tempDir();
		const turnFaux = fauxProvider();

		turnFaux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);

		const summaryFaux = fauxProvider();
		const spec = { strategy: "rolling" as const, budgetBytes: 1_000_000 };
		const live = await openLive(dir, { turn: { model: turnFaux.models[0], provider: turnFaux.provider, why: "test" }, summary: { model: summaryFaux.models[0], provider: summaryFaux.provider, why: "test" }, memory: spec });

		await live.ask("one");
		await live.ask("two");
		await live.memory.idle();
		await live.close();

		assert.equal(summaryFaux.state.callCount, 0);
		assert.equal(existsSync(join(dir, "memory", "rolling.json")), false);
	});
});

describe("the pi strategy", () => {
	test("keeps automatic compaction off and derives what a compaction keeps from the budget", () => {
		assert.deepEqual(piCompaction(64_000), { enabled: false, reserveTokens: 4_096, keepRecentTokens: 8_000, backgroundTokens: 0 });
	});

	test("puts back an object type that compaction dropped from a tool's schema, and leaves good schemas alone", () => {
		const broken: SystemMessage = { role: "system", content: "", timestamp: 0, toolsAdded: [{ name: "party", description: "", parameters: { properties: { action: { type: "string" } }, required: ["action"] } }] };
		const good: SystemMessage = { role: "system", content: "", timestamp: 0, toolsAdded: [{ name: "dice", description: "", parameters: { type: "object", properties: {} } }] };
		const fixed = repairToolSchemas(broken);

		assert.match(JSON.stringify(fixed), /"parameters":\{"properties":\{"action":\{"type":"string"\}\},"required":\["action"\],"type":"object"\}/);
		assert.deepEqual(repairToolSchemas(good), good);
	});

	test("asks for a compaction only past the byte budget", () => {
		const message = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

		assert.equal(piShouldCompact([message("short")], 1_000), false);
		assert.equal(piShouldCompact([message("x".repeat(2_000))], 1_000), true);
	});

	// The first version lowered the model's context window to make pi-durable compact at the budget; that also shrank
	// the room for the answer and cut a tool call off mid-turn. Now compaction runs between turns and turns stay whole.
	test("compacts between turns, meters it as a compaction, and leaves the turn whole", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-"));
		const faux = fauxProvider();
		const long = "the party rests at the inn and talks for a long while. ".repeat(80);
		// pi-durable's compaction request ends with its summarization instructions; everything else is a turn.
		const isCompaction = (context: TranscriptContext): boolean => /summar/i.test(JSON.stringify(context.messages.at(-1) ?? ""));
		const respond: FauxResponseStep = (context) => (isCompaction(context) ? fauxAssistantMessage("SUMMARY: the party is resting at the inn.") : fauxAssistantMessage(`turn: ${long}`));
		faux.setResponses(Array.from({ length: 12 }, () => respond));
		const served = { model: faux.models[0], provider: faux.provider, why: "test" };
		const live = await openLive(dir, { turn: served, summary: served, memory: { strategy: "pi", budgetBytes: 8_000 } });

		try {
			for (const text of ["first", "second", "third"]) {
				const turn = await live.ask(text);

				assert.equal(turn.status, "done", `turn "${text}" completed`);
				assert.ok(turn.events.some((e) => e.kind === "reply" && e.text.startsWith("turn: ")), `turn "${text}" got its whole reply`);
			}

			assert.ok(live.meter.rows.some((row) => row.kind === "compaction"), "a compaction ran and was metered as one");
		} finally {
			await live.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the default budget is optchat's 128 KB, the others 64 KB", () => {
		assert.deepEqual(resolveMemory(undefined), { strategy: "optchat", budgetBytes: 128_000, rolling: { triggerRatio: 0.8, retainRatio: 0.5 } });
		assert.equal(resolveMemory({ strategy: "window" }).budgetBytes, 64_000);
		assert.equal(resolveMemory({ strategy: "pi" }).budgetBytes, 64_000);
	});
});

describe("the optchat default", () => {
	test("keeps the existing request shape and budgets", async () => {
		const dir = tempDir();
		const built = buildMemoryStrategy(undefined, { dataDir: dir, summarizer: truncatingSummarizer, rollingSummarizer: async () => "" });

		assert.equal(built.strategy.name, "optchat");
		assert.equal(built.resolved.budgetBytes, 128_000);

		const recall = built.strategy.recall;

		if (recall === undefined) throw new Error("optchat must offer recall");

		const build = requestFor(recall, { logged: 0 });
		const out = await build([user("one"), system("PROMPT"), fauxAssistantMessage("answer"), user("two")]);

		assert.deepEqual(out.map((message) => message.role), ["system", "user", "user"]);
		assert.ok(says(out[1], "<chat>"));
		assert.ok(!says(out[1], "two"), "the new message is not in its own view");

		await built.strategy.idle();
		await built.strategy.close();
	});
});

describe("the kernel tools per strategy", () => {
	test("offers zoom and date only when a recall memory exists", async () => {
		const dir = tempDir();
		const runtime = new CellRuntime(join(dir, "cells"));
		const registry = createRegistry();
		const base = { harness: (): never => { throw new Error("unused"); }, registry, runtime, currentRequest: (): number | undefined => undefined, invariants: {} };
		const memory = new Memory(join(dir, "chat"), { fsync: false });

		try {
			assert.deepEqual(kernelExtension({ ...base, memory }).tools?.map((tool) => tool.name), ["cell_propose", "cell_rollback", "cell_list", "cell_source", "zoom", "date"]);
			assert.deepEqual(kernelExtension(base).tools?.map((tool) => tool.name), ["cell_propose", "cell_rollback", "cell_list", "cell_source"]);
		} finally {
			await memory.idle();
			await runtime.close();
		}
	});
});

describe("forking a data directory", () => {
	test("copies sqlite consistently, other files as is, and skips the wal and shm sidecars", async () => {
		const src = tempDir();
		const dst = join(tempDir(), "target");

		mkdirSync(join(src, "nested"), { recursive: true });

		const db = new DatabaseSync(join(src, "session.sqlite"));

		db.exec("CREATE TABLE t (x INTEGER)");
		db.prepare("INSERT INTO t VALUES (?)").run(42);
		db.close();

		writeFileSync(join(src, "nested", "note.txt"), "hello");
		writeFileSync(join(src, "session.sqlite-wal"), "wal");
		writeFileSync(join(src, "session.sqlite-shm"), "shm");

		await forkDataDir(src, dst, false);
		rmSync(join(src, "nested"), { recursive: true, force: true });

		assert.ok(existsSync(join(dst, "nested", "note.txt")));
		assert.equal(readFileSync(join(dst, "nested", "note.txt"), "utf8"), "hello");
		assert.ok(!existsSync(join(dst, "session.sqlite-wal")));
		assert.ok(!existsSync(join(dst, "session.sqlite-shm")));

		const copy = new DatabaseSync(join(dst, "session.sqlite"), { readOnly: true });

		try {
			assert.equal(copy.prepare("SELECT x FROM t").get()?.x, 42);
		} finally {
			copy.close();
		}

		await assert.rejects(forkDataDir(src, dst, false), /not empty/);
		await forkDataDir(src, dst, true);
		assert.ok(existsSync(join(dst, "session.sqlite")));
	});
});
