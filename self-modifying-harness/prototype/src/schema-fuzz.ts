// Argument fuzzing from a cell's `parameters` JSON Schema, for the gate.
//
// Pure and seeded: the same (schema, n, seed) always yields the same arguments, so a failing fuzz case can be
// replayed from its seed. The generator leans on boundary values (0, -1, 1, huge numbers, "", unicode, [], every enum
// member) because that is where agent-written code breaks. Supported: object (properties, required), enum, string,
// number, integer, boolean, array, and `type` given as a list (the first non-null type wins).
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";

type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";

// The schema, parsed once from untyped JSON into the only shapes the generator knows about.
type Schema =
	| { kind: "object"; properties: [string, Schema][]; required: Set<string> }
	| { kind: "enum"; members: JsonValue[] }
	| { kind: "string"; minLength: number; maxLength: number }
	| { kind: "number"; minimum: number | undefined; maximum: number | undefined }
	| { kind: "integer"; minimum: number | undefined; maximum: number | undefined }
	| { kind: "boolean" }
	| { kind: "array"; items: Schema; minItems: number; maxItems: number }
	| { kind: "any" };

const INTEGERS = [0, 1, -1, 2, 255, 256, 2_147_483_647, -2_147_483_648, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];

// No NaN or Infinity: neither is JSON.
const NUMBERS = [0, 1, -1, 0.5, -0.5, 1.5, 1e-7, 1e21, 1e308, -1e308, Number.MIN_VALUE, Number.EPSILON];

const STRINGS = [
	"",
	" ",
	"a",
	"0",
	"null",
	"line\nbreak",
	"quote\"and'apostrophe",
	"'; DROP TABLE kv; --",
	"__proto__",
	"héllo wörld",
	"日本語",
	"😀",
	"é",
	"a".repeat(1_000),
];

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-éü日😀";

const MAX_DEFAULT_ITEMS = 5;

function kindOf(value: JsonValue): Kind {
	if (value === null) return "null";

	if (Array.isArray(value)) return "array";

	switch (value.constructor) {
		case String:
			return "string";
		case Number:
			return "number";
		case Boolean:
			return "boolean";
		default:
			return "object";
	}
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && kindOf(value) === "object";
}

function numberField(schema: JsonObject, key: string): number | undefined {
	const value = schema[key];

	return value !== undefined && kindOf(value) === "number" ? Number(value) : undefined;
}

function typeName(schema: JsonObject): string | undefined {
	const declared = schema.type;

	if (declared === undefined) return undefined;

	if (Array.isArray(declared)) return declared.map(String).find((name) => name !== "null");

	return String(declared);
}

function parseSchema(raw: JsonObject): Schema {
	const members = raw.enum;

	if (Array.isArray(members) && members.length > 0) return { kind: "enum", members };

	const name = typeName(raw);
	const properties = raw.properties;

	if (name === "object" || (name === undefined && isObject(properties))) {
		const entries = isObject(properties) ? Object.entries(properties) : [];
		const required = Array.isArray(raw.required) ? raw.required.map(String) : [];

		return {
			kind: "object",
			properties: entries.map(([key, child]) => [key, isObject(child) ? parseSchema(child) : { kind: "any" }]),
			required: new Set(required),
		};
	}

	switch (name) {
		case "string":
			return { kind: "string", minLength: numberField(raw, "minLength") ?? 0, maxLength: numberField(raw, "maxLength") ?? Infinity };
		case "number":
			return { kind: "number", minimum: numberField(raw, "minimum"), maximum: numberField(raw, "maximum") };
		case "integer":
			return { kind: "integer", minimum: numberField(raw, "minimum"), maximum: numberField(raw, "maximum") };
		case "boolean":
			return { kind: "boolean" };
		case "array":
		case undefined: {
			if (name === undefined && !isObject(raw.items)) return { kind: "any" };

			const minItems = numberField(raw, "minItems") ?? 0;
			const maxItems = numberField(raw, "maxItems") ?? minItems + MAX_DEFAULT_ITEMS;
			const items = isObject(raw.items) ? parseSchema(raw.items) : { kind: "any" as const };

			return { kind: "array", items, minItems, maxItems };
		}

		default:
			return { kind: "any" };
	}
}

/** mulberry32: a small deterministic PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

type Presence = "required" | "all" | "random";

class Generator {
	private readonly random: () => number;
	// Enum members are dealt round-robin per property path, so n >= members guarantees every member appears.
	private readonly enumCursor = new Map<string, number>();

	constructor(seed: number) {
		this.random = mulberry32(seed);
	}

	private chance(p: number): boolean {
		return this.random() < p;
	}

	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)];
	}

	private between(low: number, high: number): number {
		return low + Math.floor(this.random() * (high - low + 1));
	}

	object(schema: Schema, presence: Presence, path: string): JsonObject {
		if (schema.kind !== "object") return {};

		const entries: [string, JsonValue][] = [];

		for (const [key, child] of schema.properties) {
			const wanted = schema.required.has(key) || presence === "all" || (presence === "random" && this.chance(0.5));

			if (wanted) entries.push([key, this.value(child, `${path}.${key}`)]);
		}

		// fromEntries defines own properties, so a key named "__proto__" stays data.
		return Object.fromEntries(entries);
	}

	private value(schema: Schema, path: string): JsonValue {
		switch (schema.kind) {
			case "object":
				return this.object(schema, "random", path);
			case "enum": {
				const cursor = this.enumCursor.get(path) ?? 0;
				this.enumCursor.set(path, cursor + 1);

				return schema.members[cursor % schema.members.length];
			}

			case "string":
				return this.string(schema.minLength, schema.maxLength);
			case "integer":
				return this.integer(schema.minimum, schema.maximum);
			case "number":
				return this.number(schema.minimum, schema.maximum);
			case "boolean":
				return this.chance(0.5);
			case "array":
				return this.array(schema, path);
			case "any":
				return this.any();
		}
	}

	private within(candidates: number[], minimum: number | undefined, maximum: number | undefined): number[] {
		return candidates.filter((n) => n >= (minimum ?? -Infinity) && n <= (maximum ?? Infinity));
	}

	private integer(minimum: number | undefined, maximum: number | undefined): number {
		const boundaries = this.within(INTEGERS, minimum, maximum);

		if (minimum !== undefined) boundaries.push(Math.ceil(minimum));

		if (maximum !== undefined) boundaries.push(Math.floor(maximum));

		if (boundaries.length > 0 && this.chance(0.6)) return this.pick(boundaries);

		const low = Math.ceil(minimum ?? (maximum === undefined ? -100 : maximum - 200));
		const high = Math.floor(maximum ?? low + 200);

		return high < low ? low : this.between(low, high);
	}

	private number(minimum: number | undefined, maximum: number | undefined): number {
		const boundaries = this.within(NUMBERS, minimum, maximum);

		if (minimum !== undefined) boundaries.push(minimum);

		if (maximum !== undefined) boundaries.push(maximum);

		if (boundaries.length > 0 && this.chance(0.5)) return this.pick(boundaries);

		const low = minimum ?? (maximum === undefined ? -100 : maximum - 200);
		const high = maximum ?? low + 200;

		return low + this.random() * (high - low);
	}

	private string(minLength: number, maxLength: number): string {
		let text = this.chance(0.5) ? this.pick(STRINGS) : this.randomString();

		if (!Number.isFinite(maxLength) && minLength <= 0) return text;

		// Slice by code point so a surrogate pair is never cut in half.
		const points = [...text];

		while (points.length < minLength) points.push(this.pick([...ALPHABET]));
		text = points.slice(0, Number.isFinite(maxLength) ? maxLength : points.length).join("");

		return text;
	}

	private randomString(): string {
		const alphabet = [...ALPHABET];
		const length = this.between(1, 12);

		return Array.from({ length }, () => this.pick(alphabet)).join("");
	}

	private array(schema: Schema & { kind: "array" }, path: string): JsonValue[] {
		const sizes = [0, 1, schema.minItems, schema.maxItems, this.between(2, 4)].filter((n) => n >= schema.minItems && n <= schema.maxItems);
		const size = this.pick(sizes.length > 0 ? sizes : [schema.minItems]);

		return Array.from({ length: size }, () => this.value(schema.items, `${path}[]`));
	}

	private any(): JsonValue {
		switch (this.between(0, 3)) {
			case 0:
				return this.integer(undefined, undefined);
			case 1:
				return this.string(0, Infinity);
			case 2:
				return this.chance(0.5);
			default:
				return null;
		}
	}
}

/**
 * `n` argument objects for a JSON Schema, deterministic in `seed`. The first is the smallest valid input (required
 * fields only) and the second the fullest (every property); later ones choose optional fields at random.
 */
export function generateArgs(schema: JsonObject, n: number, seed: number): JsonObject[] {
	const parsed = parseSchema({ ...schema, type: "object" });
	const generator = new Generator(seed);

	return Array.from({ length: n }, (_, i) => generator.object(parsed, i === 0 ? "required" : i === 1 ? "all" : "random", "$"));
}
