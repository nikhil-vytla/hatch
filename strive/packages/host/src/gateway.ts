// The model as the agent loop sees it: reached only through the session's
// gateway, with a placeholder key. Shared by the coding agent and the learner.
import { type AssistantMessage, createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AgentConfig } from "@strive/protocol";

export function model(config: AgentConfig): Model<any> {
  return {
    id: config.model,
    name: config.model,
    api: config.provider === "anthropic" ? "anthropic-messages" : "openai-completions",
    provider: "strive",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    // strive prices calls in the gateway; the agent loop doesn't.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxOutput,
  };
}

export function createStriveModels(m: Model<any>) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "strive",
      name: "strive gateway",
      // The gateway replaces this with the real key, which only the daemon holds.
      auth: { apiKey: { name: "strive", resolve: async () => ({ auth: { apiKey: "strive-gateway" } }) } },
      models: [m],
      api: { "anthropic-messages": anthropicMessagesApi(), "openai-completions": openAICompletionsApi() },
    }),
  );

  return models;
}

export const textOf = (m: AssistantMessage) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
