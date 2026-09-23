// The strive TUI: a thin client over the daemon. It renders and forwards
// intent; sessions, budgets and effects live in strived.
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
import type { InitializeResult, StriveClient } from "@strive/protocol";
import { editorTheme, style } from "./theme";

export const COMMANDS: SlashCommand[] = [
  { name: "status", description: "Show the daemon's status" },
  { name: "help", description: "List commands and keys" },
  { name: "quit", description: "Exit strive (the daemon keeps running)" },
];

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

export class App {
  readonly transcript = new Container();
  readonly editor: Editor;
  private readonly offClose: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly client: StriveClient,
    init: InitializeResult,
    private readonly exit: (code: number) => void,
    cwd = process.cwd(),
  ) {
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, cwd));
    this.editor.onSubmit = (text) => void this.submit(text.trim());

    tui.addChild(new Text(`${style.bold(style.accent("strive"))} ${style.muted(init.server.version)}  ${tilde(cwd)}`, 1, 0));
    tui.addChild(
      new Text(style.faint("No agent is connected yet; it arrives with the agent host. Type /help for commands."), 1, 0),
    );
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
    if (!text) return;
    this.editor.setText("");
    if (!text.startsWith("/")) {
      this.say(`${style.accent("›")} ${text}`);
      this.say(style.muted("Nothing can run this yet: the agent host is the next milestone."));
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
