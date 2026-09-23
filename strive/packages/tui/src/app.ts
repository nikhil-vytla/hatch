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
import { editorTheme, style } from "./theme";

export const COMMANDS: SlashCommand[] = [
  { name: "status", description: "Show the daemon's status" },
  { name: "session", description: "Show this session's id and how to resume it" },
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
  }
}

export class App {
  readonly transcript = new Container();
  readonly editor: Editor;
  private readonly header = new Text("", 1, 0);
  private readonly offClose: () => void;
  private session?: SessionInfo;
  private lastSeq = 0;
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
    this.editor.onSubmit = (text) => void this.submit(text.trim());
    this.editor.disableSubmit = true;
    this.renderHeader();

    tui.addChild(this.header);
    tui.addChild(new Spacer(1));
    tui.addChild(this.transcript);
    tui.addChild(this.editor);
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
    client.on("session/entry", ({ sessionId, entry }) => {
      if (sessionId === this.session?.id) this.show(entry);
    });
  }

  /** Opens the session. Until it succeeds, submitting does nothing. */
  async open(mode: SessionMode): Promise<void> {
    try {
      const id = await this.chooseSession(mode);
      const { session, entries } = await this.client.request("session/attach", { id });
      this.session = session;
      for (const e of entries) this.show(e);
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
      await this.client.request("session/prompt", { id: this.session.id, text });
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
