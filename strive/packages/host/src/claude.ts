// The Claude Code engine (ADR-0031): Claude Code runs the session's turns
// through its Agent SDK, with its own tools. Every call asks the daemon
// before it runs (`effect/observe`), and what it gave the model is
// reported back (`effect/report`), so the journal holds each call as
// observed. Model calls go through the session's gateway, so the budget is
// reserved before each one and the exact bytes are kept.
import {
  type CanUseTool,
  type EffortLevel,
  query,
  type SDKMessage,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentConfig,
  describeError,
  type Effort,
  type Entry,
  type Event,
  type StriveClient,
  type TurnEnd,
} from "@strive/protocol";
import { dirname } from "node:path";
import * as v from "valibot";
import { projectContext } from "./host";
import { PromptReader } from "./learning-records";
import { isPrompt } from "./transcript";

/**
 * Claude Code's own tools, but for the one the gateway refuses: web search
 * runs at the provider and is billed there, which strive can't bound.
 */
const DISALLOWED = ["WebSearch"];

/**
 * Which Claude Code runs: `STRIVE_CLAUDE_CODE`, else the one the SDK pins
 * (a separate native package, present when the host runs from source but not
 * inside the compiled `strive-tui`), else the `claude` on the path.
 */
export function claudeExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.STRIVE_CLAUDE_CODE) return env.STRIVE_CLAUDE_CODE;

  try {
    const sdk = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);

    return Bun.resolveSync(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`, dirname(sdk));
  } catch {
    return Bun.which("claude", { PATH: env.PATH ?? "" }) ?? undefined;
  }
}

/** What a tool result's content says, as text. */
function resultText(content: string | { type: string; text?: string }[] | undefined): string {
  if (content === undefined) return "";

  return Array.isArray(content)
    ? content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("")
    : content;
}

/** The text of an assistant message's blocks. */
function textOf(blocks: { type: string; text?: string }[]): string {
  return blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("");
}

export class ClaudeHost {
  private turn = 0;
  private queued: { text: string; seq: number }[] = [];
  private running = false;
  private abort?: AbortController;
  private timedOut = false;
  /** Claude Code's own session, resumed by its id: its transcript is in the engine's home. */
  private claudeSession?: string;
  /** Each tool call the daemon allowed, by its tool-use id: what its result is reported against. */
  private readonly calls = new Map<string, number>();
  /** Each tool call the daemon refused: Claude Code gives the model the refusal as its result. */
  private readonly refused = new Set<string>();
  private readonly prompts = new PromptReader();
  /** A model was chosen for the session's next turns: the next one fetches its config first. */
  private stale = false;
  /** How much the model thinks, as last set: each turn starts with it. */
  private effort: Effort = "off";
  private early: Entry[] | undefined = [];
  private lost = false;

  constructor(
    private readonly client: StriveClient,
    private readonly sessionId: string,
    private config: AgentConfig,
  ) {
    client.onClose(() => {
      this.lost = true;
    });
  }

  /** Resumes from the journal and handles prompts as they arrive. */
  async start(entries: Entry[]): Promise<void> {
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

    for (const e of entries) {
      const resumed = e.event.type === "assistantMessage" ? v.safeParse(Resumable, e.event.message) : undefined;

      if (resumed?.success) this.claudeSession = resumed.output.claudeSession;
    }

    const since = lastStart?.event.type === "turnStarted" ? (lastStart.event.throughSeq ?? lastStart.seq) : 0;

    for (const e of entries) {
      this.noteModel(e);
      const text = this.prompts.read(e);

      if (text !== undefined && e.seq > since && isPrompt(e)) this.queued.push({ text, seq: e.seq });
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

    this.noteModel(entry);
    const text = this.prompts.read(entry);

    if (text !== undefined) {
      this.queued.push({ text, seq: entry.seq });
      void this.kick();
    }
  }

  /** A model chosen for the next turns, other than this host's: Claude Code is started on it from then on. */
  private noteModel(entry: Entry) {
    if (entry.event.type === "effortSet") this.effort = entry.event.effort;

    if (entry.event.type !== "modelSet" || entry.event.model === this.config.model) return;
    this.stale = true;
  }

  /** The config for a newly chosen model, fetched until it is. */
  private async reconfigure() {
    if (!this.stale) return;
    this.config = await this.client.request("host/config", { id: this.sessionId });
    this.stale = false;
  }

  interrupt() {
    if (!this.running) return;
    this.abort?.abort();
  }

  private async kick() {
    if (this.running || this.queued.length === 0) return;
    this.running = true;

    try {
      while (this.queued.length > 0) await this.runTurn(this.queued.splice(0));
    } catch (e) {
      if (!this.lost) console.error(`a turn stopped: ${describeError(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async record(event: Event) {
    await this.client.request("host/record", { id: this.sessionId, event });
  }

  /** Asks the daemon about a call before Claude Code runs it; anything but its yes is a no. */
  private readonly canUseTool: CanUseTool = async (tool, input, { toolUseID }) => {
    try {
      const r = await this.client.request("effect/observe", { id: this.sessionId, callId: toolUseID, tool, input });

      if (r.allowed) {
        this.calls.set(toolUseID, r.effect);

        return { behavior: "allow", updatedInput: input };
      }

      this.refused.add(toolUseID);

      return { behavior: "deny", message: r.reason ?? "strive refused this" };
    } catch (e) {
      this.refused.add(toolUseID);

      return { behavior: "deny", message: `strive couldn't decide this, so it's refused: ${describeError(e)}` };
    }
  };

  private async runTurn(prompts: { text: string; seq: number }[]) {
    this.turn += 1;
    this.timedOut = false;
    await this.record({ type: "turnStarted", turn: this.turn, throughSeq: prompts.at(-1)?.seq });
    const abort = new AbortController();

    this.abort = abort;

    const timer = setTimeout(() => {
      this.timedOut = true;
      abort.abort();
    }, this.config.turnSeconds * 1000);

    let reason: TurnEnd = { kind: "done" };

    try {
      await this.reconfigure();
      reason = await this.converse(prompts.map((p) => p.text).join("\n\n"), abort);
    } catch (e) {
      reason = abort.signal.aborted ? this.stopped() : { kind: "failed", error: describeError(e) };
    } finally {
      clearTimeout(timer);
    }

    await this.record({ type: "turnEnded", turn: this.turn, reason });
  }

  private stopped(): TurnEnd {
    return this.timedOut ? { kind: "timedOut", seconds: this.config.turnSeconds } : { kind: "interrupted" };
  }

  /** What Claude Code runs with: none of the person's environment but its path and home. */
  private env(): ClaudeEnv {
    const env: ClaudeEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ANTHROPIC_BASE_URL: this.config.baseUrl,
      // The gateway puts the real key in; Claude Code never holds it.
      ANTHROPIC_API_KEY: "strive-gateway",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
    };

    // Its own transcripts, kept with the session so it resumes.
    if (this.config.engineHome) env.CLAUDE_CONFIG_DIR = this.config.engineHome;

    return env;
  }

  /**
   * How much Claude Code's model thinks. Not thinking is always said, since
   * Claude Code thinks by default: with effort off, or a model strive's
   * table doesn't list as thinking (as the native agent does). A level is
   * Claude Code's to map onto the model.
   */
  private thinking(): ClaudeThinking {
    const options: ClaudeThinking = {};

    if (this.effort === "off" || !this.config.reasoning) options.thinking = { type: "disabled" };
    else options.effort = this.effort;

    return options;
  }

  /** One turn of Claude Code, its messages journaled as they come. */
  private async converse(prompt: string, abort: AbortController): Promise<TurnEnd> {
    const executable = claudeExecutable();

    if (executable === undefined) {
      return {
        kind: "failed",
        error:
          "Claude Code isn't installed: install it (https://claude.com/claude-code), or set STRIVE_CLAUDE_CODE to its path",
      };
    }

    const conversation = query({
      prompt,
      options: {
        cwd: this.config.cwd,
        pathToClaudeCodeExecutable: executable,
        model: this.config.model,
        ...this.thinking(),
        resume: this.claudeSession,
        abortController: abort,
        includePartialMessages: true,
        // None of the person's Claude settings, hooks or permissions: strive's alone.
        settingSources: [],
        settings: { permissions: { ask: ["*"] } },
        canUseTool: this.canUseTool,
        disallowedTools: DISALLOWED,
        systemPrompt: { type: "preset", preset: "claude_code", append: projectContext(this.config).join("\n\n") },
        // Sandboxed, and still asked: by default a sandboxed command runs
        // without asking, past strive's gate.
        sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false },
        env: this.env(),
      },
    });

    let streamed = "";
    let lastDelta = 0;

    for await (const m of conversation) {
      const ended = await this.message(m);

      if (ended) return ended;

      if (m.type === "stream_event" && m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") {
        streamed += m.event.delta.text;
        const now = Date.now();

        if (now - lastDelta > 80) {
          lastDelta = now;
          void this.client
            .request("host/stream", { id: this.sessionId, turn: this.turn, text: streamed })
            .catch(() => {});
        }
      }

      if (m.type === "assistant") streamed = "";
    }

    return abort.signal.aborted ? this.stopped() : { kind: "done" };
  }

  /** Journals what a message says; how the turn ended, once it has. */
  private async message(m: SDKMessage): Promise<TurnEnd | undefined> {
    if (m.type === "system" && m.subtype === "init") this.claudeSession = m.session_id;

    if (m.type === "assistant") {
      const blocks = m.message.content;
      const toolCalls = blocks.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name }] : []));
      const text = textOf(blocks);

      await this.record({
        type: "assistantMessage",
        turn: this.turn,
        text,
        toolCalls,
        // Read back on resume: which of Claude Code's sessions to go on with.
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          claudeSession: m.session_id,
        },
      });
    }

    if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type !== "tool_result") continue;
        const effect = this.calls.get(block.tool_use_id);

        // The refusal, as the model was told it; the daemon journaled it already.
        if (effect === undefined && block.is_error === true && this.refused.delete(block.tool_use_id)) continue;

        // Any other result for a call the daemon never cleared ran past strive's gate.
        if (effect === undefined)
          return { kind: "failed", error: `Claude Code ran a tool strive didn't allow (${block.tool_use_id})` };
        this.calls.delete(block.tool_use_id);
        await this.client.request("effect/report", {
          id: this.sessionId,
          effect,
          output: resultText(block.content),
          failed: block.is_error === true,
        });
      }
    }

    if (m.type === "result") {
      return m.subtype === "success" ? { kind: "done" } : { kind: "failed", error: `Claude Code: ${m.subtype}` };
    }

    return undefined;
  }
}

/** The thinking a turn asks of Claude Code's model. */
type ClaudeThinking = { thinking?: ThinkingConfig; effort?: EffortLevel };

/** What Claude Code's process is given. */
type ClaudeEnv = {
  PATH: string;
  HOME: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: string;
  DISABLE_TELEMETRY: string;
  DISABLE_AUTOUPDATER: string;
  CLAUDE_CONFIG_DIR?: string;
};

/** A reply journaled by this engine: which of Claude Code's sessions it came from. */
const Resumable = v.object({ claudeSession: v.string() });
