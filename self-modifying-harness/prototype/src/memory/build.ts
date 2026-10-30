// Why: one place turns a `--memory` spec into a built strategy and the pieces openLive needs (the run-start index for
// the kernel and the resolved budget for the status line and usage JSON).
import { join } from "node:path";
import type { Summarizer } from "../compaction.ts";
import { optchatStrategy, type Optchat } from "./optchat.ts";
import { piStrategy } from "./pi.ts";
import { rollingStrategy, type RollSummarizer } from "./rolling.ts";
import { type MemorySpec, type MemoryStrategy, resolveMemory, type ResolvedMemory } from "./strategy.ts";
import { windowStrategy } from "./window.ts";

export type MemoryDeps = {
	dataDir: string;
	summarizer: Summarizer;
	rollingSummarizer: RollSummarizer;
};

export type BuiltMemory = {
	strategy: MemoryStrategy;
	resolved: ResolvedMemory;
	recall: Optchat | undefined;
	currentRequest: () => number | undefined;
};

export function buildMemoryStrategy(spec: MemorySpec | undefined, deps: MemoryDeps): BuiltMemory {
	const resolved = resolveMemory(spec);
	const strategy = spec?.strategy ?? resolved.strategy;

	if (strategy === "window") return { strategy: windowStrategy(resolved.budgetBytes), resolved, recall: undefined, currentRequest: () => undefined };

	if (strategy === "pi") return { strategy: piStrategy(), resolved, recall: undefined, currentRequest: () => undefined };

	if (strategy === "rolling") {
		const rolling = rollingStrategy({
			dir: join(deps.dataDir, "memory"),
			budgetBytes: resolved.budgetBytes,
			triggerRatio: resolved.rolling.triggerRatio,
			retainRatio: resolved.rolling.retainRatio,
			summarize: deps.rollingSummarizer,
		});

		return { strategy: rolling, resolved, recall: undefined, currentRequest: () => undefined };
	}

	const recall = optchatStrategy(deps.dataDir, spec?.budgetBytes, deps.summarizer);

	return { strategy: recall.strategy, resolved, recall, currentRequest: () => recall.state.runStartLog };
}
