// A live world: named functions plus managed JSON state, in one long-lived JS context.
//
// It plays the part of Jiti's SBCL image. Functions are top-level declarations in a `node:vm` context, so they are
// late-bound globals: redefining `total` changes what every caller of `total` gets on its next call, with no build
// step, as with non-inline global functions in Lisp. State is one JSON object, `state`, the world's only managed data
// (Jiti's reference adapter manages one readable table the same way).
//
// Like Jiti this is cooperative, not hostile-code isolation: a vm context has no `require` or `process`, and a timeout
// stops synchronous hangs, but code can still exhaust memory. Run untrusted worlds in a separate process.
import vm from "node:vm";

export type Snapshot = { functions: Record<string, string>; state: unknown };

export class World {
	private ctx!: vm.Context;
	functions = new Map<string, string>(); // name -> source of its declaration
	readonly timeoutMs: number;

	constructor(snapshot: Snapshot = { functions: {}, state: {} }, timeoutMs = 200) {
		this.timeoutMs = timeoutMs;
		this.restore(snapshot);
	}

	snapshot(): Snapshot {
		return { functions: Object.fromEntries(this.functions), state: this.state() };
	}

	/** Rebuild the context from a snapshot (a checkpoint restore). */
	restore(snapshot: Snapshot): void {
		this.ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
		// The caller's checks run in this realm too, so app code must not be able to redefine what they rely on.
		vm.runInContext(
			`for (const o of [Object, Array, String, Number, Boolean, Math, JSON, Function, Error, Set, Map, Date, RegExp, Symbol, Promise]) { Object.freeze(o); if (o.prototype) Object.freeze(o.prototype); } Object.freeze(globalThis.isFinite); Object.freeze(globalThis.isNaN);`,
			this.ctx,
		);
		this.functions = new Map();
		this.setState(snapshot.state);
		for (const source of Object.values(snapshot.functions)) this.define(source);
	}

	state(): unknown {
		// JSON round trip: the managed state must be plain data, and copies must not alias the live context.
		return JSON.parse(vm.runInContext("JSON.stringify(state)", this.ctx, { timeout: this.timeoutMs }) ?? "null");
	}

	setState(value: unknown): void {
		this.ctx.__incoming = JSON.stringify(value ?? {});
		vm.runInContext("var state = JSON.parse(__incoming); delete globalThis.__incoming;", this.ctx);
	}

	/** Define (or redefine) the functions declared in `source`. Returns their names. */
	define(source: string): string[] {
		const names = declaredFunctions(source);
		if (names.length === 0) throw new Error("no top-level function declaration found");
		// A form may only declare functions: any other top-level statement would be an unmanaged effect on the live
		// world that no revision records (and could tamper with the checks).
		let rest = source;
		for (const name of names) rest = rest.replace(extractDeclaration(rest, name), "");
		if (rest.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() !== "") throw new Error(`a form may only declare functions; found top-level code: ${rest.trim().slice(0, 60)}`);
		vm.runInContext(source, this.ctx, { timeout: this.timeoutMs, filename: `${names[0]}.js` });
		for (const name of names) this.functions.set(name, extractDeclaration(source, name));
		return names;
	}

	remove(name: string): void {
		vm.runInContext(`delete globalThis[${JSON.stringify(name)}]`, this.ctx);
		this.functions.delete(name);
	}

	/** Evaluate an expression in the world. Values come back as JSON (undefined becomes null). */
	evaluate(expr: string): unknown {
		const out = vm.runInContext(`JSON.stringify((() => (${expr}))() ?? null)`, this.ctx, { timeout: this.timeoutMs, filename: "expr.js" });
		return JSON.parse(out);
	}

	/** Evaluate while recording which world functions run (a dynamic call graph for trace replay). */
	traced(expr: string): { value: unknown; calls: string[] } {
		const names = [...this.functions.keys()];
		this.ctx.__calls = [];
		this.ctx.__names = names;
		vm.runInContext(
			`for (const n of __names) { const f = globalThis[n]; if (typeof f === "function") { globalThis[n] = function (...a) { __calls.push(n); return f.apply(this, a); }; globalThis[n].__original = f; } }`,
			this.ctx,
		);
		try {
			const value = this.evaluate(expr);
			return { value, calls: [...new Set(this.ctx.__calls as string[])] };
		} finally {
			vm.runInContext(`for (const n of __names) { if (globalThis[n] && globalThis[n].__original) globalThis[n] = globalThis[n].__original; } delete globalThis.__calls; delete globalThis.__names;`, this.ctx);
		}
	}
}

/** Names of the top-level `function name(` declarations in a source string. */
export function declaredFunctions(source: string): string[] {
	const names: string[] = [];
	let depth = 0;
	const re = /function\s+([A-Za-z_$][\w$]*)\s*\(|[{}]/g;
	for (let m = re.exec(source); m !== null; m = re.exec(source)) {
		if (m[0] === "{") depth++;
		else if (m[0] === "}") depth--;
		else if (depth === 0) names.push(m[1]);
	}
	return names;
}

/** The text of one top-level function declaration, so the catalog keeps each function's own source. */
export function extractDeclaration(source: string, name: string): string {
	const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
	if (start < 0) return source;
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
	}
	return source.slice(start);
}
