// One command to start the forge: `./forge [flags]` (or `npm start`). It resolves the turn and summary models from the
// flags/environment via src/model-config.ts, runs the scripted offline demo when no model is configured (or --demo is
// given), and otherwise opens the forge and hands it to the chat UI. On a terminal the full-screen TUI owns the screen
// and repeats the model/data/cap facts in its footer; --plain forces the line-based loop, which is also the only option
// when stdin or stdout is not a TTY (piped input), and it keeps the status line printed before the first prompt.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runChat } from "./chat-loop.ts";
import { type Limits, openLive } from "./live.ts";
import { chooseModels, configuredModels, describeModel, type Env } from "./model-config.ts";
import { backendOf, runTui } from "./tui.ts";

/**
 * An interactive session's cap: wider than the library default (60 calls, $0.25), which a scripted run fits in but a chat
 * outgrows in a few turns. Calls grow much faster than dollars (each message and tool result is compacted, about two
 * cheap calls each; one hard turn took over 100), so the call cap only catches runaway loops and the dollar cap is
 * the real stop.
 */
const CHAT_LIMITS: Limits = { maxCalls: 1000, maxCostUsd: 1 };

const HELP = `usage: ./forge [flags]

  --model provider/modelId   turn model (default: auto-pick the first provider with a credential)
  --summary-model provider/modelId
                             compaction model (default: the turn model)
  --base-url URL             one OpenAI-compatible local server (Ollama, llama.cpp, vLLM, LM Studio);
                             then --model is <modelId> or local/<modelId>
  --data DIR                 session directory (default: $FORGE_HOME or ~/.forge/default)
  --fresh                    delete the session directory before opening it
  --max-calls N              stop after N model calls (default ${CHAT_LIMITS.maxCalls})
  --max-cost USD             stop after this many dollars (default ${CHAT_LIMITS.maxCostUsd})
  --list-models              list providers with a configured credential and their chat models
  --demo                     run the scripted offline demo instead of chatting
  --plain                    line-based chat instead of the full-screen TUI (automatic without a TTY)
  --help                     this text

Environment: FORGE_MODEL, FORGE_SUMMARY_MODEL, FORGE_BASE_URL, FORGE_HOME, FORGE_API_KEY (local endpoints), and each
provider's standard key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...).`;

/** A numeric flag, rejecting anything that is not a non-negative number. */
function numberFlag(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;

	const value = Number(raw);

	if (!Number.isFinite(value) || value < 0) throw new Error(`expected a non-negative number, got "${raw}"`);

	return value;
}

/** Run src/demo.ts in a child process, then say how to chat for real. Returns the demo's exit status. */
function runDemo(): number {
	const demo = join(import.meta.dirname, "demo.ts");

	console.log(`running the scripted offline demo (${demo}); its model is the faux provider and no key is used\n`);
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", demo], { stdio: "inherit" });
	console.log("\nto chat for real: set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, XAI_API_KEY, or pass --base-url for a local OpenAI-compatible server, then run ./forge");

	return result.status ?? 1;
}

async function main(argv: readonly string[], env: Env): Promise<number> {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			model: { type: "string" },
			"summary-model": { type: "string" },
			"base-url": { type: "string" },
			data: { type: "string" },
			fresh: { type: "boolean" },
			"max-calls": { type: "string" },
			"max-cost": { type: "string" },
			"list-models": { type: "boolean" },
			demo: { type: "boolean" },
			plain: { type: "boolean" },
			help: { type: "boolean" },
		},
		strict: true,
		allowPositionals: false,
	});

	if (values.help) {
		console.log(HELP);

		return 0;
	}

	if (values["list-models"]) {
		const lines = await configuredModels(env);

		console.log(lines.length === 0 ? "no provider credential configured" : lines.join("\n"));

		return 0;
	}

	if (values.demo) return runDemo();

	const choice = await chooseModels({ env, argv });

	if (choice.kind === "error") {
		console.error(choice.message);

		return 1;
	}

	if (choice.kind === "demo") {
		console.error(`no model configured: ${choice.why}`);

		return runDemo();
	}

	const dataDir = values.data ?? env.FORGE_HOME ?? join(homedir(), ".forge", "default");

	if (values.fresh) {
		if (dataDir === "/" || dataDir === homedir()) {
			console.error(`refusing to delete ${dataDir}`);

			return 1;
		}

		console.log(`fresh: deleting ${dataDir}`);
		rmSync(dataDir, { recursive: true, force: true });
	}

	const limits = { maxCalls: numberFlag(values["max-calls"], CHAT_LIMITS.maxCalls), maxCostUsd: numberFlag(values["max-cost"], CHAT_LIMITS.maxCostUsd) };
	const live = await openLive(dataDir, { limits, turn: choice.turn, summary: choice.summary });
	const model = describeModel(choice.turn);

	if (values.plain || !process.stdin.isTTY || !process.stdout.isTTY) {
		console.log(`turn ${model} | summary ${describeModel(choice.summary)} | data ${dataDir} | cap ${limits.maxCalls} calls or $${limits.maxCostUsd.toFixed(2)}`);
		await runChat(live);
	} else {
		await runTui(backendOf(live), { model, dataDir });
	}

	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
	console.error(error instanceof Error ? error.message : "forge: bad arguments");
	process.exitCode = 1;
}
