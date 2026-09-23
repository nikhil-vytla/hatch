// The agent host: runs one session's agent loop as a client of the daemon.
// Models are reached only through the daemon's gateway, and every tool is
// an effect the daemon performs; the host holds no keys and touches no files.
import {
  type AssistantMessage,
  createModels,
  createProvider,
  type ImageContent,
  type Model,
  type TextContent,
  Type,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent, type AgentMessage, type AgentTool, estimateContextTokens } from "@earendil-works/pi-agent-core";
import {
  type AgentConfig,
  describeError,
  type EffectRequest,
  type Entry,
  type Event,
  type McpTool,
  type StriveClient,
  type TurnEnd,
} from "@strive/protocol";
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
function transcriptText(messages: AgentMessage[]): string {
  const cut = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)} [...]` : s);
  const partText = (c: TextContent | ImageContent) => (c.type === "text" ? c.text : "[image]");
  const blocks: string[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        blocks.push(`USER: ${Array.isArray(m.content) ? m.content.map(partText).join("") : m.content}`);
        break;
      case "toolResult":
        blocks.push(`TOOL RESULT (${m.toolName}): ${cut(m.content.map(partText).join(""))}`);
        break;
      case "assistant": {
        const parts = m.content.map((c) =>
          c.type === "text" ? c.text : c.type === "toolCall" ? `[calls ${c.name} ${JSON.stringify(c.arguments)}]` : "",
        );

        blocks.push(`ASSISTANT: ${parts.join(" ")}`);
        break;
      }
    }
  }

  return blocks.join("\n\n");
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
    execute: async (toolCallId, params, signal) => {
      const request = toRequest(params);
      // Aborting (Esc, or the turn's time limit) cancels the effect in the
      // daemon: one waiting for approval is refused, a running command is
      // killed. The run still answers, so its outcome is journaled.
      const cancel = () => void client.request("effect/cancel", { id: sessionId, callId: toolCallId }).catch(() => {});

      if (signal?.aborted) cancel();
      signal?.addEventListener("abort", cancel, { once: true });

      const r = await client
        .request("effect/run", { id: sessionId, callId: toolCallId, request })
        .finally(() => signal?.removeEventListener("abort", cancel));

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

/**
 * Names for MCP tools that providers accept (letters, digits, _ and -, up to
 * 64) and that stay distinct: `a.b` and `a_b` would both become `a_b`, so a
 * name that would collide gets a short hash of its server and tool.
 */
export function mcpToolNames(tools: McpTool[]): string[] {
  const plain = (t: McpTool) => `mcp__${t.server}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const counts = new Map<string, number>();

  for (const t of tools) counts.set(plain(t), (counts.get(plain(t)) ?? 0) + 1);

  // Every name is checked against those already given, so a hashed name
  // can't land on a tool's own name (a server may advertise `a_b_1kah0i6i`).
  const given = new Set<string>();

  return tools.map((t) => {
    const name = plain(t);

    let candidate =
      name.length <= 64 && counts.get(name) === 1
        ? name
        : `${name.slice(0, 55)}_${Bun.hash(`${t.server}\0${t.name}`).toString(36).slice(0, 8)}`;

    for (let n = 2; given.has(candidate) || (candidate !== name && counts.has(candidate)); n++) {
      candidate = `${name.slice(0, 60 - String(n).length)}_${n}`;
    }

    given.add(candidate);

    return candidate;
  });
}

function mcpTool(client: StriveClient, sessionId: string, t: McpTool, name: string): AgentTool<any> {
  // SAFETY: the server's inputSchema is plain JSON Schema; pi-ai validates tool
  // arguments against plain JSON Schema as well as TypeBox schemas.
  const parameters = t.inputSchema as ReturnType<typeof Type.Object>;
  const description = t.description || `${t.server}'s ${t.name}`;

  return tool(client, sessionId, name, description, parameters, (p) => ({
    kind: "mcp",
    server: t.server,
    tool: t.name,
    arguments: p,
  }));
}

export function tools(client: StriveClient, sessionId: string, mcp: McpTool[] = []): AgentTool<any>[] {
  const names = mcpToolNames(mcp);

  return [
    ...mcp.map((t, i) => mcpTool(client, sessionId, t, names[i] ?? t.name)),
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

const textOf = (m: AssistantMessage) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

export class Host {
  private agent!: Agent;
  private turn = 0;
  /** Prompts not yet sent, with their journal seqs. */
  private queued: { text: string; seq: number }[] = [];
  private running = false;
  private timedOut = false;

  private interrupted = false;
  private lastSeq = 0;
  /**
   * The last journal entry the conversation holds: its history, what this
   * host recorded, and the prompts it took. Notifications can lag the
   * replies to later requests, so this isn't the last entry seen.
   */
  private conversationSeq = 0;
  /** Entries that arrive while `start` is still loading, replayed after it. */
  private early: Entry[] | undefined = [];
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

    // Prompts the last turn didn't take are still waiting: they are sent as
    // the next turn, not replayed as history. (Older journals don't record
    // what a turn took; for them it took everything before its start.)
    const since = lastStart?.event.type === "turnStarted" ? (lastStart.event.throughSeq ?? lastStart.seq) : 0;
    const waiting = entries.filter((e) => e.seq > since && e.event.type === "userMessage");
    const history = entries.filter((e) => !waiting.includes(e));
    this.conversationSeq = Math.max(0, ...history.map((e) => e.seq));
    this.agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(this.config),
        model: model(this.config),
        tools: tools(this.client, this.sessionId, this.config.mcpTools),
        messages: await rebuild(history, blob),
      },
      streamFn: this.models.streamSimple.bind(this.models),
      toolExecution: "parallel",
    });
    let lastDelta = 0;
    this.agent.subscribe(async (event) => {
      if (
        event.type === "message_update" &&
        event.message.role === "assistant" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const now = Date.now();

        if (now - lastDelta > 80) {
          lastDelta = now;
          const text = textOf(event.message);
          void this.client.request("host/stream", { id: this.sessionId, turn: this.turn, text }).catch(() => {});
        }
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        const m = event.message;
        const toolCalls = m.content.flatMap((c) => (c.type === "toolCall" ? [{ id: c.id, name: c.name }] : []));

        await this.record({ type: "assistantMessage", turn: this.turn, text: textOf(m), toolCalls, message: m });
      }
    });
    this.lastSeq = entries.at(-1)?.seq ?? 0;
    this.queued = waiting.flatMap((e) => (e.event.type === "userMessage" ? [{ text: e.event.text, seq: e.seq }] : []));
    const early = this.early ?? [];
    this.early = undefined;

    for (const entry of early) this.onEntry(entry);
    void this.drain();
  }

  onEntry(entry: Entry) {
    if (this.early) {
      this.early.push(entry);

      return;
    }

    if (entry.seq <= this.lastSeq) return;
    this.lastSeq = entry.seq;

    if (entry.event.type === "userMessage") {
      this.queued.push({ text: entry.event.text, seq: entry.seq });
      void this.drain();
    }
  }

  interrupt() {
    if (!this.running) return;
    this.interrupted = true;
    this.agent?.abort();
  }

  /** Journals an event; what it records is now part of the conversation. */
  private async record(event: Event) {
    const { seq } = await this.client.request("host/record", { id: this.sessionId, event });
    this.conversationSeq = Math.max(this.conversationSeq, seq);
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

  /** Summarizes the conversation up to entry `upto` if it has grown past the limit. */
  private async compactIfLarge(upto: number) {
    const messages = this.agent.state.messages;

    if (
      estimateContextTokens(messages).tokens < this.config.compactAtTokens ||
      messages.every((m) => m.role === "system")
    )
      return;

    const reply = await this.models.completeSimple(model(this.config), {
      systemPrompt: SUMMARIZE,
      messages: [{ role: "user", content: transcriptText(messages), timestamp: Date.now() }],
    });

    const summary = textOf(reply).trim();

    if (!summary || reply.stopReason === "error") return;
    await this.record({ type: "compacted", uptoSeq: upto, summary });
    const system = messages.filter((m) => m.role === "system").slice(0, 1);
    this.agent.state.messages = [...system, summaryMessage(summary, Date.now())];
  }

  private async runTurn(prompts: { text: string; seq: number }[]) {
    // The summary covers the conversation so far; prompts no turn has taken
    // (these ones) are kept past it on resume.
    await this.compactIfLarge(this.conversationSeq);
    this.turn += 1;
    this.timedOut = false;
    this.interrupted = false;
    const taken = prompts.at(-1)?.seq;
    await this.record({ type: "turnStarted", turn: this.turn, throughSeq: taken });
    this.conversationSeq = Math.max(this.conversationSeq, taken ?? 0);

    const timer = setTimeout(() => {
      this.timedOut = true;
      this.agent.abort();
    }, this.config.turnSeconds * 1000);

    let reason: TurnEnd;

    try {
      await this.agent.prompt(prompts.map((p) => ({ role: "user" as const, content: p.text, timestamp: Date.now() })));
      const last = this.agent.state.messages.at(-1);

      if (this.timedOut) reason = { kind: "timedOut", seconds: this.config.turnSeconds };
      else if (this.interrupted || (last?.role === "assistant" && last.stopReason === "aborted"))
        reason = { kind: "interrupted" };
      else if (last?.role === "assistant" && last.stopReason === "error")
        reason = { kind: "failed", error: last.errorMessage ?? "the model call failed" };
      else reason = { kind: "done" };
    } catch (e) {
      // An abort can surface as a thrown error; it is still the abort.
      if (this.timedOut) reason = { kind: "timedOut", seconds: this.config.turnSeconds };
      else if (this.interrupted) reason = { kind: "interrupted" };
      else reason = { kind: "failed", error: describeError(e) };
    } finally {
      clearTimeout(timer);
    }

    await this.record({ type: "turnEnded", turn: this.turn, reason });
  }
}
