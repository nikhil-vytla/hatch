// Why: `--memory` and its tuning flags are read by both `./forge` and `live-run.ts`, so the parsing and the validation
// live here once and resolve to the same defaults the strategies use.
import { flagValue } from "../model-config.ts";
import { type MemorySpec, type MemoryStrategyName } from "./strategy.ts";

export const MEMORY_STRATEGIES: readonly MemoryStrategyName[] = ["optchat", "rolling", "window", "pi"];

export function isStrategyName(value: string): value is MemoryStrategyName {
	return MEMORY_STRATEGIES.some((name) => name === value);
}

function ratioFlag(raw: string | undefined, name: string, fallback: number): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);

	if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be 0 < R <= 1, got "${raw}"`);

	return value;
}

/** The memory flags in `argv`; an absent `--memory` is OptChat's default and an absent budget its own defaults. */
export function memoryFlags(argv: readonly string[]): MemorySpec {
	const raw = flagValue(argv, "--memory") ?? "optchat";

	if (!isStrategyName(raw)) throw new Error(`--memory must be one of ${MEMORY_STRATEGIES.join(", ")}, got "${raw}"`);

	const spec: MemorySpec = { strategy: raw };
	const budgetRaw = flagValue(argv, "--memory-budget");

	if (budgetRaw !== undefined) {
		const kb = Number(budgetRaw);

		if (!Number.isInteger(kb) || kb < 0) throw new Error(`--memory-budget must be a whole number of KB, got "${budgetRaw}"`);

		spec.budgetBytes = kb * 1000;
	}

	const trigger = flagValue(argv, "--rolling-trigger");
	const retain = flagValue(argv, "--rolling-retain");

	if (trigger !== undefined || retain !== undefined) spec.rolling = { triggerRatio: ratioFlag(trigger, "--rolling-trigger", 0.8), retainRatio: ratioFlag(retain, "--rolling-retain", 0.5) };

	return spec;
}
