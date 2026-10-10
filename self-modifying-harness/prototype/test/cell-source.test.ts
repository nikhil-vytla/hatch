// `cell_source` on a version that does not exist: a rejected one explains itself, a short id resolves, and an unknown one
// names what does exist. A live run sent the model round three identical retries on a bare "no such cell".
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalogue } from "../src/catalogue-doc.ts";
import { sourceOf } from "../src/forge.ts";
import { version } from "./support.ts";

const live = version("party", "return 1;");

const catalogue: Catalogue = {
	cells: { party: { live: live.version, pending: null, history: [live.version], versions: { [live.version]: live } } },
	log: [{ at: "t", event: `accepted ${live.version}` }, { at: "t", event: "rejected party@9cbc43ec: group 1 check 12 threw" }],
};

test("a short version id resolves to the full one", () => {
	const found = sourceOf(catalogue, "party", live.version.slice("party@".length));

	assert.equal(found.ok, true);
});

test("a rejected version returns its rejection reasons, not an error", () => {
	const found = sourceOf(catalogue, "party", "9cbc43ec");

	assert.equal(found.ok, true);
	assert.match(found.ok ? found.text : "", /party@9cbc43ec was rejected, and rejected versions are not kept/);
	assert.match(found.ok ? found.text : "", /group 1 check 12 threw/);
});

test("an unknown version names the known ones", () => {
	const found = sourceOf(catalogue, "party", "deadbeef");

	assert.equal(found.ok, false);
	assert.match(found.ok ? "" : found.reason, new RegExp(`known: ${live.version}`));
});

test("an unknown cell says so", () => {
	assert.deepEqual(sourceOf(catalogue, "dice", undefined), { ok: false, reason: "no cell named dice" });
});
