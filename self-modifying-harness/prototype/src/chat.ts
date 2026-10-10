// An interactive chat with the forge: a thin entry that picks the models exactly like `./forge` does (src/model-config.ts)
// and then hands the open forge to the shared loop in src/chat-loop.ts. One directory is one chat: running it again over
// the same directory resumes the same session, reinstalls the agent-written tools from the catalog and keeps the memory.
//
//   node --experimental-strip-types --no-warnings src/chat.ts [--model provider/modelId] [--data DIR]      (`npm run chat`)
//
// Flags and environment: --model/--summary-model/--base-url, FORGE_MODEL/FORGE_SUMMARY_MODEL/FORGE_BASE_URL, and each
// provider's standard API-key variable. With no credential at all, run the offline demo with `./forge --demo`.
import { join } from "node:path";
import { runChat } from "./chat-loop.ts";
import { openLive } from "./live.ts";
import { chooseModels, describeModel, flagValue } from "./model-config.ts";

const argv = process.argv.slice(2);

const choice = await chooseModels({ env: process.env, argv });

if (choice.kind === "error") {
	console.error(choice.message);
	process.exit(1);
}

if (choice.kind === "demo") {
	console.error(`no model configured (${choice.why}); run ./forge --demo for the scripted demo`);
	process.exit(1);
}

const dataDir = flagValue(argv, "--data") ?? join(import.meta.dirname, "..", "data", "live");

const live = await openLive(dataDir, { turn: choice.turn, summary: choice.summary });

console.log(`turn ${describeModel(choice.turn)} | summary ${describeModel(choice.summary)} | data ${dataDir} | cap ${live.meter.limits.maxCalls} calls or $${live.meter.limits.maxCostUsd.toFixed(2)}`);

await runChat(live);
