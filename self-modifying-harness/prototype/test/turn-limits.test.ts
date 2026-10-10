// The two brakes on a looping turn: the kernel refuses a proposal it has already rejected and stops taking proposals
// after too many rejections in one turn, and `Live.ask` aborts a turn that makes too many tool calls. Both come from a
// live run in which the model resent one rejected proposal until the spending cap stopped it at 1,000 calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MAX_REJECTIONS_PER_TURN, proposalFingerprint, RejectionMemory } from "../src/forge.ts";
import { openLive } from "../src/live.ts";
import { parseProposal } from "../src/proposal.ts";

const args = { name: "dice", description: "roll", parameters: { type: "object", properties: {} }, source: "return 4;", checks: [{ args: {}, expect: 4 }], expectLive: null };

describe("the kernel's memory of rejected proposals", () => {
	test("the same proposal is refused the second time, with the first reason", () => {
		const memory = new RejectionMemory();
		const fp = proposalFingerprint(parseProposal(args));

		assert.equal(memory.refusal(fp, 1), undefined);
		memory.note(fp, 1, "check 0 failed");
		assert.match(memory.refusal(fp, 1) ?? "", /exact proposal before and it was rejected \(1 time\): check 0 failed/);
	});

	test("the same code with different checks is a new attempt", () => {
		const first = proposalFingerprint(parseProposal(args));
		const second = proposalFingerprint(parseProposal({ ...args, checks: [{ args: {}, expect: 5 }] }));

		assert.notEqual(first, second);
	});

	test("after the per-turn limit every proposal is refused, and the next turn starts over", () => {
		const memory = new RejectionMemory();

		for (let i = 0; i < MAX_REJECTIONS_PER_TURN; i++) memory.note(`fp${i}`, 7, "no");

		assert.match(memory.refusal("fresh", 7) ?? "", /REFUSED: 6 proposals were rejected in this turn/);
		assert.equal(memory.refusal("fresh", 8), undefined);
	});
});

test("a turn that makes too many tool calls is aborted and says so", async () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-limit-"));
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxToolCall("cell_list", {}), { stopReason: "toolUse" })));
	const model = faux.models[0];
	const served = { model, provider: faux.provider, why: "test" };
	const live = await openLive(dir, { turn: served, summary: served, maxToolCallsPerTurn: 3 });

	try {
		const turn = await live.ask("loop");
		const calls = turn.events.filter((e) => e.kind === "call").length;

		assert.ok(calls >= 3 && calls < 20, `stopped after ${calls} calls`);
		assert.ok(turn.events.some((e) => e.kind === "reply" && e.text.startsWith("(stopped: this turn made")));
		assert.notEqual(turn.status, "done");
	} finally {
		await live.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
