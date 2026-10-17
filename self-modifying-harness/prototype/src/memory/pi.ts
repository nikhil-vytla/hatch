// Why: the pi strategy hands the past to pi-durable's own compaction. Its automatic trigger compares the context with the
// model's context window, so a first version lowered the window to the budget; that also squeezed the room for the
// answer and cut a tool call off mid-turn. Now the window stays real, automatic compaction stays off, and the forge
// asks for a compaction itself between turns (`Live.ask`), when the context passes the byte budget. pi-durable keeps
// `keepRecentTokens` verbatim and summarizes the rest.
import type { Message } from "@earendil-works/pi-ai";
import { type CompactionPolicy, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { isRecord, parseJson } from "../optchat.ts";
import { jsonBytes, renderMessages, type MemoryStrategy } from "./strategy.ts";

/** Room pi-durable keeps for the answer (unused while automatic compaction is off, but part of the policy). */
export const PI_RESERVE_TOKENS = 4_096;

/** The recent context a compaction keeps verbatim: half of the budget, at 4 bytes per token. */
export function piKeepRecentTokens(budgetBytes: number): number {
	return Math.floor((budgetBytes / 4) * 0.5);
}

/** Automatic compaction off; the forge triggers it between turns. `keepRecentTokens` still shapes every compaction. */
export function piCompaction(budgetBytes: number): CompactionPolicy {
	return { enabled: false, reserveTokens: PI_RESERVE_TOKENS, keepRecentTokens: piKeepRecentTokens(budgetBytes), backgroundTokens: 0 };
}

/** Whether the next turn should start with a compaction: the model context is over the byte budget. */
export function piShouldCompact(messages: readonly Message[], budgetBytes: number): boolean {
	return jsonBytes(messages) > budgetBytes;
}

/**
 * pi-durable 1.0.3's compaction re-announces tools in its summary head, and in a live run it dropped `"type": "object"`
 * from an agent-written tool's parameter schema (keeping `properties` and `required`), which DeepSeek rejects. A schema
 * with `properties` and no `type` can only mean an object, so put it back. Reported here as a pi-durable bug to raise.
 */
export function repairToolSchemas(message: Message): Message {
	if (message.role !== "system" || message.toolsAdded === undefined) return message;

	const toolsAdded = message.toolsAdded.map((tool) => {
		const parameters = parseJson(JSON.stringify(tool.parameters));

		if (!isRecord(parameters) || parameters.type !== undefined || parameters.properties === undefined) return tool;

		return { ...tool, parameters: { ...tool.parameters, type: "object" } };
	});

	return { ...message, toolsAdded };
}

/** Keep the system prompt first while leaving pi-durable's own transcript intact. */
export function systemFirst(messages: readonly Message[]): Message[] {
	let first = -1;

	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "system") {
			first = i;
			break;
		}
	}

	if (first <= 0) return [...messages];

	const out = [messages[first]];

	for (let i = 0; i < messages.length; i++) {
		if (i !== first) out.push(messages[i]);
	}

	return out;
}

export function piStrategy(): MemoryStrategy {
	let length = 0;
	let shown = "";

	return {
		name: "pi",
		extensions: () => [
			defineExtension({
				name: "memory-pi",
				hooks: [
					hook(GenerationTask, {
						beforeRequest: (request) => {
							const messages = systemFirst(request.messages).map(repairToolSchemas);
							length = messages.length;
							shown = renderMessages(messages);

							return { messages };
						},
					}),
				],
			}),
		],
		recall: undefined,
		view: () => shown,
		idle: () => Promise.resolve(),
		get length(): number {
			return length;
		},
		close: () => Promise.resolve(),
	};
}
