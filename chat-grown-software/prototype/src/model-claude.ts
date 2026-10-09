// Claude as the model in the chat loop: one Messages API call per assistant turn. The loop in chat.ts owns the tool
// calls (each one goes through the kernel, and `develop` stops to ask the user), so this is the manual-loop shape:
// append the response content unchanged, return all tool results of a turn in one user message.
//
// Needs `npm install` and a credential (ANTHROPIC_API_KEY, or an `ant auth login` profile). Nothing else in the
// prototype imports the SDK.
import Anthropic from "@anthropic-ai/sdk";
import type { Block, Message, Model, ToolDef } from "./chat.ts";

const MODEL_ID = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

export class ClaudeModel implements Model {
	private readonly client: Anthropic;
	private constructor(client: Anthropic) {
		this.client = client;
	}

	static async create(): Promise<ClaudeModel> {
		return new ClaudeModel(new Anthropic());
	}

	async next(system: string, messages: Message[], tools: ToolDef[]): Promise<{ content: Block[]; stop: string }> {
		const response = await this.client.beta.messages.create({
			model: MODEL_ID,
			max_tokens: 16000,
			// Writing code that must pass a user-owned contract: worth more than the default effort.
			output_config: { effort: "high" },
			// If a safety classifier declines, the server retries on a fallback model instead of ending the turn.
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			// The system prompt and tool list never change during a chat, so the prefix stays cacheable.
			system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
			tools: tools as Anthropic.Beta.BetaTool[],
			messages: messages as Anthropic.Beta.BetaMessageParam[],
		});
		if (response.stop_reason === "refusal") {
			return { content: [{ type: "text", text: `(the model declined: ${response.stop_details?.category ?? "no category"})` }], stop: "end_turn" };
		}
		if (response.stop_reason === "max_tokens") {
			// A tool call cut off mid-input must not run: hand back to the user instead.
			const content = (response.content as Block[]).filter((b) => b.type !== "tool_use");
			return { content: [...content, { type: "text", text: "(response hit max_tokens)" }], stop: "end_turn" };
		}
		return { content: response.content as Block[], stop: response.stop_reason ?? "end_turn" };
	}
}
