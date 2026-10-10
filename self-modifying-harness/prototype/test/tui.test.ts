// The TUI's pure renderers and a smoke test that drives it through a fake terminal: no model request, no real stdin, no
// alternate-screen escape reaching the test's own output. The fake backend replays one turn (a call, an ACCEPTED result,
// a reply) so the test can assert the transcript and the side panel both made it to the terminal, then Ctrl+C closes it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { foregroundAnsi, getTerminalColorMode, indexedColor, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { Catalogue } from "../src/catalogue-doc.ts";
import type { CellVersion } from "../src/cells.ts";
import type { TurnEvent, Turned, UsageRow } from "../src/live.ts";
import { type ChatBackend, footerLine, runTui, sidePanelLines, transcriptLine, type TuiState } from "../src/tui.ts";

const GREEN = foregroundAnsi(indexedColor(2), getTerminalColorMode());

const RED = foregroundAnsi(indexedColor(1), getTerminalColorMode());

/** A version with nothing but the fields the panel counts and names. */
function cellVersion(name: string, hash: string): CellVersion {
	return { version: `${name}@${hash}`, description: "", parameters: {}, source: "", checks: [], retired: [], invariants: [], replay: "unsafe" };
}

const CATALOGUE: Catalogue = {
	cells: {
		books: {
			live: "books@8732b307",
			pending: null,
			versions: { "books@8732b307": cellVersion("books", "8732b307"), "books@aaaabbbb": cellVersion("books", "aaaabbbb"), "books@ccccdddd": cellVersion("books", "ccccdddd") },
			history: ["books@8732b307", "books@aaaabbbb", "books@ccccdddd"],
		},
	},
	log: [
		{ at: "2024-01-01T00:00:00.000Z", event: "accepted books@8732b307" },
		{ at: "2024-01-01T00:00:01.000Z", event: "rejected books@ccccdddd: the checks failed" },
	],
};

const STATE: TuiState = { model: "deepseek/deepseek-flash", calls: 26, maxCalls: 300, spentUsd: 0.0194, capUsd: 1, dataDir: "~/.forge/default", status: "thinking..." };

const result = (text: string): TurnEvent => ({ kind: "result", name: "cell_propose", text, isError: false });

/** A recorder implementing pi-tui's `Terminal`; `send` feeds the input callback `tui.start` installed. */
class FakeTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly started: Promise<void>;
	columns = 120;
	rows = 30;
	kittyProtocolActive = false;
	private onData: ((data: string) => void) | undefined;
	private markStarted: () => void = () => {};

	constructor() {
		this.started = new Promise((resolve) => {
			this.markStarted = resolve;
		});
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onData = onInput;
		void onResize;
		this.markStarted();
	}

	stop(): void {
		this.onData = undefined;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	send(data: string): void {
		this.onData?.(data);
	}

	get all(): string {
		return this.writes.join("");
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	async drainInput(): Promise<void> {}
}

const METER_ROWS: readonly UsageRow[] = [];

/** A backend whose one turn is canned, so the smoke test never touches a model. */
class FakeBackend implements ChatBackend {
	closed = false;
	readonly meter = { rows: METER_ROWS, limits: { maxCalls: 300, maxCostUsd: 1 }, costUsd: 0, summary: () => "spend: 0 of 300 calls, $0.0000 of $1.00" };

	async ask(_text: string, onEvent?: (event: TurnEvent) => void): Promise<Turned> {
		const events: TurnEvent[] = [{ kind: "call", name: "cell_propose", args: '{"cell":"books","source":"..."}' }, result("ACCEPTED books@8732b307"), { kind: "reply", text: "Done: books is live." }];

		for (const event of events) onEvent?.(event);

		return { status: "done", reason: "", events, capped: undefined };
	}

	async catalogue(): Promise<Catalogue> {
		return CATALOGUE;
	}

	view(): string {
		return "<chat>\n1+1|hello\n</chat>";
	}

	usageLines(): string[] {
		return ["  #1 turn input 10 cache-read 90 (90%) output 5 $0.00010"];
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();

	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the TUI output");

		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("the transcript lines", () => {
	test("an ACCEPTED result is green and a REJECTED one is red", () => {
		const accepted = transcriptLine(result("ACCEPTED books@8732b307"), false);
		const rejected = transcriptLine(result("REJECTED books@e35a0000: stale"), false);

		assert.ok(accepted.includes(GREEN));
		assert.ok(accepted.includes("ACCEPTED books@8732b307"));
		assert.ok(rejected.includes(RED));
		assert.ok(rejected.includes("REJECTED books@e35a0000: stale"));
	});

	test("a long result stays on one clipped line until /verbose", () => {
		const long = "x".repeat(500);
		const short = transcriptLine(result(long), false);
		const full = transcriptLine(result(long), true);

		assert.equal(short.split("\n").length, 1);
		assert.ok(visibleWidth(short) < 250);
		assert.ok(full.includes(long));
	});

	test("a tool call is a dim one-liner", () => {
		const line = transcriptLine({ kind: "call", name: "cell_propose", args: JSON.stringify({ cell: "books" }) }, false);

		assert.ok(line.includes("cell_propose"));
		assert.ok(line.includes("\x1b[2m"));
	});
});

describe("the side panel", () => {
	test("lists each cell and the recent log", () => {
		const lines = sidePanelLines(CATALOGUE, 34);

		assert.ok(lines.some((line) => line.includes("books")));
		assert.ok(lines.some((line) => line.includes("3 versions")));
		assert.ok(lines.some((line) => line.includes("accepted books@8732b307")));
		assert.ok(lines.some((line) => line.includes("rejected books@ccccdddd")));
	});

	test("clips every line to the column", () => {
		for (const line of sidePanelLines(CATALOGUE, 20)) assert.ok(visibleWidth(line) <= 20, `too wide: ${JSON.stringify(line)}`);
	});

	test("says so when there is no catalogue yet", () => {
		assert.deepEqual(sidePanelLines(undefined, 24)[0], "tools");
	});
});

describe("the footer", () => {
	test("shows the model, calls, spend, data dir and state, clipped to the width", () => {
		const line = footerLine(STATE, 200);

		assert.ok(line.includes("deepseek/deepseek-flash"));
		assert.ok(line.includes("26/300 calls"));
		assert.ok(line.includes("$0.0194/$1.00"));
		assert.ok(line.includes("~/.forge/default"));
		assert.ok(line.includes("thinking..."));
		assert.ok(visibleWidth(footerLine(STATE, 40)) <= 40);
	});

	test("shows a capped state", () => {
		assert.ok(footerLine({ ...STATE, status: "capped: spending cap reached" }, 200).includes("capped: spending cap reached"));
	});
});

describe("the TUI smoke test", () => {
	test("renders a turn and closes the backend on Ctrl+C", async () => {
		const terminal = new FakeTerminal();
		const backend = new FakeBackend();
		const done = runTui(backend, { model: "deepseek/deepseek-flash", dataDir: "~/.forge/default" }, terminal);

		await terminal.started;
		terminal.send("hello");
		terminal.send("\r");
		await waitFor(() => terminal.all.includes("Done: books is live."));

		assert.ok(terminal.all.includes("books"), "the side panel names the cell");
		assert.ok(terminal.all.includes("3 versions"), "the side panel counts the versions");
		assert.ok(terminal.all.includes("ACCEPTED books@8732b307"));

		terminal.send("\x03");
		await done;

		assert.equal(backend.closed, true);
	});
});
