// The forge's full-screen chat: the same one-line-in/one-turn-out loop as src/chat-loop.ts, but laid out as an
// alternate-screen app. The layout is a transcript that follows its end, an optional cell/log side panel, the editor and
// a one-line footer. Everything that can be checked without a terminal lives in the exported pure functions at the top,
// so src/tui.ts is only responsible for wiring them to pi-tui and the backend seam. `runTui` drives a `ChatBackend`, not
// `Live` directly, so the smoke test can run it against canned events and a fake `Terminal` with no model request.
import { type Color, type Component, Container, Editor, type EditorTheme, getTerminalColorMode, HStack, indexedColor, Markdown, type MarkdownTheme, matchesKey, ProcessTerminal, ScrollView, type StackChild, type StackEntry, styleText, type Terminal, Text, truncateToWidth, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { usageRow } from "./chat-loop.ts";
import type { Catalogue } from "./catalogue-doc.ts";
import type { Limits, Live, TurnEvent, Turned, UsageRow } from "./live.ts";

/** What the TUI needs from the chat, so a test can stand in without a model. */
export type MeterView = {
	readonly rows: readonly UsageRow[];
	readonly limits: Limits;
	readonly costUsd: number;
	summary(): string;
};

export type ChatBackend = {
	ask(text: string, onEvent?: (event: TurnEvent) => void): Promise<Turned>;
	catalogue(): Promise<Catalogue>;
	view(): string;
	usageLines(): string[];
	meter: MeterView;
	close(): Promise<void>;
};

/** The facts the footer shows that come from the command line rather than the meter. */
export type TuiInfo = { readonly model: string; readonly dataDir: string };

/** The footer's contents; `status` is `ready`, `thinking...` or `capped: ...`. */
export type TuiState = {
	model: string;
	calls: number;
	maxCalls: number;
	spentUsd: number;
	capUsd: number;
	dataDir: string;
	status: string;
};

/** The side panel is a fixed column, and only when the terminal has room for the transcript beside it. */
export const PANEL_WIDTH = 34;

export const PANEL_MIN_COLUMNS = 100;

const GREEN = indexedColor(2);

const RED = indexedColor(1);

const paint = (text: string, color: Color): string => styleText(text, { fg: color }, getTerminalColorMode());

const dim = (text: string): string => styleText(text, { dim: true }, getTerminalColorMode());

/** Collapse whitespace and clip, so a tool result stays one line unless `/verbose` is on. */
const clip = (text: string, n: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();

	return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

/** `name@sha` to just the version part, which is what the cell already names. */
const shortVersion = (version: string): string => {
	const at = version.indexOf("@");

	return at === -1 ? version : version.slice(at);
};

/** An ACCEPTED result turns green, REJECTED/REFUSED red, anything else stays plain and one line. */
function resultLine(text: string, isError: boolean, verbose: boolean): string {
	const shown = verbose ? text : clip(text, 200);
	const line = `  result ${isError ? "(error) " : ""}${shown}`;

	if (shown.startsWith("ACCEPTED")) return paint(line, GREEN);

	if (shown.startsWith("REJECTED") || shown.startsWith("REFUSED")) return paint(line, RED);

	return line;
}

/** One transcript line for a call or a result. Agent replies go through `Markdown` instead. */
export function transcriptLine(event: TurnEvent, verbose: boolean): string {
	switch (event.kind) {
		case "call":
			return dim(`  call   ${event.name} ${verbose ? event.args : clip(event.args, 110)}`);
		case "result":
			return resultLine(event.text, event.isError, verbose);
		case "reply":
			return `agent> ${event.text}`;
	}
}

const logLine = (event: string): string => {
	if (event.startsWith("accepted")) return `${paint("+", GREEN)} ${paint(event, GREEN)}`;

	if (event.startsWith("rejected")) return `${paint("x", RED)} ${paint(event, RED)}`;

	return `${dim("·")} ${dim(event)}`;
};

/** The tools column: every cell with its live version and version count, then the last few catalog events. */
export function sidePanelLines(catalogue: Catalogue | undefined, width: number): string[] {
	const lines: string[] = ["tools"];

	if (catalogue === undefined) {
		lines.push(dim("  (loading...)"));
	} else if (Object.keys(catalogue.cells).length === 0) {
		lines.push(dim("  (no cells)"));
	} else {
		for (const [name, entry] of Object.entries(catalogue.cells)) {
			const live = entry.live === null ? "pending" : shortVersion(entry.live);
			const pending = entry.pending === null ? "" : `, pending ${shortVersion(entry.pending)}`;

			lines.push(` ${name}  ${live}`);
			lines.push(dim(`   ${Object.keys(entry.versions).length} versions${pending}`));
		}
	}

	lines.push("log");

	const recent = catalogue === undefined ? [] : catalogue.log.slice(-8);

	if (recent.length === 0) lines.push(dim("  (empty)"));

	for (const entry of recent) lines.push(logLine(entry.event));

	return lines.map((line) => truncateToWidth(line, width));
}

/** The single footer line, clipped to the terminal width; the status leads so a long data path never hides it. */
export function footerLine(state: TuiState, width: number): string {
	const line = `${state.status} | ${state.model} | ${state.calls}/${state.maxCalls} calls $${state.spentUsd.toFixed(4)}/$${state.capUsd.toFixed(2)} | ${state.dataDir}`;

	return truncateToWidth(line, width);
}

/** One mutable, always-one-line component: the footer and the transcript's plain lines. */
class Line implements Component {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [truncateToWidth(this.text, width)];
	}
}

/** A fixed block of already-styled lines: `/view` and `/usage`. */
class Block implements Component {
	private readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width));
	}
}

/** The side panel recomputes from the catalogue on every render, so it always fits the column it was given. */
class Panel implements Component {
	private catalogue: Catalogue | undefined;

	setCatalogue(catalogue: Catalogue): void {
		this.catalogue = catalogue;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const bar = dim("│ ");

		return sidePanelLines(this.catalogue, width - 2).map((line) => bar + line);
	}
}

const MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => styleText(text, { bold: true, underline: true }, getTerminalColorMode()),
	link: (text) => styleText(text, { underline: true }, getTerminalColorMode()),
	linkUrl: dim,
	code: (text) => styleText(text, { fg: indexedColor(6) }, getTerminalColorMode()),
	codeBlock: (text) => text,
	codeBlockBorder: dim,
	quote: dim,
	quoteBorder: dim,
	hr: dim,
	listBullet: (text) => text,
	bold: (text) => styleText(text, { bold: true }, getTerminalColorMode()),
	italic: (text) => styleText(text, { italic: true }, getTerminalColorMode()),
	strikethrough: (text) => styleText(text, { strikethrough: true }, getTerminalColorMode()),
	underline: (text) => styleText(text, { underline: true }, getTerminalColorMode()),
};

const EDITOR_THEME: EditorTheme = {
	borderColor: dim,
	selectList: {
		selectedPrefix: (text) => paint(text, indexedColor(4)),
		selectedText: (text) => styleText(text, { bold: true }, getTerminalColorMode()),
		description: dim,
		scrollInfo: dim,
		noMatch: dim,
	},
};

/** Wrap an open `Live` as the TUI's backend, keeping the meter live for the footer. */
export function backendOf(live: Live): ChatBackend {
	return {
		ask: (text, onEvent) => live.ask(text, onEvent),
		catalogue: () => live.catalogue(),
		view: () => live.memory.render(),
		usageLines: () => live.meter.rows.map(usageRow),
		meter: live.meter,
		close: () => live.close(),
	};
}

/**
 * Run the full-screen chat until `/quit`, Ctrl+C or `/capped`. The transcript is appended to as events arrive, the side
 * panel is reloaded after each turn, and the footer is refreshed during a turn so the call count moves. On exit the
 * alternate screen is restored, the backend is closed, and the meter's summary is printed to the normal screen.
 */
export async function runTui(backend: ChatBackend, info: TuiInfo, terminal: Terminal = new ProcessTerminal()): Promise<void> {
	const tui = new TuiAltScreen(terminal);
	const transcript = new Container();
	const transcriptView = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain" });
	const panel = new Panel();
	const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 });
	const footer = new Line("");
	const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let turnStarted = 0;

	const home = homedir();
	const dataDir = info.dataDir.startsWith(home) ? `~${info.dataDir.slice(home.length)}` : info.dataDir;
	const state: TuiState = { model: info.model, calls: 0, maxCalls: backend.meter.limits.maxCalls, spentUsd: 0, capUsd: backend.meter.limits.maxCostUsd, dataDir, status: "ready" };
	let busy = false;
	let capped = false;
	let verbose = false;
	let showCells = true;
	let leaving = false;
	let refreshTimer: NodeJS.Timeout | undefined;
	let finish: () => void = () => {};

	const exited = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const add = (component: Component): void => {
		transcript.addChild(component);
		tui.requestRender();
	};

	const note = (text: string): void => add(new Line(dim(text)));

	const syncFooter = (): void => {
		state.calls = backend.meter.rows.length;
		state.spentUsd = backend.meter.costUsd;
		footer.setText(footerLine(state, terminal.columns));
	};

	const setStatus = (status: string): void => {
		state.status = status;
		syncFooter();
		tui.requestRender();
	};

	const onEvent = (event: TurnEvent): void => {
		if (event.kind === "reply") transcript.addChild(new Markdown(event.text, 1, 0, MARKDOWN_THEME));
		else transcript.addChild(new Line(transcriptLine(event, verbose)));

		tui.requestRender();
	};

	const refreshPanel = async (): Promise<void> => {
		panel.setCatalogue(await backend.catalogue());
		tui.requestRender();
	};

	const turn = async (text: string): Promise<void> => {
		busy = true;
		turnStarted = Date.now();
		setStatus(`${spinner[0]} thinking...`);
		// The meter's rows grow as requests finish, so the call count, spend and elapsed time move while the turn runs.
		refreshTimer = setInterval(() => {
			const seconds = Math.floor((Date.now() - turnStarted) / 1000);

			setStatus(`${spinner[Math.floor((Date.now() - turnStarted) / 200) % spinner.length]} thinking... ${seconds}s`);
		}, 200);

		try {
			const turned = await backend.ask(text, onEvent);
			await refreshPanel();

			if (turned.capped !== undefined) {
				capped = true;
				state.status = `capped: ${turned.capped.message}`;
				add(new Line(paint(`capped: ${turned.capped.message}`, RED)));
			} else if (turned.status !== "done") {
				note(`  -> ${turned.status} ${turned.reason}`);
			}
		} catch (error) {
			note(`turn failed: ${error instanceof Error ? error.message : "unknown error"}`);
		} finally {
			busy = false;

			if (refreshTimer !== undefined) {
				clearInterval(refreshTimer);
				refreshTimer = undefined;
			}

			if (capped) syncFooter();
			else setStatus("ready");

			tui.requestRender();
		}
	};

	const submit = async (text: string): Promise<void> => {
		const value = text.trim();

		if (value === "") return;

		if (value === "/quit") {
			leave();
		} else if (value === "/cells") {
			showCells = !showCells;
			note(`cells ${showCells ? "shown" : "hidden"}`);
		} else if (value === "/view") {
			add(new Block(backend.view().split("\n").map(dim)));
		} else if (value === "/usage") {
			add(new Block([...backend.usageLines(), backend.meter.summary()]));
		} else if (value === "/verbose") {
			verbose = !verbose;
			note(`verbose ${verbose ? "on" : "off"}`);
		} else if (busy) {
			note("(busy: a turn is already running)");
		} else if (capped) {
			note("(capped: no further model calls)");
		} else {
			add(new Text(styleText(`you> ${value}`, { bold: true }, getTerminalColorMode()), 0, 0));
			await turn(value);
		}
	};

	const leave = (): void => {
		if (leaving) return;
		leaving = true;

		if (refreshTimer !== undefined) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}

		tui.stop();

		const done = (): void => {
			console.log(backend.meter.summary());
			finish();
		};

		void backend.close().then(done, (error: Error) => {
			console.error(`forge: close failed: ${error.message}`);
			done();
		});
	};

	editor.onSubmit = (text) => {
		void submit(text);
	};

	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			leave();

			return { consume: true };
		}

		return undefined;
	});

	const side: StackEntry = { component: panel, basis: PANEL_WIDTH, grow: 0, shrink: 0, visible: (viewport) => showCells && viewport.width >= PANEL_MIN_COLUMNS };
	const footerRow = footer;
	const root: StackChild[] = [{ component: new HStack([{ component: transcriptView, basis: 0, grow: 1, minSize: 1 }, side]), basis: "auto", grow: 1, shrink: 1, minSize: 1 }, { component: new VStack([editor, footerRow]), basis: "auto", grow: 0, shrink: 0, minSize: 1 }];

	tui.setLayoutRoot(new VStack(root));
	tui.setFocus(editor);
	syncFooter();
	tui.start();
	void refreshPanel().catch((error: Error) => {
		note(`panel: ${error.message}`);
	});
	await exited;
}
