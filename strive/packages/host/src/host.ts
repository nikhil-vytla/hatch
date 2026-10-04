// The agent host: runs one session's agent loop as a client of the daemon.
// Models are reached only through the daemon's gateway, and every tool is
// an effect the daemon performs; the host holds no keys and touches no files.
import { type ImageContent, type TextContent, Type } from "@earendil-works/pi-ai";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  type AgentConfig,
  describeError,
  type EffectRequest,
  type Entry,
  type ExtensionInfo,
  type Event,
  type McpTool,
  type StriveClient,
  type TurnEnd,
} from "@strive/protocol";
import { ancestry } from "@strive/view";
import { createStriveModels, model, textOf } from "./gateway";
import { learnerMode } from "./learner";
import { PromptReader } from "./learning-records";
import {
  type CheckRun,
  checkCallId,
  checkReport,
  isPrompt,
  PROPOSED,
  rebuild,
  resultText,
  summaryMessage,
  type Unjournaled,
} from "./transcript";

/** How many times a turn goes back to the agent with failed checks before it ends as it is. */
export const CHECK_ROUNDS = 2;

/** Whether a check with these globs applies to a change of `path`; with none, to any change. */
export function applies(paths: string[], changed: string[]): boolean {
  return changed.length > 0 && (paths.length === 0 || changed.some((f) => paths.some((g) => new Bun.Glob(g).match(f))));
}

export function systemPrompt(config: AgentConfig): string {
  return [base(config.cwd), ...projectContext(config)].join("\n\n");
}

/** What the project tells any agent: its instruction files and skills, as sections. */
export function projectContext(config: AgentConfig): string[] {
  const parts: string[] = [];

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

  return parts;
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

      // A command's exit code reaches the model; an extension's tool is one.
      const record =
        request.kind === "bash" || request.kind === "extension"
          ? { kind: "bash" as const, command: "", timeoutMs: 0 }
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

/**
 * Proposes a change to the desktop app's layout. It journals the proposal
 * and changes nothing: a person accepts or rejects it in the app.
 */
function proposeLayout(client: StriveClient, sessionId: string): AgentTool<typeof LayoutProposal> {
  return {
    name: "propose_layout",
    label: "propose_layout",
    description: [
      "Propose a change to the person's desktop workspace: columns (main, side) of panels (transcript, spend, approvals, checkpoints, activity).",
      "By default only the transcript is placed (in main); the other panels exist but show only once moved into a column.",
      "Ops: move {panel, column, before?}, add {panel: {id, kind, title?, html?}, column, before?}, remove {panel}, resize {column, grow}.",
      "An html panel is a small self-contained page you write (a chart, a checklist); it runs sandboxed with no network.",
      "Nothing changes until the person accepts it in the desktop app.",
    ].join(" "),
    parameters: LayoutProposal,
    execute: async (callId, params) => {
      await client.request("host/record", {
        id: sessionId,
        event: { type: "layoutProposed", callId, label: params.label, ops: params.ops },
      });

      return {
        content: [{ type: "text", text: PROPOSED }],
        details: undefined,
      };
    },
  };
}

function layoutProposalSchema() {
  const panel = Type.Object({
    id: Type.String(),
    kind: Type.Union([
      Type.Literal("transcript"),
      Type.Literal("spend"),
      Type.Literal("approvals"),
      Type.Literal("checkpoints"),
      Type.Literal("activity"),
      Type.Literal("html"),
    ]),
    title: Type.Optional(Type.String()),
    html: Type.Optional(
      Type.String({ description: "For kind html: a self-contained page, run sandboxed with no network" }),
    ),
  });

  const op = Type.Object({
    op: Type.Union([Type.Literal("move"), Type.Literal("add"), Type.Literal("remove"), Type.Literal("resize")]),
    panel: Type.Optional(Type.Union([Type.String(), panel])),
    column: Type.Optional(Type.String()),
    before: Type.Optional(Type.String()),
    grow: Type.Optional(Type.Number()),
  });

  return Type.Object({
    label: Type.String({ description: "What the change is for, in a few words" }),
    ops: Type.Array(op),
  });
}

const LayoutProposal = layoutProposalSchema();

/**
 * Proposes the extension a work session drafted (ADR-0027), when a person
 * asked for one: the daemon checks it, runs its tests in the sandbox, and a
 * person decides. Nothing it wrote runs unasked until then.
 */
const ProposeExtensionParams = Type.Object({
  name: Type.String({ description: "The extension's directory under the drafts: 1 to 40 of a-z, 0-9 and -" }),
  summary: Type.String({ description: "One line: what it adds" }),
  rationale: Type.String({ description: "What the user asked for, and why this does it" }),
  prediction: Type.String({ description: "What a later session will be able to do with it" }),
});

function proposeExtension(client: StriveClient, sessionId: string): AgentTool<typeof ProposeExtensionParams> {
  return {
    name: "propose_extension",
    label: "propose_extension",
    description: [
      "Propose an extension you drafted, when the user asked you for a tool: strive's own tools are extensions, TypeScript in .strive/extensions/<name>/ that the agent calls as ext__<name>__<tool>.",
      `Draft it first in ${DRAFTS}/<name>/: extension.json ({"name", "description", "tools": [{"name", "description", "parameters": a JSON Schema object}]}), index.ts (export const tools = { <tool>: async (args) => string }), and *.test.ts files (bun test) that show it works. Run \`bun test ${DRAFTS}/<name>\` yourself first.`,
      "Each tool runs as a command in the sandbox: no network, and only the workspace to read and write.",
      'For a guard the user asked for ("ask before any git push"), declare "hooks": [{"event": "tool_call", "tools": ["bash", "write", ...]}] and export const hooks = { tool_call: async (call) => ({ decision: "ask" | "deny", reason }) or undefined }; call is the request ({kind: "bash", command} and so on). A hook can only ask or refuse, never allow.',
      "The daemon checks the files, runs the tests, and a person accepts or rejects it in `strive review` or the desktop app; nothing runs as an extension until then.",
    ].join(" "),
    parameters: ProposeExtensionParams,
    execute: async (_callId, params) => {
      const r = await client.request("host/proposeExtension", { id: sessionId, ...params });

      const gates = r.gates
        .map((g) => `${g.gate} ${g.verdict}${g.verdict === "pass" ? "" : `: ${g.detail}`}`)
        .join("; ");

      const text = `Proposed as #${r.proposal}. ${gates}. A person accepts or rejects it in \`strive review\` or the desktop app.`;

      if (r.gates.some((g) => g.verdict === "fail"))
        throw new Error(`${text} Fix what failed in the draft and propose again.`);

      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

const DRAFTS = ".strive/drafts/extensions";

/**
 * An extension tool's name as providers accept it (at most 64 characters):
 * `ext__<extension>__<tool>`, or, past 64, its start and a short hash of both.
 */
export function extensionToolName(extension: string, tool: string): string {
  const name = `ext__${extension}__${tool}`;

  return name.length <= 64
    ? name
    : `${name.slice(0, 55)}_${Bun.hash(`${extension}\0${tool}`).toString(36).slice(0, 8)}`;
}

/** How many failed calls leave an extension out for the rest of the session (ADR-0027). */
export const EXTENSION_FAILURES = 3;

/**
 * An extension's tool (ADR-0027): the daemon runs it as a command in the
 * sandbox. One whose calls keep failing is left out for the session.
 */
function extensionTools(client: StriveClient, sessionId: string, extensions: ExtensionInfo[]): AgentTool<any>[] {
  return extensions.flatMap((e) => {
    let failures = 0;

    return e.tools.map((t) => {
      // SAFETY: the daemon checked that the declared parameters are a JSON Schema object.
      const parameters = t.parameters as ReturnType<typeof Type.Object>;

      const run = tool(
        client,
        sessionId,
        extensionToolName(e.name, t.name),
        `${t.description} (from the ${e.name} extension)`,
        parameters,
        (p) => ({
          kind: "extension",
          name: e.name,
          tool: t.name,
          arguments: p,
        }),
      );

      const execute: typeof run.execute = async (...args) => {
        if (failures >= EXTENSION_FAILURES)
          throw new Error(
            `the ${e.name} extension failed ${failures} times, so it's left out for the rest of this session`,
          );

        try {
          const result = await run.execute(...args);
          const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

          if (/\[exit code \d+\]$/.test(text)) failures += 1;

          return result;
        } catch (err) {
          failures += 1;
          throw err;
        }
      };

      return { ...run, execute };
    });
  });
}

export function tools(
  client: StriveClient,
  sessionId: string,
  mcp: McpTool[] = [],
  extensions: ExtensionInfo[] = [],
): AgentTool<any>[] {
  const names = mcpToolNames(mcp);

  return [
    proposeLayout(client, sessionId),
    proposeExtension(client, sessionId),
    ...mcp.map((t, i) => mcpTool(client, sessionId, t, names[i] ?? t.name)),
    ...extensionTools(client, sessionId, extensions),
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

/** What the session's agent is: the coding agent, or the learner. The turn machinery is shared. */
export type AgentMode = {
  systemPrompt: string;
  tools: AgentTool<any>[];
  /** The instruction for summarizing a long conversation. */
  summarize: string;
  /** On resume, what a tool call with nothing in the journal is told. */
  unjournaled?: Unjournaled;
  /** Sees each journal entry that reaches the host, in order. */
  onEntry?: (entry: Entry) => void;
  /** A turn starts, taking the prompts with these seqs. */
  turnStarted?: (prompts: number[]) => void;
  /**
   * The system prompt for the turn that just started, from the project as
   * it is now; without it, the prompt stays as the host was given it.
   */
  turnContext?: () => Promise<string>;
};

function codingMode(client: StriveClient, sessionId: string, config: AgentConfig): AgentMode {
  return {
    systemPrompt: systemPrompt(config),
    tools: tools(client, sessionId, config.mcpTools, config.extensions),
    summarize: SUMMARIZE,
  };
}

export function modeFor(client: StriveClient, sessionId: string, config: AgentConfig): AgentMode {
  return config.kind === "learning" ? learnerMode(client, sessionId, config) : codingMode(client, sessionId, config);
}

export class Host {
  private agent!: Agent;
  private turn = 0;
  /** Stops the running turn's own model calls (the summary); the agent has its own abort. */
  private turnAbort?: AbortController;
  /** Prompts (a person's messages, or learning requests) not yet sent, with their journal seqs. */
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
  private models: ReturnType<typeof createStriveModels>;
  /** A model was chosen for the session's next turns: the next one fetches its config first. */
  private stale = false;
  private readonly mode: AgentMode;
  private readonly prompts = new PromptReader();
  /** The daemon's connection closed: nothing more can be recorded. */
  private lost = false;
  /** Checkpoints taken before prompts, with their entries' seqs: a turn's checks compare against its first. */
  private readonly checkpoints: { seq: number; checkpoint: number }[] = [];

  constructor(
    private readonly client: StriveClient,
    private readonly sessionId: string,
    private config: AgentConfig,
  ) {
    this.models = createStriveModels(model(config));
    this.mode = modeFor(client, sessionId, config);
    client.onClose(() => {
      this.lost = true;
    });
  }

  /**
   * Runs waiting prompts in the background. A turn ends its own failures by
   * recording them; what escapes is a record that couldn't be made, which
   * once the daemon has gone is expected and needs no word.
   */
  private async kick() {
    try {
      await this.drain();
    } catch (e) {
      if (!this.lost) console.error(`a turn stopped: ${describeError(e)}`);
    }
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
    const waiting = new Set(entries.filter((e) => e.seq > since && isPrompt(e)));
    const history = entries.filter((e) => !waiting.has(e));
    this.conversationSeq = Math.max(0, ...history.map((e) => e.seq));
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.mode.systemPrompt,
        model: model(this.config),
        tools: this.mode.tools,
        messages: await this.conversation(history, blob),
      },
      // Through whichever model is current: a person may choose another between turns.
      streamFn: (m, context, options) => this.models.streamSimple(m, context, options),
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
    this.queued = [];

    for (const e of entries) {
      this.mode.onEntry?.(e);
      this.noteModel(e);
      this.noteCheckpoint(e);
      const text = this.prompts.read(e);

      if (text !== undefined && waiting.has(e)) this.queued.push({ text, seq: e.seq });
    }

    const early = this.early ?? [];
    this.early = undefined;

    for (const entry of early) this.onEntry(entry);
    void this.kick();
  }

  onEntry(entry: Entry) {
    if (this.early) {
      this.early.push(entry);

      return;
    }

    if (entry.seq <= this.lastSeq) return;
    this.lastSeq = entry.seq;
    this.mode.onEntry?.(entry);
    this.noteModel(entry);
    this.noteCheckpoint(entry);
    const text = this.prompts.read(entry);

    if (text !== undefined) {
      this.queued.push({ text, seq: entry.seq });
      void this.kick();
    }
  }

  private noteCheckpoint(e: Entry) {
    if (e.event.type === "checkpointed") this.checkpoints.push({ seq: e.seq, checkpoint: e.event.checkpoint });
  }

  /** The conversation the agent goes on from: a fork's parents' up to where it forked, then its own. */
  private async conversation(history: Entry[], blob: (digest: string) => Promise<string>) {
    const read = async (id: string) => (await this.client.request("session/read", { id })).entries;
    const earlier = await ancestry(history, read);

    const parts = await Promise.all(
      [...earlier.map((e) => e.entries), history].map((part) => rebuild(part, blob, this.mode.unjournaled)),
    );

    return parts.flat();
  }

  /** The checkpoint taken just before the prompt at `seq`, if there was one. */
  private checkpointBefore(seq: number): number | undefined {
    return this.checkpoints.findLast((c) => c.seq < seq)?.checkpoint;
  }

  /**
   * Runs, one at a time, the checks that apply to what changed since
   * `checkpoint` (ADR-0023). The daemon reads each check's command from its
   * file; the host only names it. A check the daemon won't run (its file
   * went, say) is left out: nothing of it is journaled to tell on resume.
   */
  private async runChecks(checkpoint: number, round: number, signal: AbortSignal): Promise<CheckRun[]> {
    const { files, more } = await this.client.request("session/changes", { id: this.sessionId, checkpoint });
    const changed = files.map((f) => f.path);
    // Past the listed files, any check might apply, so all of them run.
    const due = this.config.checks.filter((c) => (more ? changed.length > 0 : applies(c.paths, changed)));
    const runs: CheckRun[] = [];

    for (const check of due) {
      if (signal.aborted) break;
      const callId = checkCallId(this.turn, round, check.name);
      const cancel = () => void this.client.request("effect/cancel", { id: this.sessionId, callId }).catch(() => {});
      signal.addEventListener("abort", cancel, { once: true });

      try {
        const r = await this.client.request("effect/run", {
          id: this.sessionId,
          callId,
          request: { kind: "check", name: check.name },
        });

        runs.push({ record: r.record, outcome: r.outcome, output: r.text });
      } catch (e) {
        console.error(`the check ${check.name} didn't run: ${describeError(e)}`);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }

    return runs;
  }

  interrupt() {
    if (!this.running) return;
    this.interrupted = true;
    this.turnAbort?.abort();
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
  private async compactIfLarge(upto: number, signal: AbortSignal) {
    const messages = this.agent.state.messages;

    if (
      estimateContextTokens(messages).tokens < this.config.compactAtTokens ||
      messages.every((m) => m.role === "system")
    )
      return;

    const reply = await this.models.completeSimple(
      model(this.config),
      {
        systemPrompt: this.mode.summarize,
        messages: [{ role: "user", content: transcriptText(messages), timestamp: Date.now() }],
      },
      { signal },
    );

    const summary = textOf(reply).trim();

    if (!summary || reply.stopReason === "error" || reply.stopReason === "aborted" || signal.aborted) return;
    await this.record({ type: "compacted", uptoSeq: upto, summary });
    const system = messages.filter((m) => m.role === "system").slice(0, 1);
    this.agent.state.messages = [...system, summaryMessage(summary, Date.now())];
  }

  /**
   * Replaces the text of the conversation's leading system message, which
   * the agent always has (it declares the tools) and a summary keeps. The
   * history stays; only what the model is told about the project changes.
   */
  private replaceSystemPrompt(prompt: string) {
    const [first, ...rest] = this.agent.state.messages;

    if (first?.role !== "system") throw new Error("the conversation has no system message to replace");
    this.agent.state.messages = [{ ...first, content: prompt }, ...rest];
  }

  /** A model chosen for the next turns, other than this host's: its limits are fetched before the next turn. */
  private noteModel(entry: Entry) {
    if (entry.event.type !== "modelSet" || entry.event.model === this.config.model) return;
    this.stale = true;
  }

  /** The config for a newly chosen model, fetched until it is. */
  private async reconfigure() {
    if (!this.stale) return;
    this.config = await this.client.request("host/config", { id: this.sessionId });
    this.models = createStriveModels(model(this.config));
    this.agent.state.model = model(this.config);
    this.stale = false;
  }

  private async runTurn(prompts: { text: string; seq: number }[]) {
    // The summary covers the conversation before this turn; the prompts this
    // turn takes are kept past it on resume.
    const upto = this.conversationSeq;
    this.turn += 1;
    this.timedOut = false;
    this.interrupted = false;
    const taken = prompts.at(-1)?.seq;
    this.mode.turnStarted?.(prompts.map((p) => p.seq));
    await this.record({ type: "turnStarted", turn: this.turn, throughSeq: taken });
    this.conversationSeq = Math.max(this.conversationSeq, taken ?? 0);

    try {
      await this.reconfigure();
    } catch (e) {
      const error = `the session's new model couldn't be taken up: ${describeError(e)}`;
      await this.record({ type: "turnEnded", turn: this.turn, reason: { kind: "failed", error } });

      return;
    }

    if (this.mode.turnContext) {
      try {
        this.replaceSystemPrompt(await this.mode.turnContext());
      } catch (e) {
        const error = `the project's context couldn't be loaded: ${describeError(e)}`;
        await this.record({ type: "turnEnded", turn: this.turn, reason: { kind: "failed", error } });

        return;
      }
    }

    // Summarizing is part of the turn: Esc and the time limit stop it too.
    const abort = new AbortController();
    this.turnAbort = abort;

    const timer = setTimeout(() => {
      this.timedOut = true;
      abort.abort();
      this.agent.abort();
    }, this.config.turnSeconds * 1000);

    try {
      await this.compactIfLarge(upto, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) console.error(`summarizing failed, going on without: ${describeError(e)}`);
    }

    if (abort.signal.aborted) {
      clearTimeout(timer);

      const reason: TurnEnd = this.timedOut
        ? { kind: "timedOut", seconds: this.config.turnSeconds }
        : { kind: "interrupted" };

      await this.record({ type: "turnEnded", turn: this.turn, reason });

      return;
    }

    const first = prompts[0]?.seq;
    const checkpoint = first === undefined ? undefined : this.checkpointBefore(first);
    const asked = prompts.map((p) => ({ role: "user" as const, content: p.text, timestamp: Date.now() }));
    let reason = await this.ask(asked);

    try {
      if (reason.kind === "done" && checkpoint !== undefined) reason = await this.check(checkpoint, abort.signal);
    } finally {
      clearTimeout(timer);
    }

    await this.record({ type: "turnEnded", turn: this.turn, reason });
  }

  /**
   * A turn that finished its work has it checked (ADR-0023): a failure goes
   * back to the agent, up to CHECK_ROUNDS times, then the turn ends as it is.
   */
  private async check(checkpoint: number, signal: AbortSignal): Promise<TurnEnd> {
    let reason: TurnEnd = { kind: "done" };

    try {
      for (let round = 1; reason.kind === "done" && this.config.checks.length > 0; round++) {
        const report = checkReport(await this.runChecks(checkpoint, round, signal));

        if (report === undefined || round > CHECK_ROUNDS || signal.aborted) break;

        // Journaled before the agent sees it, so a host that stops between
        // resumes with the agent told.
        await this.record({ type: "checksReported", turn: this.turn, text: report });
        reason = await this.ask([{ role: "user", content: report, timestamp: Date.now() }]);
      }
    } catch (e) {
      console.error(`the checks didn't run: ${describeError(e)}`);
    }

    if (reason.kind !== "done") return reason;

    if (this.timedOut) return { kind: "timedOut", seconds: this.config.turnSeconds };

    return this.interrupted ? { kind: "interrupted" } : reason;
  }

  /** Gives the agent these messages and runs it until it stops; how it stopped. */
  private async ask(messages: AgentMessage[]): Promise<TurnEnd> {
    try {
      await this.agent.prompt(messages);
      const last = this.agent.state.messages.at(-1);

      if (this.timedOut) return { kind: "timedOut", seconds: this.config.turnSeconds };

      if (this.interrupted || (last?.role === "assistant" && last.stopReason === "aborted"))
        return { kind: "interrupted" };

      if (last?.role === "assistant" && last.stopReason === "error")
        return { kind: "failed", error: last.errorMessage ?? "the model call failed" };

      return { kind: "done" };
    } catch (e) {
      // An abort can surface as a thrown error; it is still the abort.
      if (this.timedOut) return { kind: "timedOut", seconds: this.config.turnSeconds };

      if (this.interrupted) return { kind: "interrupted" };

      return { kind: "failed", error: describeError(e) };
    }
  }
}
