// Choosing models from flags and environment, and the meter's fallback to the model's own prices. Everything here uses
// a fake environment, so no real provider key is read and no request is made.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelCost, Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Meter } from "../src/live.ts";
import { chooseModels, flagValue, modelFlags, PREFERENCE_DEFAULTS, type ModelChoice } from "../src/model-config.ts";

/** Fake keys for every provider the tests name explicitly; only their presence matters. */
const KEYS = { OPENAI_API_KEY: "test", DEEPSEEK_API_KEY: "test", OPENROUTER_API_KEY: "test" } as const;

/** A models choice, or a failure if the resolver returned demo/error. */
function modelsChoice(choice: ModelChoice): Extract<ModelChoice, { kind: "models" }> {
	if (choice.kind !== "models") throw new Error(`expected models, got ${choice.kind}`);

	return choice;
}

describe("parsing model names and flags", () => {
	test("flagValue reads --name value and --name=value", () => {
		assert.equal(flagValue(["--model", "openai/gpt-5-mini"], "--model"), "openai/gpt-5-mini");
		assert.equal(flagValue(["--model=deepseek/deepseek-flash"], "--model"), "deepseek/deepseek-flash");
		assert.equal(flagValue(["--other", "x"], "--model"), undefined);
	});

	test("modelFlags collects the three model flags", () => {
		const flags = modelFlags(["--model=openai/gpt-5-mini", "--summary-model", "deepseek/deepseek-flash", "--base-url", "http://localhost:1/v1"]);
		assert.deepEqual(flags, { model: "openai/gpt-5-mini", summaryModel: "deepseek/deepseek-flash", baseUrl: "http://localhost:1/v1" });
	});

	test("a model id may hold slashes; only the first one separates provider from id", async () => {
		const choice = modelsChoice(await chooseModels({ env: KEYS, argv: ["--model", "openrouter/anthropic/claude-haiku-4.5"] }));
		assert.equal(choice.turn.model.provider, "openrouter");
		assert.equal(choice.turn.model.id, "anthropic/claude-haiku-4.5");
	});
});

describe("the precedence between flags and environment", () => {
	test("a flag beats the environment for the same choice", async () => {
		const choice = modelsChoice(await chooseModels({ env: { ...KEYS, FORGE_MODEL: "deepseek/deepseek-flash" }, argv: ["--model", "openai/gpt-5-mini"] }));
		assert.equal(choice.turn.model.provider, "openai");
		assert.equal(choice.turn.model.id, "gpt-5-mini");
	});

	test("FORGE_MODEL is used when no flag names a model", async () => {
		const choice = modelsChoice(await chooseModels({ env: { ...KEYS, FORGE_MODEL: "deepseek/deepseek-flash" }, argv: [] }));
		assert.equal(choice.turn.model.provider, "deepseek");
	});

	test("the summary model defaults to the turn model", async () => {
		const choice = modelsChoice(await chooseModels({ env: KEYS, argv: ["--model", "openai/gpt-5-mini"] }));
		assert.equal(choice.summary.model.provider, choice.turn.model.provider);
		assert.equal(choice.summary.model.id, choice.turn.model.id);
	});

	test("--summary-model is resolved separately", async () => {
		const choice = modelsChoice(await chooseModels({ env: KEYS, argv: ["--model", "openai/gpt-5-mini", "--summary-model", "deepseek/deepseek-flash"] }));
		assert.equal(choice.summary.model.provider, "deepseek");
		assert.equal(choice.summary.model.id, "deepseek-flash");
	});
});

describe("auto-pick and the demo fallback", () => {
	test("every auto-pick default exists in the pi-ai catalog", () => {
		const models = createModels();

		for (const provider of builtinProviders()) models.setProvider(provider);

		for (const [providerId, modelId] of PREFERENCE_DEFAULTS) {
			assert.notEqual(models.getModel(providerId, modelId), undefined, `${providerId}/${modelId}`);
		}
	});

	test("auto-pick takes the first preference provider with a credential", async () => {
		const choice = modelsChoice(await chooseModels({ env: { OPENAI_API_KEY: "test" }, argv: [] }));
		assert.equal(choice.turn.model.provider, "openai");
		assert.equal(choice.turn.model.id, "gpt-5.4-mini");
		assert.match(choice.turn.why, /OPENAI_API_KEY/);
	});

	test("no provider credential anywhere is the demo choice", async () => {
		const choice = await chooseModels({ env: {}, argv: [] });
		assert.equal(choice.kind, "demo");
	});
});

describe("bad input names what it knows", () => {
	test("a named model whose provider has no credential is refused before any request", async () => {
		const choice = await chooseModels({ env: { OPENAI_API_KEY: "test" }, argv: ["--model", "openai/gpt-5-mini", "--summary-model", "deepseek/deepseek-flash"] });

		if (choice.kind !== "error") throw new Error(`expected error, got ${choice.kind}`);
		assert.match(choice.message, /no credential configured for provider "deepseek"/);
	});

	test("an unknown provider lists the known providers", async () => {
		const choice = await chooseModels({ env: {}, argv: ["--model", "nope/gpt-5-mini"] });

		if (choice.kind !== "error") throw new Error(`expected error, got ${choice.kind}`);
		assert.match(choice.message, /unknown provider "nope"/);
		assert.match(choice.message, /anthropic/);
	});

	test("an unknown model lists the provider's models", async () => {
		const choice = await chooseModels({ env: {}, argv: ["--model", "deepseek/not-a-model"] });

		if (choice.kind !== "error") throw new Error(`expected error, got ${choice.kind}`);
		assert.match(choice.message, /unknown model "not-a-model" for provider "deepseek"/);
		assert.match(choice.message, /deepseek-flash/);
	});

	test("a bare model id is rejected outside the local endpoint", async () => {
		const choice = await chooseModels({ env: {}, argv: ["--model", "gpt-5-mini"] });

		if (choice.kind !== "error") throw new Error(`expected error, got ${choice.kind}`);
		assert.match(choice.message, /not provider\/modelId/);
	});
});

describe("the local OpenAI-compatible endpoint", () => {
	test("--base-url builds one zero-cost local provider for the named model", async () => {
		const choice = modelsChoice(await chooseModels({ env: {}, argv: ["--base-url", "http://localhost:11434/v1", "--model", "llama3.2"] }));
		assert.equal(choice.turn.provider.id, "local");
		assert.equal(choice.turn.model.id, "llama3.2");
		assert.equal(choice.turn.model.cost.input, 0);
		assert.equal(choice.turn.model.contextWindow, 128_000);
		assert.equal(choice.summary.model.id, "llama3.2");
	});

	test("--base-url accepts local/<modelId> and keeps slashes in the id", async () => {
		const choice = modelsChoice(await chooseModels({ env: {}, argv: ["--base-url", "http://localhost:8000/v1", "--model", "local/meta-llama/Llama-3.3"] }));
		assert.equal(choice.turn.model.id, "meta-llama/Llama-3.3");
	});

	test("FORGE_BASE_URL and FORGE_MODEL build the local provider", async () => {
		const choice = modelsChoice(await chooseModels({ env: { FORGE_BASE_URL: "http://localhost:1234/v1", FORGE_MODEL: "qwen2.5" }, argv: [] }));
		assert.equal(choice.turn.provider.id, "local");
		assert.equal(choice.turn.model.id, "qwen2.5");
	});

	test("a local provider is configured with or without FORGE_API_KEY", async () => {
		for (const env of [{}, { FORGE_API_KEY: "test" }]) {
			const choice = modelsChoice(await chooseModels({ env, argv: ["--base-url", "http://localhost:1/v1", "--model", "m"] }));
			const models = createModels();
			models.setProvider(choice.turn.provider);
			assert.notEqual(await models.getAuth("local"), undefined);
		}
	});

	test("--base-url without a model is an error", async () => {
		const choice = await chooseModels({ env: {}, argv: ["--base-url", "http://localhost:11434/v1"] });

		if (choice.kind !== "error") throw new Error(`expected error, got ${choice.kind}`);
		assert.match(choice.message, /needs a --model/);
	});
});

describe("pricing a request", () => {
	test("a zero reported cost falls back to the model's per-million prices", () => {
		const cost: ModelCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 };
		const usage: Usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, totalTokens: 4_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const row = new Meter().record("turn", usage, "stop", cost);
		assert.equal(row.costUsd, 3.6);
	});

	test("a reported total wins over the model's prices", () => {
		const cost: ModelCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 };
		const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9 } };
		assert.equal(new Meter().record("turn", usage, "stop", cost).costUsd, 9);
	});
});
