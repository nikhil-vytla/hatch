// The spending cap and the usage accounting of src/live.ts, over pi-ai's faux provider (no network).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { cachePercent, CapExceeded, Meter, meteredProvider, PRICE } from "../src/live.ts";

const usage = (input: number, cacheRead: number, output: number, total = 0): Usage => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });

/** A models collection whose only provider is the faux one, behind `meter`. */
function fauxModels(meter: Meter, replies: number) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(meteredProvider(faux.provider, meter, "turn"));
	faux.setResponses(Array.from({ length: replies }, () => fauxAssistantMessage("ok")));
	const model = models.getModel(faux.models[0].provider, faux.models[0].id);

	if (model === undefined) throw new Error("no faux model");

	return { faux, ask: () => models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }) };
}

describe("the meter's accounting", () => {
	test("a row keeps DeepSeek's cache hits apart from the misses, and prices them when pi-ai reports no cost", () => {
		const meter = new Meter();
		const row = meter.record("turn", usage(100, 900, 50), "stop");
		assert.deepEqual([row.input, row.cacheRead, row.output], [100, 900, 50]);
		assert.equal(cachePercent(row), 90);
		assert.ok(Math.abs(row.costUsd - (100 * PRICE.input + 900 * PRICE.cacheRead + 50 * PRICE.output) / 1_000_000) < 1e-12);
		assert.equal(meter.record("compaction", usage(10, 0, 5, 0.5), "stop").costUsd, 0.5, "a cost pi-ai reports is used as given");
	});

	test("totals are split by kind and add up", () => {
		const meter = new Meter();
		meter.record("turn", usage(100, 100, 10), "toolUse");
		meter.record("turn", usage(50, 150, 20), "stop");
		meter.record("compaction", usage(30, 0, 7), "stop");
		assert.deepEqual(meter.totals("turn"), { calls: 2, input: 150, cacheRead: 250, output: 30, costUsd: meter.totals("turn").costUsd });
		assert.equal(meter.totals().calls, 3);
		assert.equal(meter.totals().input, 180);
		assert.ok(Math.abs(meter.costUsd - meter.totals().costUsd) < 1e-12);
		assert.match(meter.summary(), /spend: 3 of 60 calls/);
	});
});

describe("the spending cap", () => {
	test("the call after the call limit is refused, and the meter stays tripped", () => {
		const meter = new Meter({ maxCalls: 2 });
		meter.admit();
		meter.admit();
		assert.throws(() => meter.admit(), CapExceeded);
		assert.throws(() => meter.admit(), /2 model calls \(limit 2\)/);
		assert.match(meter.summary(), /ABORTED: spending cap reached/);
	});

	test("the cost limit trips on spend already recorded", () => {
		const meter = new Meter({ maxCostUsd: 0.001 });
		meter.admit();
		meter.record("turn", usage(0, 0, 0, 0.002), "stop");
		assert.throws(() => meter.admit(), /\$0\.0020 spent \(limit \$0\.001\)/);
	});

	test("defaults are 60 calls or $0.25", () => {
		assert.deepEqual(new Meter().limits, { maxCalls: 60, maxCostUsd: 0.25 });
	});

	test("through a provider: requests are recorded, and the one past the limit never reaches the model", async () => {
		const meter = new Meter({ maxCalls: 2 });
		const { faux, ask } = fauxModels(meter, 5);
		assert.equal((await ask()).stopReason, "stop");
		assert.equal((await ask()).stopReason, "stop");
		assert.equal(meter.rows.length, 2);
		assert.deepEqual(meter.rows.map((r) => r.kind), ["turn", "turn"]);
		assert.ok(meter.rows.every((r) => r.input + r.cacheRead > 0 && r.output > 0), "faux usage is estimated from the text");
		const refused = await ask();
		assert.equal(refused.stopReason, "error");
		assert.match(refused.errorMessage ?? "", /spending cap reached/);
		assert.equal(faux.getPendingResponseCount(), 3, "the refused request consumed no scripted reply");
		assert.equal(meter.rows.length, 2, "a refused request leaves no row");
		assert.ok(meter.tripped instanceof CapExceeded);
	});
});
