// Why: the forge's memory is OptChat today. This interface lets window, rolling and pi-durable's own compaction stand
// in on the same session behind one shape, so a flag can pick the strategy and the same budget measures all of them.
// Every strategy sees the pi-durable transcript through `beforeRequest` and must keep the current run verbatim and the
// system prompt first, so that split lives here once.
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { bytes } from "../compaction.ts";
import { foldSystem } from "../memory-extension.ts";
import type { Memory } from "../optchat.ts";

export type MemoryStrategyName = "optchat" | "rolling" | "window" | "pi";

export type MemoryStrategy = {
	readonly name: MemoryStrategyName;
	extensions(): Extension[];
	readonly recall: Memory | undefined;
	view(): string;
	idle(): Promise<void>;
	readonly length: number;
	close(): Promise<void>;
};

/** OptChat's current defaults: a view that merges from 128 KB down to 64 KB. */
export const OPTCHAT_BUDGET = 128_000;

/** Every other strategy gets a 64 KB budget by default. */
export const DEFAULT_BUDGET = 64_000;

export type RollingRatios = { triggerRatio: number; retainRatio: number };

export type MemorySpec = {
	strategy: MemoryStrategyName;
	budgetBytes?: number;
	rolling?: Partial<RollingRatios>;
};

export type ResolvedMemory = {
	strategy: MemoryStrategyName;
	budgetBytes: number;
	rolling: RollingRatios;
};

/** Fill the strategy's defaults: optchat keeps its own budgets, the others 64 KB. */
export function resolveMemory(spec?: MemorySpec): ResolvedMemory {
	const strategy = spec?.strategy ?? "optchat";

	return {
		strategy,
		budgetBytes: spec?.budgetBytes ?? (strategy === "optchat" ? OPTCHAT_BUDGET : DEFAULT_BUDGET),
		rolling: { triggerRatio: spec?.rolling?.triggerRatio ?? 0.8, retainRatio: spec?.rolling?.retainRatio ?? 0.5 },
	};
}

export function memoryLabel(memory: ResolvedMemory): string {
	return `${memory.strategy} ${Math.round(memory.budgetBytes / 1000)}KB`;
}

export const isSystem = (message: Message): message is SystemMessage => message.role === "system";

export function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** JSON bytes, how a run's size is measured for a budget. */
export const jsonBytes = (messages: readonly Message[]): number => bytes(JSON.stringify(messages));

export type Split = {
	head: SystemMessage | undefined;
	headIndex: number;
	runStart: number;
	delta: SystemMessage | undefined;
	earlier: Message[];
	earlierRaw: number[];
	run: Message[];
};

/** The first system message is the prompt; the last user message starts the current run. */
export function splitTranscript(messages: readonly Message[]): Split {
	let headIndex = -1;
	let runStart = messages.length;

	for (let i = 0; i < messages.length; i++) {
		if (headIndex < 0 && isSystem(messages[i])) headIndex = i;

		if (messages[i].role === "user") runStart = i;
	}

	const head = headIndex < 0 ? undefined : systemAt(messages[headIndex]);
	const earlier: Message[] = [];
	const earlierRaw: number[] = [];
	const systems: SystemMessage[] = [];

	for (let i = 0; i < runStart; i++) {
		if (i === headIndex) continue;
		const message = messages[i];

		if (isSystem(message)) {
			systems.push(message);
		} else {
			earlier.push(message);
			earlierRaw.push(i);
		}
	}

	const run: Message[] = [];

	for (let i = runStart; i < messages.length; i++) {
		if (i === headIndex) continue;
		run.push(messages[i]);
	}

	return { head, headIndex, runStart, delta: foldSystem(systems), earlier, earlierRaw, run };
}

/** The split narrows the system by index; this keeps the type without an assertion. */
function systemAt(message: Message): SystemMessage | undefined {
	return isSystem(message) ? message : undefined;
}

/** How many `earlier` entries lie before raw message `raw`. */
export function earlierFrom(split: Split, raw: number): number {
	let k = 0;

	while (k < split.earlierRaw.length && split.earlierRaw[k] < raw) k++;

	return k;
}

/** The raw start of each run in a run list: a run begins at a user message. */
export function runStarts(messages: readonly Message[]): number[] {
	const out: number[] = [];

	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") out.push(i);
	}

	return out;
}

/** System prompt first, then the memory section, the folded later system messages, then the current run verbatim. */
export function assemble(head: SystemMessage | undefined, memory: readonly Message[], delta: SystemMessage | undefined, run: readonly Message[]): Message[] {
	const out: Message[] = [];

	if (head !== undefined) out.push(head);

	out.push(...memory);

	if (delta !== undefined) out.push(delta);

	out.push(...run);

	return out;
}

/** Raw transcript messages in `[from, to)`, minus the first system prompt, for a summarizer's input. */
export function rawRange(messages: readonly Message[], from: number, to: number, headIndex: number): Message[] {
	const out: Message[] = [];

	for (let i = from; i < to; i++) {
		if (i !== headIndex) out.push(messages[i]);
	}

	return out;
}

/** A text part, or the joined text of a part list. */
export function contentText(content: string | { type: string; text?: string }[]): string {
	if (Array.isArray(content)) return content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join(" ");

	return content;
}

/** One line per message: what a non-OptChat strategy is showing the model of the past, for `/view`. */
export function renderMessages(messages: readonly Message[]): string {
	const lines: string[] = [];

	for (const message of messages) {
		if (message.role === "assistant") {
			const parts = message.content.flatMap((part) => (part.type === "text" ? [part.text] : part.type === "toolCall" ? [`${part.name} ${JSON.stringify(part.arguments)}`] : []));

			if (parts.length > 0) lines.push(`assistant: ${parts.join(" ")}`);
		} else if (message.role === "toolResult") {
			lines.push(`toolResult ${message.toolName}: ${contentText(message.content)}`);
		} else if (message.role === "system") {
			const text = contentText(message.content);

			if (text !== "") lines.push(`system: ${text}`);
		} else {
			lines.push(`user: ${contentText(message.content)}`);
		}
	}

	return lines.join("\n");
}
