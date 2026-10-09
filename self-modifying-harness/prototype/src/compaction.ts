// What a compaction call is made of (spec section 4): the task text the model is given, the "Too long" retry loop that
// enforces the 512-byte limit, and the summarizer interface the memory's compactor calls.
//
// A compaction is a call like a turn: [tools] [system prompt] [<chat> compaction view </chat>] [task]. The memory builds
// the view and the task (it owns the tree); a summarizer only turns them into one line. `ModelSummarizer` does it with
// any `complete(messages) => Promise<string>`, so a real model plugs in with its tools and system prompt closed over;
// `truncatingSummarizer` is the deterministic offline default (verbatim when it fits, else cut), so nothing here needs
// a model to run.
import type { Message } from "./optchat.ts";

/** A node is at most this many bytes (spec section 2). */
export const NODE = 512;

/** A compaction tries at most this many times to get a reply that fits (spec section 4, "The size"). */
export const TRIES = 5;

/** The length of a full line, drawn for the model: models cannot count bytes, but they can copy a length. */
export const RULER = "-".repeat(NODE);

const utf8 = new TextEncoder();

export const bytes = (s: string): number => utf8.encode(s).length;

/** Cut to at most n bytes without splitting a UTF-8 character. */
export function cut(s: string, n: number): string {
	if (bytes(s) <= n) return s;
	let out = s.slice(0, n);

	while (bytes(out) > n) out = out.slice(0, -1);

	return out;
}

/** A line of the view as a compaction reads it: `id+n|text`. */
export type Line = { id: number; n: number; text: string };

export const lineName = (line: Line): string => `${line.id}+${line.n}`;

const asLine = (line: Line): string => `${lineName(line)}|${line.text.replace(/\n/g, " ")}`;

/** Compress one message into a line. `view` renders the compaction's own view lazily (a deterministic summarizer never asks). */
export type Compress = { id: number; message: Message; task: string; view: () => string };

/** Merge two adjacent lines into one; the merge covers messages `id` to `end`, both included. */
export type Merge = { id: number; end: number; a: Line; b: Line; task: string; view: () => string };

export type Summarizer = {
	compress(request: Compress): Promise<string>;
	merge(request: Merge): Promise<string>;
};

/** The task of a compress call, verbatim from spec section 4. */
export function compressTask(message: Message): string {
	return `Compaction: compress message ${message.i} into one line of at most ${NODE} bytes\n(about 70 words), the length of this ruler:\n${RULER}\n<input>\n${message.kind}: ${message.text}\n</input>`;
}

/** The task of a merge call, verbatim from spec section 4. */
export function mergeTask(a: Line, b: Line, id: number, end: number): string {
	return `Compaction: merge lines ${lineName(a)} and ${lineName(b)}, adjacent, into one line of at most\n${NODE} bytes (about 70 words), the length of this ruler:\n${RULER}\n<chat> may hold their messages, ${id} to ${end}, in more detail: take details\nof them from there too.\n<input>\n${asLine(a)}\n${asLine(b)}\n</input>`;
}

// The prompt says "output only the line, without an id+n| head", but a model still copies the head it sees in the view
// (the live DeepSeek run did, twice in 82 compactions), and a stored head would show twice in every rendered line.
const HEAD = /^\d+\+\d+\|\s*/;

function withoutHead(reply: string): string {
	return reply.trim().replace(HEAD, "");
}

/** The reply to a line that is over the limit, verbatim from spec section 4. */
export function tooLong(reply: string): string {
	return `Too long: your line is ${bytes(reply)} bytes, over the ${NODE}-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cut(reply, NODE)}| ← LIMIT`;
}

export type Role = "user" | "assistant";

/** One side of the conversation: a user turn holds the view and the task as two parts. */
export type Turn = { role: Role; parts: string[] };

/** One model call over a conversation (the caller supplies the system prompt, the tools and the model). */
export type Complete = (conversation: Turn[]) => Promise<string>;

/**
 * A summarizer backed by a model. A reply over 512 bytes gets the "Too long" turn in the same conversation, at most
 * `tries` times in all; the shortest reply is kept. A few bytes over is fine: the view measures real sizes.
 */
export class ModelSummarizer implements Summarizer {
	readonly complete: Complete;
	readonly tries: number;

	constructor(complete: Complete, tries: number = TRIES) {
		this.complete = complete;
		this.tries = tries;
	}

	compress(request: Compress): Promise<string> {
		return this.write(request.view, request.task);
	}

	merge(request: Merge): Promise<string> {
		return this.write(request.view, request.task);
	}

	private async write(view: () => string, task: string): Promise<string> {
		const conversation: Turn[] = [{ role: "user", parts: [view(), task] }];
		let best = "";

		for (let attempt = 1; attempt <= this.tries; attempt++) {
			const reply = withoutHead(await this.complete([...conversation]));

			if (attempt === 1 || bytes(reply) < bytes(best)) best = reply;

			if (bytes(reply) <= NODE) return reply;

			conversation.push({ role: "assistant", parts: [reply] }, { role: "user", parts: [tooLong(reply)] });
		}

		return best;
	}
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ");

/** The offline default: deterministic, no model. A message is cut to fit; a merge keeps both halves' beginnings. */
export const truncatingSummarizer: Summarizer = {
	compress: async (request) => {
		const whole = `${request.message.kind}: ${request.message.text}`;

		return cut(oneLine(whole), NODE - 3) + (bytes(whole) > NODE ? "..." : "");
	},
	merge: async (request) => {
		const half = Math.floor((NODE - 3) / 2);

		return `${cut(request.a.text, half)} | ${cut(request.b.text, NODE - 3 - Math.min(bytes(request.a.text), half))}`;
	},
};
