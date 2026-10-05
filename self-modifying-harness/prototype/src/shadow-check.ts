// If the gate did not refuse kernel names, which `cell_list` would the model get? pi-durable resolves same-name tools
// in extension order (a later one wins), and reinstalling an extension keeps its position.
//   node --experimental-strip-types --no-warnings src/shadow-check.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const tool = (by: string) => defineTool({ name: "cell_list", description: by, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: by }] }) });
const kernel = defineExtension({ name: "kernel", tools: [tool("kernel")] });
const cells = (v: string) => defineExtension({ name: "cells", tools: [tool(`agent-written ${v}`)] });

for (const order of [["cells", "kernel"], ["kernel", "cells"]]) {
	const registry = createRegistry();
	for (const name of order) registry.install(name === "kernel" ? kernel : cells("v1"));
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const winner = async () => (await root.agent(context)).tools.find((t) => t.name === "cell_list")?.description;
	const first = await winner();
	registry.install(cells("v2")); // a hot reload of the agent's tools
	console.log(`install order ${order.join(" -> ")}: cell_list is "${first}"; after reloading cells: "${await winner()}"`);
	await harness.close(context);
}
