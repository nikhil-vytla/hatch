// DeepSeek as the model in the chat loop, through its OpenAI-style chat completions API (plain fetch, no SDK).
// The loop keeps its transcript in the Messages API block format; this adapter translates it on every call:
//   tool_use blocks   <-> assistant.tool_calls (arguments as a JSON string)
//   tool_result blocks -> one role:"tool" message each
//
//   DEEPSEEK_API_KEY=... MODEL=deepseek node --experimental-strip-types --no-warnings src/chat.ts
// Without DEEPSEEK_API_KEY the request goes out with no authorization header, for a proxy that injects the key.
import type { Block, Message, Model, ToolDef } from "./chat.ts";

const URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/chat/completions";
const MODEL_ID = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OpenAIMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

export class DeepSeekModel implements Model {
	private readonly key: string | undefined;
	private constructor(key: string | undefined) {
		this.key = key;
	}

	static async create(): Promise<DeepSeekModel> {
		return new DeepSeekModel(process.env.DEEPSEEK_API_KEY || undefined);
	}

	async next(system: string, messages: Message[], tools: ToolDef[]): Promise<{ content: Block[]; stop: string }> {
		const response = await fetch(URL, {
			method: "POST",
			headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
			body: JSON.stringify({
				model: MODEL_ID,
				max_tokens: 8000,
				messages: [{ role: "system", content: system }, ...toOpenAI(messages)],
				tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
			}),
			signal: AbortSignal.timeout(300_000),
		});
		if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const body = (await response.json()) as { choices: { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }[] };
		const { message, finish_reason } = body.choices[0];
		const content: Block[] = [];
		if (message.content) content.push({ type: "text", text: message.content });
		if (finish_reason === "length") return { content: [...content, { type: "text", text: "(response hit max_tokens)" }], stop: "end_turn" };
		for (const call of message.tool_calls ?? []) {
			let input: Record<string, unknown>;
			try {
				input = JSON.parse(call.function.arguments || "{}");
			} catch {
				input = { invalid_arguments: call.function.arguments }; // the tool handler reports the error back
			}
			content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
		}
		return { content, stop: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
	}
}

function toOpenAI(messages: Message[]): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];
	for (const m of messages) {
		if (typeof m.content === "string") {
			out.push({ role: m.role, content: m.content } as OpenAIMessage);
			continue;
		}
		if (m.role === "user") {
			for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: String(b.content) });
			continue;
		}
		const text = m.content.filter((b) => b.type === "text").map((b) => String((b as { text: string }).text)).join("\n");
		const calls = m.content
			.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
			.map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }));
		out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
	}
	return out;
}
