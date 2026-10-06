// OptChat memory, after Victor Taelin's spec (gist 91837951a5ce5b38f341ec1ba1df6449):
// an append-only log, a purely binary tree of one-line summaries over it, and a "view" that tiles the whole log under a
// byte budget and changes only near its end (append, then merge the most due pair; never split).
//
// The summarizer is pluggable. The default is deterministic (verbatim when it fits, else cut), so the prototype runs
// offline; a model-backed summarizer is a drop-in for `Summarizer`.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type Kind = "user" | "talk" | "tool" | "echo" | "note";

export type Message = { i: number; kind: Kind; text: string; date: string };

type Node = { l: number; i: number; text: string };

type Part = { l: number; i: number };

export type Summarizer = {
	compress(message: Message, context: string): string;
	merge(a: string, b: string, context: string): string;
};

export const NODE = 512;

const utf8 = new TextEncoder();

const bytes = (s: string) => utf8.encode(s).length;

/** Cut to at most n bytes without splitting a UTF-8 character. */
export function cut(s: string, n: number): string {
	if (bytes(s) <= n) return s;
	let out = s.slice(0, n);

	while (bytes(out) > n) out = out.slice(0, -1);

	return out;
}

export const truncatingSummarizer: Summarizer = {
	compress: (m) => cut(`${m.kind}: ${m.text.replace(/\s+/g, " ")}`, NODE - 3) + (bytes(`${m.kind}: ${m.text}`) > NODE ? "..." : ""),
	merge: (a, b) => {
		const half = Math.floor((NODE - 3) / 2);

		return `${cut(a, half)} | ${cut(b, NODE - 3 - Math.min(bytes(a), half))}`;
	},
};

export class Memory {
	readonly dir: string;
	readonly budget: number;
	readonly summarizer: Summarizer;
	readonly fsync: boolean;
	readonly root: Message[] = [];
	private readonly tree = new Map<string, string>(); // "l,i" -> text
	view: Part[] = [];

	constructor(dir: string, options: { budget?: number; summarizer?: Summarizer; fsync?: boolean } = {}) {
		this.dir = dir;
		this.budget = options.budget ?? 128_000;
		this.summarizer = options.summarizer ?? truncatingSummarizer;
		this.fsync = options.fsync ?? true;
		mkdirSync(dir, { recursive: true });

		for (const message of readRecords(join(dir, "main.jsonl"), parseMessage)) this.root.push(message);

		for (const node of readRecords(join(dir, "tree.jsonl"), parseNode)) {
			this.tree.set(`${node.l},${node.i}`, node.text);
		}

		// The view is not stored: fold it again from message 0 (spec section 5.2, "At load").
		for (let i = 0; i < this.root.length; i++) {
			this.view.push({ l: 0, i });
			this.fit(i + 1);
		}

		this.pump();
	}

	get length(): number {
		return this.root.length;
	}

	/** Append a message, fsync it, build what it makes buildable, refit the view. Returns its permanent id. */
	log(kind: Kind, text: string): number {
		const message: Message = { i: this.root.length, kind, text, date: new Date().toISOString() };
		append(join(this.dir, "main.jsonl"), message, this.fsync);
		this.root.push(message);
		this.view.push({ l: 0, i: message.i });
		this.buildEnding(message.i);
		this.fit(this.root.length);

		return message.i;
	}

	private built(l: number, i: number): boolean {
		return this.tree.has(`${l},${i}`);
	}

	private save(l: number, i: number, text: string): void {
		append(join(this.dir, "tree.jsonl"), { l, i, text }, this.fsync);
		this.tree.set(`${l},${i}`, text);
	}

	/** The nodes a new message completes: itself, then each parent whose range ends at it. */
	private buildEnding(m: number): void {
		this.build(0, m);

		for (let l = 1; (m + 1) % 2 ** l === 0; l++) this.build(l, (m + 1) / 2 ** l - 1);
	}

	private build(l: number, i: number): void {
		if (this.built(l, i)) return;

		if (l === 0) {
			const m = this.root[i];
			const whole = `${m.kind}: ${m.text}`;
			this.save(0, i, bytes(whole) <= NODE ? whole : this.summarizer.compress(m, this.render(i)));

			return;
		}

		const a = this.tree.get(`${l - 1},${2 * i}`)!;
		const b = this.tree.get(`${l - 1},${2 * i + 1}`)!;
		const free = `${a}\n${b}`;
		this.save(l, i, bytes(free) <= NODE ? free : this.summarizer.merge(a, b, this.render((i + 1) * 2 ** l)));
	}

	/** Build every node whose sources exist (at load, after a crash between a log write and its nodes). */
	private pump(): void {
		const T = this.root.length;

		for (let changed = true; changed; ) {
			changed = false;

			for (let l = 0; 2 ** l <= T; l++) {
				for (let i = 0; (i + 1) * 2 ** l <= T; i++) {
					if (this.built(l, i)) continue;

					if (l === 0) {
						const m = this.root[i];
						const whole = `${m.kind}: ${m.text}`;
						this.save(0, i, bytes(whole) <= NODE ? whole : this.summarizer.compress(m, this.render(i)));
						changed = true;
					} else if (this.built(l - 1, 2 * i) && this.built(l - 1, 2 * i + 1)) {
						const a = this.tree.get(`${l - 1},${2 * i}`)!;
						const b = this.tree.get(`${l - 1},${2 * i + 1}`)!;
						const free = `${a}\n${b}`;
						this.save(l, i, bytes(free) <= NODE ? free : this.summarizer.merge(a, b, this.render((i + 1) * 2 ** l)));
						changed = true;
					}
				}
			}
		}
	}

	private size(): number {
		return this.view.reduce((sum, p) => sum + bytes(this.tree.get(`${p.l},${p.i}`) ?? "(not summarized yet: zoom it)"), 0);
	}

	/** Merge the most due adjacent pair while over budget (OptMem's age rule: due = (T - start) / 2^(l+2)). */
	private fit(T: number): void {
		let size = this.size();

		while (size > this.budget) {
			let best = -1;
			let bestDue = -Infinity;

			for (let k = 0; k + 1 < this.view.length; k++) {
				const a = this.view[k];
				const b = this.view[k + 1];

				if (a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1 && this.built(a.l + 1, a.i / 2)) {
					const due = (T - a.i * 2 ** a.l) / 2 ** (a.l + 2);

					if (due > bestDue) {
						bestDue = due;
						best = k;
					}
				}
			}

			if (best < 0) break;
			const a = this.view[best];
			const parent = { l: a.l + 1, i: a.i / 2 };
			size -= bytes(this.tree.get(`${a.l},${a.i}`)!) + bytes(this.tree.get(`${a.l},${a.i + 1}`)!);
			size += bytes(this.tree.get(`${parent.l},${parent.i}`)!);
			this.view.splice(best, 2, parent);
		}
	}

	/** The view as the model sees it, covering messages before `upTo` (default: all). */
	render(upTo = this.root.length): string {
		const lines: string[] = [];

		for (const p of this.view) {
			const start = p.i * 2 ** p.l;

			if (start >= upTo) break;
			const text = this.tree.get(`${p.l},${p.i}`) ?? "(not summarized yet: zoom it)";
			lines.push(`${start}+${2 ** p.l}|${text.replace(/\n/g, " ")}`);
		}

		return `<chat>\n${lines.join("\n")}\n</chat>`;
	}

	/** Open line id+n into its two halves; n = 1 gives the message whole. */
	zoom(id: number, n: number): string {
		if (n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id + n > this.root.length) return `No line ${id}+${n}.`;

		if (n === 1) return `${id}+0|${this.root[id].kind}: ${this.root[id].text}`;
		const l = Math.log2(n) - 1;
		const i = (2 * id) / n;

		return [i, i + 1].map((j) => `${j * 2 ** l}+${2 ** l}|${this.tree.get(`${l},${j}`)}`).join("\n");
	}
}

// Both files are written only by `append` below, one record per line, so a line that parses is a record of that shape.
const parseMessage = (line: string): Message => JSON.parse(line);

const parseNode = (line: string): Node => JSON.parse(line);

function append(path: string, value: Message | Node, durable: boolean): void {
	const fd = openSync(path, "a");

	try {
		writeSync(fd, `${JSON.stringify(value)}\n`);

		if (durable) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function readRecords<T>(path: string, parse: (line: string) => T): T[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");

	if (raw.length > 0 && !raw.endsWith("\n")) appendFileSync(path, "\n"); // a torn last line gets its own line end
	const out: T[] = [];

	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;

		try {
			out.push(parse(line));
		} catch {
			console.warn(`optchat: skipping torn line in ${path}`);
		}
	}

	return out;
}
