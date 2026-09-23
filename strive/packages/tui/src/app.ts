// The strive TUI: a thin client over the daemon. It renders and forwards
// intent; sessions, budgets and effects live in strived. Everything shown in
// the transcript comes from the session journal, so every attached client
// shows the same thing.
import { homedir } from "node:os";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type SlashCommand,
  Spacer,
  type TUI,
  Text,
  matchesKey,
} from "@earendil-works/pi-tui";
import { type Entry, type InitializeResult, ServerError, type SessionInfo, type StriveClient } from "@strive/protocol";
import { formatUsd } from "./format";
import { Spend } from "./spend";
import { editorTheme, style } from "./theme";

export { formatUsd };

export const COMMANDS: SlashCommand[] = [
  { name: "status", description: "Show the daemon's status" },
  { name: "session", description: "Show this session's id and how to resume it" },
  { name: "budget", description: "Set this session's spending limit: /budget 10, or /budget off", argumentHint: "<dollars>|off" },
  { name: "help", description: "List commands and keys" },
  { name: "quit", description: "Exit strive (the daemon keeps running)" },
];

/** Which session to open: `new`, `continue` (latest in this directory), or an id. */
export type SessionMode = "new" | "continue" | { resume: string };

export function parseSessionMode(raw: string | undefined): SessionMode {
  if (!raw || raw === "new") return "new";
  if (raw === "continue") return "continue";
  return { resume: raw };
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const shortId = (id: string) => `…${id.slice(-6)}`;

export function describe(entry: Entry): string {
  const e = entry.event;
  switch (e.type) {
    case "sessionStarted":
      return style.faint(`Session started in ${tilde(e.cwd)}`);
    case "userMessage":
      return `${style.accent("›")} ${e.text}`;
    case "recovered":
      return style.danger(`Recovered after a crash: discarded a partial entry (${e.discardedBytes} bytes).`);
    case "budgetSet":
      return style.faint(`Budget: ${budgetText(e.usdMicros, e.tokens)}`);
    case "modelCallStarted":
      return style.faint(`${e.provider} ${e.model} …`);
    case "modelCallFinished":
      switch (e.outcome.kind) {
        case "complete":
          return style.faint(
            `${e.outcome.usage.input} in · ${e.outcome.usage.output} out · ${formatUsd(e.outcome.costUsdMicros)}`,
          );
        case "rejected":
          return style.danger(`The provider refused the call (HTTP ${e.outcome.status}).`);
        case "broken":
          return style.danger(`The call broke (${e.outcome.reason}); charged its full hold of ${formatUsd(e.outcome.costUsdMicros)}.`);
      }
    case "effectStarted": {
      const r = e.record;
      const what = r.kind === "bash" ? `$ ${r.command}` : r.kind === "write" ? `write ${r.path} (${r.bytes} bytes)` : `${r.kind} ${r.path}`;
      return style.muted(what);
    }
    case "effectFinished":
      switch (e.outcome.kind) {
        case "done":
          return style.faint(e.outcome.exitCode === undefined ? "done" : `exit ${e.outcome.exitCode}`);
        case "refused":
          return style.danger(`Refused: ${e.outcome.reason}`);
        case "interrupted":
          return style.danger("Interrupted: the daemon stopped while this ran.");
      }
  }
}


function budgetText(usd?: number, tokens?: number): string {
  if (usd === undefined && tokens === undefined) return "unlimited";
  return [usd === undefined ? null : formatUsd(usd), tokens === undefined ? null : `${tokens} tokens`]
    .filter(Boolean)
    .join(" and ");
}

export class App {
  readonly transcript = new Container();
  readonly editor: Editor;
  private readonly header = new Text("", 1, 0);
  private readonly footer = new Text("", 1, 0);
  private readonly spend = new Spend();
  private readonly offClose: () => void;
  private session?: SessionInfo;
  private lastSeq = 0;
  /** Entries that arrived before the attach reply; shown after its history. */
  private early: { sessionId: string; entry: Entry }[] = [];
  private notedMissingAgent = false;

  constructor(
    private readonly tui: TUI,
    private readonly client: StriveClient,
    private readonly init: InitializeResult,
    private readonly exit: (code: number) => void,
    private readonly cwd = process.cwd(),
  ) {
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, cwd));
    this.editor.onSubmit = (text) => {
      this.submit(text.trim()).catch((e) => this.say(style.danger((e as Error).message)));
    };
    this.editor.disableSubmit = true;
    this.renderHeader();

    tui.addChild(this.header);
    tui.addChild(new Spacer(1));
    tui.addChild(this.transcript);
    tui.addChild(this.editor);
    tui.addChild(this.footer);
    tui.setFocus(this.editor);

    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
        this.quit(0);
        return { consume: true };
      }
      return undefined;
    });
    this.offClose = client.onClose((err) => {
      this.say(style.danger(`Lost the connection to the daemon${err ? `: ${err.message}` : ""}.`));
      this.exit(1);
    });
    client.on("session/entry", (n) => {
      if (!this.session) this.early.push(n);
      else if (n.sessionId === this.session.id) this.show(n.entry);
    });
  }

  /** Opens the session. Until it succeeds, submitting does nothing. */
  async open(mode: SessionMode): Promise<void> {
    try {
      const id = await this.chooseSession(mode);
      const { session, entries } = await this.client.request("session/attach", { id });
      this.session = session;
      const early = this.early.filter((n) => n.sessionId === session.id).map((n) => n.entry);
      this.early = [];
      for (const e of [...entries, ...early].sort((a, b) => a.seq - b.seq)) this.show(e);
      this.editor.disableSubmit = false;
      this.renderHeader();
    } catch (e) {
      this.say(style.danger(this.explainOpenError(e, mode)));
      this.say(style.muted("Run `strive` for a new session, or `strive sessions` to see others."));
    }
  }

  private async chooseSession(mode: SessionMode): Promise<string> {
    if (typeof mode === "object") return mode.resume;
    if (mode === "continue") {
      const { sessions } = await this.client.request("session/list", { cwd: this.cwd });
      if (sessions[0]) return sessions[0].id;
    }
    return (await this.client.request("session/create", { cwd: this.cwd })).id;
  }

  private explainOpenError(e: unknown, mode: SessionMode): string {
    const id = typeof mode === "object" ? mode.resume : "this session";
    if (e instanceof ServerError && e.code === -32010) return `No session ${id}.`;
    if (e instanceof ServerError && e.code === -32011) {
      return `This session's journal failed verification: ${(e.data as { problem: string }).problem}.`;
    }
    if (e instanceof ServerError && e.code === -32602) return `${id} is not a session id.`;
    return `Could not open the session: ${(e as Error).message}`;
  }

  private renderHeader() {
    const id = this.session ? `  ${style.muted(`session ${shortId(this.session.id)}`)}` : "";
    this.header.setText(`${style.bold(style.accent("strive"))} ${style.muted(this.init.server.version)}  ${tilde(this.cwd)}${id}`);
    this.tui.requestRender();
  }

  private show(entry: Entry) {
    if (entry.seq <= this.lastSeq) return;
    this.lastSeq = entry.seq;
    this.spend.apply(entry.event);
    this.footer.setText(style.muted(this.spend.summary()));
    this.say(describe(entry));
  }

  quit(code: number) {
    this.offClose();
    this.client.close();
    this.exit(code);
  }

  say(text: string) {
    this.transcript.addChild(new Text(text, 1, 0));
    this.tui.requestRender();
  }

  async submit(text: string) {
    if (!text || !this.session) return;
    this.editor.setText("");
    if (!text.startsWith("/")) {
      try {
        await this.client.request("session/prompt", { id: this.session.id, text });
      } catch (e) {
        this.editor.setText(text);
        const why = e instanceof ServerError ? e.detail : (e as Error).message;
        this.say(style.danger(`Couldn't confirm your message was saved: ${why}`));
        return;
      }
      if (!this.notedMissingAgent) {
        this.notedMissingAgent = true;
        this.say(style.muted("Saved to this session. No agent is connected yet; the agent host is the next milestone."));
      }
      return;
    }
    const [cmd] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case "status": {
        const s = await this.client.request("daemon/status", {});
        this.say(
          `${style.muted("daemon")} pid ${s.server.pid} · up ${Math.round(s.uptimeMs / 1000)}s · ${s.clients} client${s.clients === 1 ? "" : "s"}`,
        );
        return;
      }
      case "budget": {
        const arg = text.slice(1).split(/\s+/)[1];
        const dollars = arg === "off" ? undefined : Number(arg);
        if (arg !== "off" && !(Number.isFinite(dollars) && (dollars as number) >= 0)) {
          this.say(style.danger("Use /budget <dollars>, for example /budget 10, or /budget off."));
          return;
        }
        const usdMicros = dollars === undefined ? undefined : Math.round(dollars * 1_000_000);
        await this.client.request("session/budget", { id: this.session.id, usdMicros, tokens: this.spend.tokenLimit });
        return;
      }
      case "session":
        this.say(`${style.muted("session")} ${this.session.id} · resume with ${style.accent(`strive -r ${this.session.id}`)}`);
        return;
      case "help":
        this.say(COMMANDS.map((c) => `${style.accent(`/${c.name}`)}  ${style.muted(c.description ?? "")}`).join("\n"));
        this.say(style.muted("Enter sends · Alt+Enter new line · Tab completes · Ctrl+C exits"));
        return;
      case "quit":
      case "exit":
        this.quit(0);
        return;
      default:
        this.say(style.danger(`Unknown command /${cmd}. Type /help.`));
    }
  }
}
