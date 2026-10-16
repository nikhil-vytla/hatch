// Property checks and seeded randomness. A check may state what must always hold over many runs (`{args, holds, runs}`)
// instead of naming one exact result, and every execution draws from a deterministic stream so a replay or a rerun
// reproduces what the first call saw.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { CatalogueEntry } from "../src/catalogue-doc.ts";
import { type Check, type PropertyCheck } from "../src/cells.ts";
import { owedChecks } from "../src/gate.ts";
import { parseProposal } from "../src/proposal.ts";
import { type Forge, openForge, verifyOnly, version } from "./support.ts";

const D20_RULE = "return Number.isInteger(r) && r >= 1 && r <= 20;";

const D20_SOURCE = "return 1 + Math.floor(Math.random() * 20);";

const D20_CHECK: PropertyCheck = { args: {}, holds: D20_RULE, runs: 50 };

// A `fixed` argument picks a deterministic branch, so a successor can carry an exact check of its own.
const RNG_SOURCE = `if (args.fixed !== undefined) return args.fixed;
return 1 + Math.floor(Math.random() * 20);`;

const RNG_PARAMETERS = { type: "object", properties: { fixed: { type: "integer" } } };

const RNG_CHECK: PropertyCheck = { args: {}, holds: D20_RULE, runs: 10 };

let dir = "";

let forge: Forge;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "property-checks-"));
	forge = await openForge(dir);
});

after(async () => {
	await forge.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("seeded randomness", () => {
	test("a call id seeds Math.random: the same id draws the same number, another id can differ", async () => {
		const same = await forge.runtime.run("return Math.random();", {}, forge.runtime.statePath("seed-same"), "call:same");
		const again = await forge.runtime.run("return Math.random();", {}, forge.runtime.statePath("seed-again"), "call:same");
		const other = await forge.runtime.run("return Math.random();", {}, forge.runtime.statePath("seed-other"), "call:other");

		assert.equal(same, again);
		assert.notEqual(same, other);
	});

	test("rand() is the same stream as Math.random", async () => {
		const alias = await forge.runtime.run("return [rand === Math.random, Math.random() !== rand()];", {}, forge.runtime.statePath("seed-alias"), "call:alias");

		assert.deepEqual(alias, [true, true]);
	});

	test("verifying the same candidate twice gives the same verdict", async () => {
		const candidate = version("verify-twice", D20_SOURCE, { checks: [{ args: {}, holds: D20_RULE, runs: 5 }] });
		const first = await forge.runtime.verify("verify-twice", candidate, [candidate.checks], []);
		const second = await forge.runtime.verify("verify-twice", candidate, [candidate.checks], []);

		assert.deepEqual(first, second);
	});

	test("a recorded random call replays without a difference", async () => {
		const candidate = version("trace-rng", D20_SOURCE, { checks: [] });
		await forge.runtime.call(candidate, "trace-rng", {}, "trace:1");
		const [trace] = await forge.runtime.traces("trace-rng", 1);
		const outcome = await forge.runtime.replay("trace-rng", { source: D20_SOURCE }, trace);

		assert.deepEqual(outcome, { result: trace.result, after: trace.after });
	});
});

describe("property checks through the gate", () => {
	test("a d20 tool with a property check is accepted", async () => {
		const outcome = await verifyOnly(forge, version("d20", D20_SOURCE, { checks: [D20_CHECK] }), { expectLive: null, owned: [], changes: [] });

		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
	});

	test("an off-by-one d20 fails the property check, naming the run and the bad result", async () => {
		const outcome = await verifyOnly(forge, version("offbyone", "return Math.floor(Math.random() * 20);", { checks: [D20_CHECK] }), { expectLive: null, owned: [], changes: [] });

		assert.equal(outcome.ok, false);
		assert.match(outcome.ok ? "" : outcome.reason, /group 0 check 0 \{\}: rule returned false \(not true\) on run \d+ of 50 \(seed .+\): r = 0/);
	});

	test("a rule that accepts every decoy is refused", async () => {
		const check: PropertyCheck = { args: {}, holds: "return true;" };
		const outcome = await verifyOnly(forge, version("useless", D20_SOURCE, { checks: [check] }), { expectLive: null, owned: [], changes: [] });

		assert.match(outcome.ok ? "" : outcome.reason, /rule never fails: it accepts null, -1, 1e9, "" ... as results, so it checks nothing/);
	});

	test("a successor that breaks a ratcheted property check is rejected without repeating it", async () => {
		const v1 = version("rng", RNG_SOURCE, { parameters: RNG_PARAMETERS, checks: [RNG_CHECK] });

		const broken = `if (args.fixed !== undefined) return args.fixed;
return 0;`;

		const successor = version("rng", broken, { parameters: RNG_PARAMETERS, checks: [{ args: { fixed: 7 }, expect: 7 }], parent: v1.version });
		const entry: CatalogueEntry = { live: v1.version, pending: null, versions: { [v1.version]: v1 }, history: [v1.version] };
		const verdict = await forge.runtime.verify("rng", successor, owedChecks(entry, successor), []);

		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.reason, /rule returned false \(not true\) on run/);
	});

	test("retiring the identical property check lets the successor go", async () => {
		const v1 = version("rng-retired", RNG_SOURCE, { parameters: RNG_PARAMETERS, checks: [RNG_CHECK] });

		const broken = `if (args.fixed !== undefined) return args.fixed;
return 0;`;

		const successor = version("rng-retired", broken, { parameters: RNG_PARAMETERS, checks: [{ args: { fixed: 7 }, expect: 7 }], retired: [RNG_CHECK], parent: v1.version });
		const entry: CatalogueEntry = { live: v1.version, pending: null, versions: { [v1.version]: v1 }, history: [v1.version] };
		const owed = owedChecks(entry, successor);

		assert.deepEqual(owed, [[{ args: { fixed: 7 }, expect: 7 }]], "the retired property check is gone");
		assert.deepEqual(await forge.runtime.verify("rng-retired", successor, owed, []), { ok: true });
	});

	test("a property check counts for action coverage", async () => {
		const parameters = { type: "object", properties: { op: { enum: ["roll", "fixed"] } }, required: ["op"] };

		const source = `if (args.op === "fixed") return 7;
return 1 + Math.floor(Math.random() * 20);`;

		const onlyFixed: Check[] = [{ args: { op: "fixed" }, expect: 7 }];
		const missing = await verifyOnly(forge, version("coverage", source, { parameters, checks: onlyFixed }), { expectLive: null, owned: [], changes: [] });

		assert.match(missing.ok ? "" : missing.reason, /checks do not exercise every action: op="roll"/);

		const covered: Check[] = [{ args: { op: "roll" }, holds: D20_RULE, runs: 3 }, ...onlyFixed];
		const outcome = await verifyOnly(forge, version("coverage", source, { parameters, checks: covered }), { expectLive: null, owned: [], changes: [] });

		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
	});

	test("a rule that writes kv fails read-only and leaves the live state alone", async () => {
		const source = `const n = (await kv.get("n")) ?? 0;
await kv.put("n", n + 1);
return n + 1;`;

		const check: PropertyCheck = { args: {}, holds: "await globalThis.kv.put('rule', 1); return r >= 1;", runs: 3 };
		const candidate = version("writes", source, { checks: [check] });
		const live = version("writes", "return await kv.keys();", { checks: [] });

		await forge.runtime.call(version("writes", source, { checks: [] }), "writes", {});
		const verdict = await forge.runtime.verify("writes", candidate, [[check]], []);

		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.reason, /rule threw on run 0.*kv is read-only/);
		assert.deepEqual(await forge.runtime.call(live, "writes", {}), ["n"], "the rule wrote nothing to the live state");
	});
});

describe("parseProposal checks", () => {
	const raw = { name: "dice", description: "roll", parameters: { type: "object" }, source: D20_SOURCE, expectLive: null };

	test("runs outside 1..100 is refused", () => {
		assert.throws(() => parseProposal({ ...raw, checks: [{ args: {}, holds: "return true;", runs: 0 }] }), /runs must be an integer from 1 to 100/);
		assert.throws(() => parseProposal({ ...raw, checks: [{ args: {}, holds: "return true;", runs: 1000 }] }), /runs must be an integer from 1 to 100/);
	});

	test("a check with neither expect nor holds is refused", () => {
		// The malformed shape has to reach the parser as raw JSON: parseProposal is the boundary that must reject it.
		const malformed = JSON.parse(JSON.stringify({ ...raw, checks: [{ args: {} }] }));

		assert.throws(() => parseProposal(malformed), /a check is \{ args, expect \} or \{ args, holds, runs \}/);
	});

	test("a property check parses with the default runs", () => {
		const parsed = parseProposal({ ...raw, checks: [{ args: {}, holds: "return true;" }] });

		assert.deepEqual(parsed.checks, [{ args: {}, holds: "return true;", runs: 20 }]);
	});
});

// The rule is model-written and runs next to the harness code that judges it. These rules try to stop that code from
// seeing the bad result; the judging code is scoped where a rule body built by `new Function` cannot reach it.
describe("a rule cannot skip the results it judges", () => {
	const RANGE = "return Number.isInteger(r) && r >= 1 && r <= 20;";

	for (const [label, prefix] of [
		["empties the results array", "try { results.length = 0; } catch (e) {} "],
		["reaches for it on globalThis", "try { globalThis.results.length = 0; } catch (e) {} "],
		["redefines Array.prototype.length", "try { Object.defineProperty(Array.prototype, 'length', { get() { return 0; } }); } catch (e) {} "],
	] as const) {
		test(`a rule that ${label} still fails an off-by-one d20`, async () => {
			const check: PropertyCheck = { args: {}, holds: prefix + RANGE, runs: 50 };
			const outcome = await verifyOnly(forge, version(`cheat${label.length}`, "return Math.floor(Math.random() * 20);", { checks: [check] }), { expectLive: null, owned: [], changes: [] });

			assert.equal(outcome.ok, false);
			assert.match(outcome.ok ? "" : outcome.reason, /rule returned false \(not true\) on run \d+ of 50 .*: r = 0/);
		});
	}
});

// Models write rules as expressions as often as bodies. In a live run every rule was an expression, the body form
// returned undefined, and 25 proposals failed with results that were right.
describe("a rule may be an expression or a function body", () => {
	test("an expression rule accepts a correct d20", async () => {
		const check: PropertyCheck = { args: {}, holds: "Number.isInteger(r) && r >= 1 && r <= 20", runs: 30 };
		const outcome = await verifyOnly(forge, version("exprd20", D20_SOURCE, { checks: [check] }), { expectLive: null, owned: [], changes: [] });

		assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
	});

	test("an expression rule rejects an off-by-one d20 and says what it returned", async () => {
		const check: PropertyCheck = { args: {}, holds: "r >= 1 && r <= 20", runs: 50 };
		const outcome = await verifyOnly(forge, version("exproff", "return Math.floor(Math.random() * 20);", { checks: [check] }), { expectLive: null, owned: [], changes: [] });

		assert.match(outcome.ok ? "" : outcome.reason, /rule returned false \(not true\) on run \d+ of 50 .*: r = 0/);
	});

	test("a body that forgets `return` is reported as returning undefined", async () => {
		const check: PropertyCheck = { args: {}, holds: "const ok = r >= 1; ok;", runs: 5 };
		const outcome = await verifyOnly(forge, version("noreturn", D20_SOURCE, { checks: [check] }), { expectLive: null, owned: [], changes: [] });

		assert.match(outcome.ok ? "" : outcome.reason, /rule returned undefined \(not true\)/);
	});
});
