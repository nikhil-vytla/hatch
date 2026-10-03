// The ACP bridge (ADR-0029): an editor speaks the Agent Client Protocol to
// this process, which is an ordinary client of the daemon. The agent loop
// runs in the host the daemon starts; this only relays and asks.
import * as acp from "@agentclientprotocol/sdk";
import type {
  ApprovalMode,
  Decision,
  EffectOutcome,
  EffectRecord,
  Entry,
  StriveClient,
  TurnEnd,
} from "@strive/protocol";
import { describeError } from "@strive/protocol";
import { MODE_NAMES, sessionAllowance } from "@strive/view";

const MODES: ApprovalMode[] = ["ask", "autoEdit", "fullAuto"];

const MODE_TEXT: Record<ApprovalMode, string> = {
  ask: "Asks before every change and command",
  autoEdit: "Changes files in the workspace without asking; asks before commands",
  fullAuto: "Runs commands in the sandbox and changes the workspace without asking",
};

/** What a prompt says, as one text: embedded files inlined under their URI, links named. */
export function promptText(blocks: acp.ContentBlock[]): string {
  const parts = blocks.map((b) => {
    switch (b.type) {
      case "text":
        return b.text;
      case "resource_link":
        return `[${b.name}](${b.uri})`;
      case "resource":
        return "text" in b.resource
          ? `<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>`
          : `[${b.resource.uri}]`;
      case "image":
      case "audio":
        throw acp.RequestError.invalidParams(
          undefined,
          `strive takes text prompts; this one has ${b.type === "image" ? "an image" : "audio"}`,
        );
    }
  });

  return parts.join("\n\n");
}

/** The tool call an effect is, as an editor shows it. */
export function toolCall(record: EffectRecord, cwd: string): Pick<acp.ToolCall, "title" | "kind" | "locations"> {
  const at = (path: string) => [{ path: path.startsWith("/") ? path : `${cwd}/${path}` }];

  switch (record.kind) {
    case "read":
      return { title: `Read ${record.path}`, kind: "read", locations: at(record.path) };
    case "write":
      return { title: `Write ${record.path}`, kind: "edit", locations: at(record.path) };
    case "edit":
      return { title: `Edit ${record.path}`, kind: "edit", locations: at(record.path) };
    case "bash":
      return { title: `Run: ${record.command}`, kind: "execute", locations: [] };
    case "check":
      return { title: `Check ${record.name}: ${record.command}`, kind: "execute", locations: [] };
    case "mcp":
      return { title: `${record.server}'s ${record.tool}`, kind: "other", locations: [] };
    case "extension":
      return { title: `${record.name}'s ${record.tool}`, kind: "other", locations: [] };
  }
}

/** The most of a tool call's output an editor is sent. */
export const OUTPUT_LIMIT = 20_000;

/** An effect's end, as its tool call's last update says it. */
export type Finished = { status: acp.ToolCallStatus; text: string };

/** How an effect ended. */
export function finished(outcome: EffectOutcome): Finished {
  switch (outcome.kind) {
    case "done":
      return {
        status: outcome.exitCode === undefined || outcome.exitCode === 0 ? "completed" : "failed",
        text: outcome.exitCode === undefined ? "done" : `exited ${outcome.exitCode}`,
      };
    case "refused":
      return { status: "failed", text: outcome.reason };
    case "interrupted":
      return { status: "failed", text: "interrupted" };
  }
}

/** Why a turn that didn't just finish ended, said to the person; nothing for one that did. */
function endText(reason: TurnEnd): string | undefined {
  switch (reason.kind) {
    case "done":
    case "interrupted":
      return undefined;
    case "timedOut":
      return `The turn ran past its ${reason.seconds}s limit and was stopped.`;
    case "failed":
      return `The turn failed: ${reason.error}`;
  }
}

const stopReason = (reason: TurnEnd): acp.StopReason => (reason.kind === "interrupted" ? "cancelled" : "end_turn");

/** A prompt this bridge sent, until its turn ends. */
type Waiting = { seq?: number; turn?: number; resolve: (r: acp.PromptResponse) => void };

/** One strive session an editor has open. */
class Session {
  /** What the editor has been sent of the reply the model is giving now. */
  private shown = "";

  /** The editor's tool call for each effect. */
  private readonly calls = new Map<number, string>();

  /** Turns started, where, and the last prompt each took; and turns ended. */
  private readonly started: { turn: number; at: number; through?: number }[] = [];

  private readonly ended = new Map<number, TurnEnd>();

  /** Approvals the editor is being asked, by effect, to withdraw if another client answers. */
  private readonly asking = new Map<number, AbortController>();

  waiting?: Waiting;

  /** Said with the next prompt's reply: what the editor asked for that strive doesn't do. */
  notice?: string;

  mode: ApprovalMode = "ask";

  /**
   * Updates go out in journal order through this chain, so an effect's
   * output, fetched from the daemon, isn't overtaken by what follows it.
   */
  private sent: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly cwd: string,
    private readonly daemon: StriveClient,
    private readonly editor: acp.AgentContext,
  ) {}

  private update(update: acp.SessionUpdate) {
    this.later(async () => update);
  }

  /** An update made when its turn in the chain comes. */
  private later(make: () => Promise<acp.SessionUpdate>) {
    this.sent = this.sent
      .then(async () => this.editor.notify("session/update", { sessionId: this.id, update: await make() }))
      .catch(() => undefined);
  }

  /** Once every update so far has gone out. */
  flushed(): Promise<void> {
    return this.sent;
  }

  /** What an effect printed or read, as the daemon kept it; its ending if it kept none. */
  private async output(e: Extract<Entry["event"], { type: "effectFinished" }>): Promise<string> {
    const { text } = finished(e.outcome);

    if (e.outcome.kind !== "done") return text;

    try {
      const blob = await this.daemon.request("blob/get", { digest: e.outcome.output });
      const shown = blob.text.length > OUTPUT_LIMIT ? `${blob.text.slice(0, OUTPUT_LIMIT)}\n[…cut]` : blob.text;

      return shown.trim() ? `${shown.trimEnd()}\n\n(${text})` : text;
    } catch {
      return text;
    }
  }

  say(text: string) {
    this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  modes(): acp.SessionModeState {
    return {
      currentModeId: this.mode,
      availableModes: MODES.map((m) => ({ id: m, name: MODE_NAMES[m], description: MODE_TEXT[m] })),
    };
  }

  /** The reply so far of the model call under way. */
  delta(text: string) {
    if (text.startsWith(this.shown)) {
      const more = text.slice(this.shown.length);

      if (more) this.say(more);
    } else {
      this.say(text);
    }

    this.shown = text;
  }

  /** Relays one journal entry; `replaying` when it is history the editor hasn't seen. */
  entry(entry: Entry, replaying: boolean) {
    const e = entry.event;

    switch (e.type) {
      case "userMessage":
        if (replaying) this.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: e.text } });
        break;
      case "modelCallStarted":
        this.shown = "";
        break;
      case "assistantMessage":
        this.delta(e.text);
        this.shown = "";
        break;
      case "effectStarted":
        this.calls.set(e.effect, e.callId);
        this.update({
          sessionUpdate: "tool_call",
          toolCallId: e.callId,
          status: "in_progress",
          rawInput: e.record,
          ...toolCall(e.record, this.cwd),
        });
        break;
      case "effectFinished": {
        const { status } = finished(e.outcome);
        const toolCallId = this.calls.get(e.effect) ?? `effect-${e.effect}`;

        this.later(async () => ({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status,
          content: [{ type: "content", content: { type: "text", text: await this.output(e) } }],
        }));
        break;
      }

      case "approvalModeSet":
        this.mode = e.mode;

        if (!replaying) this.update({ sessionUpdate: "current_mode_update", currentModeId: e.mode });
        break;
      case "approvalRequested":
        if (!replaying) this.ask(e.effect, e.description, e.sessionFile);
        break;
      case "approvalDecided":
        this.asking.get(e.effect)?.abort();
        break;
      case "turnStarted":
        this.started.push({ turn: e.turn, at: entry.seq, through: e.throughSeq });
        break;
      case "turnEnded": {
        const why = endText(e.reason);

        if (why && !replaying) this.say(`\n\n${why}`);
        this.ended.set(e.turn, e.reason);
        break;
      }

      default:
        break;
    }

    if (!replaying) this.settle();
  }

  /** The answer to a prompt about to be sent, once its turn ends. */
  wait(): Promise<acp.PromptResponse> {
    return new Promise((resolve) => {
      this.waiting = { resolve };
    });
  }

  /** The waiting prompt was journaled at `seq`. */
  prompted(seq: number) {
    if (this.waiting) this.waiting.seq = seq;
    this.settle();
  }

  /** Answers the waiting prompt once the turn that took it has ended. */
  settle() {
    const w = this.waiting;

    if (!w || w.seq === undefined) return;

    const seq = w.seq;

    // A turn without `throughSeq` took the prompts journaled before it.
    w.turn ??= this.started.find((t) => (t.through === undefined ? t.at > seq : t.through >= seq))?.turn;
    const reason = w.turn === undefined ? undefined : this.ended.get(w.turn);

    if (reason) {
      this.waiting = undefined;
      // The turn's updates reach the editor before its answer does.
      this.flushed().then(() => w.resolve({ stopReason: stopReason(reason) }));
    }
  }

  /** Asks the editor about an effect, and answers the daemon with what it chose. */
  private ask(effect: number, description: string, sessionFile: string | undefined) {
    const withdrawn = new AbortController();

    this.asking.set(effect, withdrawn);

    const always =
      sessionFile === undefined
        ? "Allow everything for this session (full-auto)"
        : `Allow ${sessionAllowance(sessionFile)}`;

    const asked = this.editor.request(
      "session/request_permission",
      {
        sessionId: this.id,
        toolCall: { toolCallId: this.calls.get(effect) ?? `effect-${effect}`, title: description, status: "pending" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "allowSession", name: always, kind: "allow_always" },
          { optionId: "deny", name: "Decline", kind: "reject_once" },
        ],
      },
      { cancellationSignal: withdrawn.signal },
    );

    asked
      .then((r) => this.decide(effect, r.outcome.outcome === "selected" ? decision(r.outcome.optionId) : "deny"))
      // Withdrawn because another client answered, or the editor went away.
      .catch(() => (withdrawn.signal.aborted ? undefined : this.decide(effect, "deny")))
      .finally(() => this.asking.delete(effect));
  }

  private decide(effect: number, choice: Decision) {
    this.daemon
      .request("approval/respond", { id: this.id, effect, decision: choice })
      // Another client answered first; the daemon has its answer.
      .catch(() => undefined);
  }
}

function decision(optionId: string): Decision {
  return optionId === "allow" || optionId === "allowSession" ? optionId : "deny";
}

/** The ACP agent: each editor session is a strive session it is attached to. */
export function bridge(daemon: StriveClient, version: string): acp.AgentApp {
  const sessions = new Map<string, Session>();

  const session = (id: string) => {
    const s = sessions.get(id);

    if (!s) throw acp.RequestError.invalidParams(undefined, `no session ${id} is open here`);

    return s;
  };

  daemon.on("session/entry", (n) => sessions.get(n.sessionId)?.entry(n.entry, false));
  daemon.on("session/delta", (n) => sessions.get(n.sessionId)?.delta(n.text));

  // A new session's history has nothing an editor shows; a loaded one's is replayed.
  const open = async (id: string, editor: acp.AgentContext, mcpServers: acp.McpServer[]) => {
    const { session: info, entries } = await daemon.request("session/attach", { id });
    const s = new Session(info.id, info.cwd, daemon, editor);

    for (const e of entries) s.entry(e, true);
    await s.flushed();
    sessions.set(info.id, s);

    if (mcpServers.length > 0) {
      s.notice =
        "strive runs the MCP servers in its own settings (`mcpServers` in ~/.strive/settings.json), not the editor's.\n\n";
    }

    return s;
  };

  return acp
    .agent({ name: "strive" })
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      agentInfo: { name: "strive", version },
      authMethods: [],
    }))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", async (ctx) => {
      const { id } = await daemon.request("session/create", { cwd: ctx.params.cwd });
      const s = await open(id, ctx.client, ctx.params.mcpServers);

      return { sessionId: s.id, modes: s.modes() };
    })
    .onRequest("session/load", async (ctx) => {
      const s = await open(ctx.params.sessionId, ctx.client, ctx.params.mcpServers);

      return { modes: s.modes() };
    })
    .onRequest("session/set_mode", async (ctx) => {
      const s = session(ctx.params.sessionId);
      const mode = MODES.find((m) => m === ctx.params.modeId);

      if (!mode)
        throw acp.RequestError.invalidParams(
          undefined,
          `no mode ${ctx.params.modeId}; the modes are ${MODES.join(", ")}`,
        );
      await daemon.request("session/approvals", { id: s.id, mode });

      return {};
    })
    .onRequest("session/prompt", async (ctx) => {
      const s = session(ctx.params.sessionId);

      if (s.waiting) throw acp.RequestError.invalidRequest(undefined, "a prompt is already running in this session");
      const text = promptText(ctx.params.prompt);
      const done = s.wait();

      if (s.notice) {
        s.say(s.notice);
        s.notice = undefined;
      }

      try {
        const { seq } = await daemon.request("session/prompt", { id: s.id, text, requestId: crypto.randomUUID() });

        s.prompted(seq);
      } catch (e) {
        s.waiting = undefined;
        throw acp.RequestError.internalError(undefined, describeError(e));
      }

      return done;
    })
    .onNotification("session/cancel", async (ctx) => {
      await daemon.request("session/interrupt", { id: session(ctx.params.sessionId).id }).catch(() => undefined);
    });
}
