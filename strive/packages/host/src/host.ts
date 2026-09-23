// The agent host: runs one session's agent loop as a client of the daemon.
// Models are reached only through the daemon's gateway, and every tool is
// an effect the daemon performs; the host holds no keys and touches no files.
import { type AssistantMessage, createModels, createProvider, type Model, Type } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent, type AgentTool, estimateContextTokens } from "@earendil-works/pi-agent-core";
import type { AgentConfig, EffectRequest, Entry, StriveClient, TurnEnd } from "@strive/protocol";
import { rebuild, resultText, summaryMessage } from "./transcript";

export function systemPrompt(config: AgentConfig): string {
  const parts = [base(config.cwd)];

  if (config.instructions.length > 0) {
    parts.push(
      "# Project instructions\n\nFollow these; later files are more specific than earlier ones.",
      ...config.instructions.map((f) => `## ${f.path}\n\n${f.text.trim()}`),
    );
  }

  if (config.skills.length > 0) {
    parts.push(
      [
        "# Skills",
        "",
        "When a task matches a skill, read its SKILL.md first and follow it.",
        ...config.skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`),
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}

function base(cwd: string): string {
  return [
    `You are strive, a coding agent working in ${cwd}.`,
    "You act only through tools: read files, write files, edit files (replace text that appears exactly once), and run shell commands.",
    "Commands run in a sandbox: no network, and writes only inside the workspace. Some actions wait for the user's approval; if one is declined, adapt.",
    "Read before you edit. Keep changes small and focused on what was asked. Run the project's tests when they are relevant.",
    "When you are done, reply with a short summary of what you changed and anything left open.",
  ].join("\n");
}

function model(config: AgentConfig): Model<any> {
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

function createStriveModels(m: Model<any>) {
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

const SUMMARIZE = [
  "Summarize this coding session so the work can continue without the full history.",
  "Keep: what the user asked for, decisions made and why, files changed and how, commands run and what they showed, the current state, and anything left open.",
  "Be specific (paths, names, numbers). Write plain prose and short lists; no preamble.",
].join("\n");

/** The conversation as plain text for summarizing: tool output is cut short. */
function transcriptText(messages: any[]): string {
  const cut = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)} [...]` : s);

  return messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user") return `USER: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;

      if (m.role === "toolResult")
        return `TOOL RESULT (${m.toolName}): ${cut(m.content.map((c: any) => c.text ?? "").join(""))}`;

      const parts = m.content.map((c: any) =>
        c.type === "text" ? c.text : c.type === "toolCall" ? `[calls ${c.name} ${JSON.stringify(c.arguments)}]` : "",
      );

      return `ASSISTANT: ${parts.join(" ")}`;
    })
    .join("\n\n");
}

/** A tool whose work the daemon does. Refusals reach the model as errors. */
function tool(
  client: StriveClient,
  sessionId: string,
  name: string,
  description: string,
  parameters: ReturnType<typeof Type.Object>,
  toRequest: (p: any) => EffectRequest,
): AgentTool<any> {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (toolCallId, params) => {
      const request = toRequest(params);
      const r = await client.request("effect/run", { id: sessionId, callId: toolCallId, request });

      const record =
        request.kind === "bash"
          ? { kind: "bash" as const, command: request.command, timeoutMs: 0 }
          : { kind: "read" as const, path: "" };

      const { text, isError } = resultText(record, r.outcome, r.text);

      if (isError) throw new Error(text);

      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

export function tools(client: StriveClient, sessionId: string): AgentTool<any>[] {
  return [
    tool(
      client,
      sessionId,
      "read",
      "Read a text file. Paths are relative to the workspace. Long files come in pages: pass offset (a 1-based line) and limit to read more.",
      Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) }),
      (p) => ({ kind: "read", path: p.path, offset: p.offset, limit: p.limit }),
    ),
    tool(
      client,
      sessionId,
      "write",
      "Create or replace a whole file. Prefer edit for changes to existing files.",
      Type.Object({ path: Type.String(), content: Type.String() }),
      (p) => ({ kind: "write", path: p.path, content: p.content }),
    ),
    tool(
      client,
      sessionId,
      "edit",
      "Replace one exact occurrence of oldText with newText in a file. oldText must appear exactly once; include surrounding lines to make it unique.",
      Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
      (p) => ({ kind: "edit", path: p.path, oldText: p.oldText, newText: p.newText }),
    ),
    tool(
      client,
      sessionId,
      "bash",
      "Run a shell command in the workspace, in a sandbox with no network. Returns combined stdout and stderr.",
      Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer()) }),
      (p) => ({ kind: "bash", command: p.command, timeoutMs: p.timeoutSeconds ? p.timeoutSeconds * 1000 : undefined }),
    ),
  ];
}

const textOf = (m: AssistantMessage) =>
  m.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");

export class Host {
  private agent!: Agent;
  private turn = 0;
  private queued: string[] = [];
  private running = false;
  private timedOut = false;
  private lastSeq = 0;
  private readonly models: ReturnType<typeof createStriveModels>;

  constructor(
    private readonly client: StriveClient,
    private readonly sessionId: string,
    private readonly config: AgentConfig,
  ) {
    this.models = createStriveModels(model(config));
  }

  /** Resumes from the journal and handles prompts as they arrive. */
  async start(entries: Entry[]): Promise<void> {
    const blob = async (digest: string) => (await this.client.request("blob/get", { digest })).text;
    const lastStart = [...entries].reverse().find((e) => e.event.type === "turnStarted");
    const ended = lastStart && entries.some((e) => e.seq > lastStart.seq && e.event.type === "turnEnded");

    if (lastStart?.event.type === "turnStarted") this.turn = lastStart.event.turn;

    if (lastStart && !ended) {
      await this.record({
        type: "turnEnded",
        turn: this.turn,
        reason: { kind: "failed", error: "the agent host stopped during this turn" },
      });
    }

    // Prompts after the last turn began are still waiting: they are sent as
    // the next turn, not replayed as history.
    const since = lastStart?.seq ?? 0;
    const waiting = entries.filter((e) => e.seq > since && e.event.type === "userMessage");
    const history = entries.filter((e) => !waiting.includes(e));
    this.agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(this.config),
        model: model(this.config),
        tools: tools(this.client, this.sessionId),
        messages: await rebuild(history, blob),
      },
      streamFn: this.models.streamSimple.bind(this.models),
      toolExecution: "parallel",
    });
    let lastDelta = 0;
    this.agent.subscribe(async (event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const now = Date.now();

        if (now - lastDelta > 80) {
          lastDelta = now;
          const text = textOf(event.message as AssistantMessage);
          void this.client.request("host/stream", { id: this.sessionId, turn: this.turn, text }).catch(() => {});
        }
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        const m = event.message as AssistantMessage;

        const toolCalls = m.content
          .filter((c) => c.type === "toolCall")
          .map((c) => ({ id: (c as any).id, name: (c as any).name }));

        await this.record({ type: "assistantMessage", turn: this.turn, text: textOf(m), toolCalls, message: m });
      }
    });
    this.lastSeq = entries.at(-1)?.seq ?? 0;
    this.queued = waiting.map((e) => (e.event as { text: string }).text);
    void this.drain();
  }

  onEntry(entry: Entry) {
    if (entry.seq <= this.lastSeq) return;
    this.lastSeq = entry.seq;

    if (entry.event.type === "userMessage") {
      this.queued.push(entry.event.text);
      void this.drain();
    }
  }

  interrupt() {
    this.agent?.abort();
  }

  private async record(event: Parameters<StriveClient["request"]>[1] extends never ? never : any) {
    await this.client.request("host/record", { id: this.sessionId, event });
  }

  /** Runs turns until no prompts are waiting. */
  private async drain() {
    if (this.running || this.queued.length === 0) return;
    this.running = true;

    try {
      while (this.queued.length > 0) {
        const prompts = this.queued.splice(0);
        await this.runTurn(prompts);
      }
    } finally {
      this.running = false;
    }
  }

  /** Summarizes the conversation so far if it has grown past the limit. */
  private async compactIfLarge() {
    const messages = this.agent.state.messages;

    if (
      estimateContextTokens(messages).tokens < this.config.compactAtTokens ||
      messages.every((m) => m.role === "system")
    )
      return;
    const upto = this.lastSeq;

    const reply = await this.models.completeSimple(model(this.config), {
      systemPrompt: SUMMARIZE,
      messages: [{ role: "user", content: transcriptText(messages), timestamp: Date.now() }],
    });

    const summary = textOf(reply as AssistantMessage).trim();

    if (!summary || (reply as AssistantMessage).stopReason === "error") return;
    await this.record({ type: "compacted", uptoSeq: upto, summary });
    const system = messages.filter((m) => m.role === "system").slice(0, 1);
    this.agent.state.messages = [...system, summaryMessage(summary, Date.now())];
  }

  private async runTurn(prompts: string[]) {
    await this.compactIfLarge();
    this.turn += 1;
    this.timedOut = false;
    await this.record({ type: "turnStarted", turn: this.turn });

    const timer = setTimeout(() => {
      this.timedOut = true;
      this.agent.abort();
    }, this.config.turnSeconds * 1000);

    let reason: TurnEnd;

    try {
      await this.agent.prompt(prompts.map((text) => ({ role: "user" as const, content: text, timestamp: Date.now() })));
      const last = this.agent.state.messages.at(-1) as AssistantMessage | undefined;

      if (this.timedOut) reason = { kind: "timedOut", seconds: this.config.turnSeconds };
      else if (last?.role === "assistant" && last.stopReason === "aborted") reason = { kind: "interrupted" };
      else if (last?.role === "assistant" && last.stopReason === "error")
        reason = { kind: "failed", error: last.errorMessage ?? "the model call failed" };
      else reason = { kind: "done" };
    } catch (e) {
      reason = { kind: "failed", error: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }

    await this.record({ type: "turnEnded", turn: this.turn, reason });
  }
}
