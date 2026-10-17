// Why: optchat is the default strategy, so it wraps the existing Memory and memory extension unchanged; a budget, when
// given, only moves the view's merge marks to half and all of it.
import { join } from "node:path";
import type { Summarizer } from "../compaction.ts";
import { loadMirror, memoryExtension, type MirrorState } from "../memory-extension.ts";
import { Memory, type MemoryOptions } from "../optchat.ts";
import type { MemoryStrategy } from "./strategy.ts";

export type Optchat = { strategy: MemoryStrategy; memory: Memory; state: MirrorState };

/** Build OptChat with today's defaults unless a budget moves the view's low and high marks. */
export function optchatStrategy(dataDir: string, budgetBytes: number | undefined, summarizer: Summarizer): Optchat {
	const options: MemoryOptions = { summarizer };

	if (budgetBytes !== undefined) {
		options.low = Math.floor(budgetBytes / 2);
		options.high = budgetBytes;
	}

	const memory = new Memory(join(dataDir, "chat"), options);
	const state = loadMirror(memory);

	const strategy: MemoryStrategy = {
		name: "optchat",
		extensions: () => [memoryExtension(memory, state)],
		recall: memory,
		view: () => memory.render(),
		idle: () => memory.idle(),
		get length(): number {
			return memory.length;
		},
		close: () => Promise.resolve(),
	};

	return { strategy, memory, state };
}
