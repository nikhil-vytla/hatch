/**
 * ChatBackend port. Two implementations:
 *  - OpenAICompatBackend: any server speaking POST /v1/chat/completions (stream)
 *  - OpenCodeBackend: OpenCode CLI free models (no API key), transcript-in-prompt
 * The workspace probes which one is configured and reports it on /api/health,
 * mirroring hermes-workspace's portable vs enhanced capability model.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  readonly role: ChatRole;
  readonly content: string;
};

export interface ChatBackend {
  readonly mode: "openai-compat" | "opencode-cli";
  readonly model: string;
  stream(messages: readonly ChatMessage[]): AsyncGenerator<string>;
}

export function resolveBackend(env: NodeJS.ProcessEnv = process.env): ChatBackend {
  const base = env.OPENAI_BASE_URL;
  if (base) {
    return new OpenAICompatBackend({
      baseUrl: base,
      model: env.WORKSPACE_MODEL ?? "gpt-4o-mini",
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
    });
  }
  return new OpenCodeBackend({
    model: env.WORKSPACE_MODEL ?? "opencode/big-pickle",
  });
}

export class OpenAICompatBackend implements ChatBackend {
  readonly mode = "openai-compat" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(opts: { baseUrl: string; model: string; apiKey?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  async *stream(messages: readonly ChatMessage[]): AsyncGenerator<string> {
    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
    });
    if (!r.ok || !r.body) {
      throw new Error(`backend ${r.status}: ${await r.text()}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.replace(/^data: ?/, "").trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* keep-alives */
        }
      }
    }
  }
}

function opencodeBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "node_modules/.bin/opencode"),
    path.resolve(here, "../node_modules/.bin/opencode"),
    path.resolve(here, "../../node_modules/.bin/opencode"),
  ];
  return candidates[0]!;
}

function renderTranscript(messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`(system) ${m.content}`);
    else if (m.role === "user") parts.push(`User: ${m.content}`);
    else parts.push(`Assistant: ${m.content}`);
  }
  parts.push(
    "Reply as the assistant with the next message only. Plain text, no role prefix.",
  );
  return parts.join("\n\n");
}

export class OpenCodeBackend implements ChatBackend {
  readonly mode = "opencode-cli" as const;
  readonly model: string;

  constructor(opts: { model: string }) {
    this.model = opts.model;
  }

  async *stream(messages: readonly ChatMessage[]): AsyncGenerator<string> {
    const child = spawn(
      opencodeBin(),
      ["run", "--model", this.model, renderTranscript(messages)],
      {
        cwd: "/tmp",
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    timer.unref?.();
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      yield line + "\n";
    }
    const code: number = await new Promise((resolve) =>
      child.on("close", (c) => resolve(c ?? 1)),
    );
    clearTimeout(timer);
    if (code !== 0) {
      throw new Error(`opencode exited ${code}: ${err.slice(0, 400)}`);
    }
  }
}
