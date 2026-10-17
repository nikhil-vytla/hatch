// Why: the window strategy is the cheapest baseline — no model calls, no summaries. It keeps the newest whole earlier
// runs that fit the budget and names the messages it dropped, so a comparison shows what a summary is worth.
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { assemble, jsonBytes, type MemoryStrategy, renderMessages, runStarts, splitTranscript, userMessage } from "./strategy.ts";

export type WindowPlan = { request: Message[]; memory: Message[] };

/** Keep the newest whole earlier runs that fit, note how many messages went, and assemble the request. */
export function windowPlan(messages: readonly Message[], budgetBytes: number): WindowPlan {
	const split = splitTranscript(messages);
	const starts = runStarts(split.earlier);
	let keptFrom = split.earlier.length;
	let used = 0;

	for (let k = starts.length - 1; k >= 0; k--) {
		const from = starts[k];
		const to = k + 1 < starts.length ? starts[k + 1] : split.earlier.length;
		const size = jsonBytes(split.earlier.slice(from, to));

		if (used + size > budgetBytes) break;
		used += size;
		keptFrom = from;
	}

	const memory: Message[] = [];

	if (keptFrom > 0) memory.push(userMessage(`[earlier conversation dropped: ${keptFrom} messages]`));

	memory.push(...split.earlier.slice(keptFrom));

	return { request: assemble(split.head, memory, split.delta, split.run), memory };
}

export function windowRequest(messages: readonly Message[], budgetBytes: number): Message[] {
	return windowPlan(messages, budgetBytes).request;
}

export function windowStrategy(budgetBytes: number): MemoryStrategy {
	let length = 0;
	let memory: Message[] = [];

	return {
		name: "window",
		extensions: () => [
			defineExtension({
				name: "memory-window",
				hooks: [
					hook(GenerationTask, {
						beforeRequest: (request) => {
							const plan = windowPlan(request.messages, budgetBytes);
							length = plan.request.length;
							memory = plan.memory;

							return { messages: plan.request };
						},
					}),
				],
			}),
		],
		recall: undefined,
		view: () => (memory.length === 0 ? "(no earlier messages kept)" : renderMessages(memory)),
		idle: () => Promise.resolve(),
		get length(): number {
			return length;
		},
		close: () => Promise.resolve(),
	};
}
