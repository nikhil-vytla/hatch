// A scripted Anthropic Messages API for tests: the network boundary where a
// stand-in is the point. Each request takes the next scripted reply (or the
// reply a function picks for it) and is recorded, so tests can check exactly
// what the model was sent.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ScriptedReply = {
  text?: string;
  toolCalls?: { id: string; name: string; input: { [key: string]: Json } }[];
  /** Wait this long before answering (to test interrupts). */
  delayMs?: number;
  /** Answer with this HTTP status and error message instead. */
  status?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
};

/** What a scripted function sees of a request: the parts tests branch on. */
export type ModelRequest = {
  system?: Json;
  messages: { role: string; content: Json }[];
  tool_choice?: { type: string; name?: string };
};

const sse = (event: string, data: Json) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class FakeAnthropic {
  readonly requests: any[] = [];
  private server?: ReturnType<typeof Bun.serve>;

  /** A list is answered in order; a function answers each request by what it holds. */
  constructor(private readonly script: ScriptedReply[] | ((request: ModelRequest) => ScriptedReply)) {}

  get url(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  start(): this {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body: any = await req.json();
        this.requests.push(body);

        const reply = Array.isArray(this.script)
          ? (this.script.shift() ?? { text: "(the script has no more replies)" })
          : this.script(body);

        if (reply.delayMs) await Bun.sleep(reply.delayMs);

        if (reply.status) {
          return Response.json(
            { type: "error", error: { type: "api_error", message: reply.error ?? "failed" } },
            { status: reply.status },
          );
        }

        const usage = { input_tokens: reply.inputTokens ?? 10, output_tokens: reply.outputTokens ?? 5 };
        const stop = reply.toolCalls?.length ? "tool_use" : "end_turn";

        if (!body.stream) {
          const content = [
            ...(reply.text ? [{ type: "text", text: reply.text }] : []),
            ...(reply.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
          ];

          return Response.json({
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: body.model,
            content,
            stop_reason: stop,
            usage,
          });
        }

        let out = sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
          },
        });

        let index = 0;

        if (reply.text) {
          out += sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });

          for (const piece of reply.text.match(/.{1,8}/gs) ?? []) {
            out += sse("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: piece },
            });
          }

          out += sse("content_block_stop", { type: "content_block_stop", index });
          index++;
        }

        for (const c of reply.toolCalls ?? []) {
          out += sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: c.id, name: c.name, input: {} },
          });
          out += sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) },
          });
          out += sse("content_block_stop", { type: "content_block_stop", index });
          index++;
        }

        out += sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stop },
          usage: { output_tokens: usage.output_tokens },
        });
        out += sse("message_stop", { type: "message_stop" });

        return new Response(out, { headers: { "content-type": "text/event-stream" } });
      },
    });

    return this;
  }

  stop() {
    this.server?.stop(true);
  }
}
