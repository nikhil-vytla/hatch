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
import {
  type ApprovalMode,
  type Decision,
  describeError,
  type Entry,
  type InitializeResult,
  ServerError,
  type SessionInfo,
  type StriveClient,
} from "@strive/protocol";
import {
  describe as describeLines,
  formatUsd,
  type Line,
  MODE_NAMES,
  offerText,
  Spend,
  sessionAllowance,
} from "@strive/view";
import { editorTheme, style } from "./theme";

export { formatUsd, MODE_NAMES };

export const COMMANDS: SlashCommand[] = [
  { name: "status", description: "Show the daemon's status" },
  { name: "session", description: "Show this session's id and how to resume it" },
  {
    name: "budget",
    description: "Set this session's spending limit: /budget 10, or /budget off",
    argumentHint: "<dollars>|off",
  },
  {
    name: "approvals",
    description: "What the agent may do without asking: ask, auto-edit or full-auto",
    argumentHint: "<mode>",
  },
  {
    name: "rewind",
    description: "List checkpoints, or put the files back to one: /rewind 2",
    argumentHint: "[checkpoint]",
  },
  { name: "help", description: "List commands and keys" },
  { name: "quit", description: "Exit strive (the daemon keeps running)" },
];

const MODES_BY_NAME = new Map<string, ApprovalMode>([
  ["ask", "ask"],
  ["auto-edit", "autoEdit"],
  ["full-auto", "fullAuto"],
]);

const DECISION_KEYS = new Map<string, Decision>([
  ["y", "allow"],
  ["a", "allowSession"],
  ["n", "deny"],
]);

/** The daemon's reason a journal failed verification (error -32011 carries `{ problem }`). */
function hasProblem(data: unknown): data is { problem: string } {
  return typeof data === "object" && data !== null && "problem" in data && typeof data.problem === "string";
}

/** Which session to open: `new`, `continue` (latest in this directory), or an id. */
export type SessionMode = "new" | "continue" | { resume: string };

export function parseSessionMode(raw: string | undefined): SessionMode {
  if (!raw || raw === "new") return "new";

  if (raw === "continue") return "continue";

  return { resume: raw };
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

const shortId = (id: string) => `…${id.slice(-6)}`;

/**
 * Text as the terminal shows it, never as commands to it: control
 * characters (but newline and tab) are written in caret notation, so a
 * reply can't clear the screen or move the cursor to forge what's shown.
 */
export function printable(text: string): string {
  let out = "";

  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    const control = (code < 0x20 && c !== "\n" && c !== "\t") || (code >= 0x7f && code <= 0x9f);

    if (!control) out += c;
    else if (code < 0x20) out += `^${String.fromCharCode(code + 64)}`;
    else out += code === 0x7f ? "^?" : "\ufffd";
  }

  return out;
}

/** An entry's transcript lines, styled for the terminal. */
export function describe(entry: Entry): string {
  return describeLines(entry, { home: homedir() })
    .map((line) => ({ ...line, text: printable(line.text) }))
    .map((line) => (line.kind === "prompt" ? `${style.accent("›")} ${line.text}` : tone(line)))
    .join("\n");
}

function tone(line: Line): string {
  switch (line.tone) {
    case "plain":
      return line.text;
    case "accent":
      return style.accent(line.text);
    case "muted":
      return style.muted(line.text);
    case "faint":
      return style.faint(line.text);
    case "danger":
      return style.danger(line.text);
    default:
      return line.tone satisfies never;
  }
}

export class App {
  readonly transcript = new Container();
  readonly editor: Editor;
  private readonly header = new Text("", 1, 0);
  private readonly footer = new Text("", 1, 0);
  /** The approval line shown while an effect waits for a decision. */
  private readonly prompt = new Text("", 1, 0);
  /** Effects waiting for a decision, oldest first, and whether "a" allows one file (not everything). */
  private readonly pending = new Map<number, { description: string; allowance: string }>();
  /** The project's slash commands, beside the built-in ones. */
  private projectCommands: SlashCommand[] = [];
  /** Checkpoints and what each was taken before. */
  private readonly checkpoints = new Map<number, string>();
  private awaitingPrompt?: number;
  private readonly spend = new Spend();
  private readonly offClose: () => void;
  private session?: SessionInfo;
  private lastSeq = 0;
  /** Entries that arrived before the attach reply; shown after its history. */
  private early: { sessionId: string; entry: Entry }[] = [];
  /** The turn the agent is working on, if any. */
  private working?: number;
  /** The reply streaming in, until its final message arrives. */
  private readonly live = new Text("", 1, 0);
  /** The offer to learn from the session, asked once as the TUI quits. */
  private readonly offerLine = new Text("", 1, 0);
  /** Whether quitting has asked the daemon about the session's signs yet. */
  private offered = false;
  /** While the offer waits for an answer: the seq of the last sign it named. */
  private offer?: { session: SessionInfo; through: number };
  /** Set once the TUI has let go of the daemon, so it exits once. */
  private closed = false;

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
      this.submit(text.trim()).catch((e) => this.say(style.danger(describeError(e))));
    };

    this.editor.disableSubmit = true;
    this.renderHeader();

    tui.addChild(this.header);
    tui.addChild(new Spacer(1));
    tui.addChild(this.transcript);
    tui.addChild(this.live);
    tui.addChild(this.prompt);
    tui.addChild(this.offerLine);
    tui.addChild(this.editor);
    tui.addChild(this.footer);
    tui.setFocus(this.editor);

    tui.addInputListener((data) => {
      // Any key answers the offer; only y takes it.
      if (this.offer) {
        const { session, through } = this.offer;
        this.offer = undefined;
        void this.answer(session, through, data === "y" || data === "Y");

        return { consume: true };
      }

      if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
        this.quit(0);

        return { consume: true };
      }

      if (matchesKey(data, "escape") && this.working !== undefined && this.pending.size === 0 && this.session) {
        this.client.request("session/interrupt", { id: this.session.id }).catch(() => {});

        return { consume: true };
      }

      const decision = DECISION_KEYS.get(data);
      const oldest = this.pending.keys().next();

      if (decision && !oldest.done && this.session) {
        this.client
          .request("approval/respond", { id: this.session.id, effect: oldest.value, decision })
          .catch((e) => this.say(style.danger(describeError(e))));

        return { consume: true };
      }

      return undefined;
    });
    this.offClose = client.onClose((err) => {
      this.say(style.danger(`Lost the connection to the daemon${err ? `: ${err.message}` : ""}.`));
      this.exit(1);
    });
    client.on("session/delta", ({ sessionId, turn, text }) => {
      if (sessionId !== this.session?.id || turn !== this.working) return;
      this.live.setText(printable(text.trim()));
      this.tui.requestRender();
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
      // A hint, so a failure to list is no reason to say anything.
      this.sayWaiting(session.cwd).catch(() => undefined);
      this.loadCommands(session.id).catch(() => undefined);
    } catch (e) {
      this.say(style.danger(this.explainOpenError(e, mode)));
      this.say(style.muted("Run `strive` for a new session, or `strive sessions` to see others."));
    }
  }

  /**
   * The project's slash commands (ADR-0024), offered beside the built-in
   * ones, which win a name both have: the daemon expands one sent as a prompt.
   */
  private async loadCommands(id: string) {
    const { commands } = await this.client.request("session/commands", { id });
    const builtIn = new Set(COMMANDS.map((c) => c.name));
    this.projectCommands = commands
      .filter((c) => !builtIn.has(c.name))
      .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([...COMMANDS, ...this.projectCommands], this.cwd),
    );
  }

  /** Says how many of the project's proposals wait for a person's review, if any do. */
  private async sayWaiting(cwd: string) {
    const { proposals } = await this.client.request("proposal/list", { cwd });
    const ready = proposals.filter((p) => p.status === "ready").length;

    if (ready === 0 || this.closed) return;
    const waiting = ready === 1 ? "1 proposal is waiting" : `${ready} proposals are waiting`;
    this.say(style.accent(`${waiting}: \`strive review\``));
  }

  private async chooseSession(mode: SessionMode): Promise<string> {
    if (mode !== "new" && mode !== "continue") return mode.resume;

    if (mode === "continue") {
      const { sessions } = await this.client.request("session/list", { cwd: this.cwd });

      if (sessions[0]) return sessions[0].id;
    }

    return (await this.client.request("session/create", { cwd: this.cwd })).id;
  }

  private explainOpenError(cause: unknown, mode: SessionMode): string {
    const id = mode !== "new" && mode !== "continue" ? mode.resume : "this session";

    if (!(cause instanceof ServerError)) return `Could not open the session: ${describeError(cause)}`;

    if (cause.code === -32010) return `No session ${id}.`;

    if (cause.code === -32011 && hasProblem(cause.data)) {
      return `This session's journal failed verification: ${cause.data.problem}.`;
    }

    if (cause.code === -32602) return `${id} is not a session id.`;

    return `Could not open the session: ${cause.detail}`;
  }

  private renderFooter() {
    const working = this.working === undefined ? "" : ` · ${style.accent("working… Esc to interrupt")}`;
    this.footer.setText(`${style.muted(this.spend.summary())}${working}`);
  }

  private renderHeader() {
    const id = this.session ? `  ${style.muted(`session ${shortId(this.session.id)}`)}` : "";
    this.header.setText(
      `${style.bold(style.accent("strive"))} ${style.muted(this.init.server.version)}  ${tilde(this.cwd)}${id}`,
    );
    this.tui.requestRender();
  }

  private show(entry: Entry) {
    if (entry.seq <= this.lastSeq) return;
    this.lastSeq = entry.seq;
    this.spend.apply(entry.event);
    const e = entry.event;

    if (e.type === "approvalRequested")
      this.pending.set(e.effect, { description: e.description, allowance: sessionAllowance(e.sessionFile) });

    if (e.type === "checkpointed") {
      this.checkpoints.set(e.checkpoint, "");
      this.awaitingPrompt = e.checkpoint;
    }

    if (e.type === "userMessage" && this.awaitingPrompt !== undefined) {
      this.checkpoints.set(this.awaitingPrompt, `before “${e.text}”`);
      this.awaitingPrompt = undefined;
    }

    if (e.type === "rewound") this.checkpoints.set(e.savedAs, `before rewinding to ${e.to}`);

    if (e.type === "turnStarted") this.working = e.turn;

    if (e.type === "turnEnded") this.working = undefined;

    if (e.type === "assistantMessage" || e.type === "turnEnded") this.live.setText("");

    if (e.type === "approvalDecided") this.pending.delete(e.effect);
    const next = this.pending.values().next();
    this.prompt.setText(
      next.done
        ? ""
        : `${style.accent(`Allow the agent to ${printable(next.value.description)}?`)}  ${style.muted(
            `y yes · a yes to ${next.value.allowance} · n no`,
          )}`,
    );
    this.renderFooter();
    const text = describe(entry);

    if (text) this.say(text);
    // Entries that add no line (a finished turn) still change the footer.
    this.tui.requestRender();
  }

  /**
   * Exits, first offering once to learn from the session if it has signs
   * nothing has dealt with. Quitting again while the daemon is asked exits
   * at once.
   */
  quit(code: number) {
    const session = this.session;

    if (code !== 0 || !session || this.offered) {
      this.leave(code);

      return;
    }

    this.offered = true;
    this.offerLearning(session).then(
      (asked) => asked || this.leave(code),
      () => this.leave(code),
    );
  }

  /** Shows the offer if the daemon says to make one; whether it did. */
  private async offerLearning(session: SessionInfo): Promise<boolean> {
    const r = await this.client.request("learning/signals", { cwd: session.cwd, session: session.id });

    if (!r.ask || this.closed) return false;

    this.offer = { session, through: Math.max(...r.signals.map((s) => s.seq)) };
    this.editor.disableSubmit = true;
    this.offerLine.setText(`${style.accent(printable(offerText("This session", r)))} ${style.muted("[y/N]")}`);
    this.tui.requestRender();

    return true;
  }

  private async answer(session: SessionInfo, through: number, yes: boolean) {
    try {
      if (yes) {
        await this.client.request("learning/run", { cwd: session.cwd, sessions: [session.id], offer: true });
        this.offerLine.setText(
          style.muted("Asked the learner to study this session; `strive review` will show what it proposes."),
        );
      } else {
        await this.client.request("learning/dismiss", { cwd: session.cwd, session: session.id, through });
        this.offerLine.setText("");
      }
    } catch (e) {
      this.offerLine.setText(style.danger(describeError(e)));
    }

    // Drawn now, not on the next frame: leaving stops the screen, and a line
    // only requested would never reach it.
    this.tui.renderNow();
    this.leave(0);
  }

  private leave(code: number) {
    if (this.closed) return;
    this.closed = true;
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
        this.say(style.danger(`Couldn't confirm your message was saved: ${describeError(e)}`));
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

        if (dollars !== undefined && !(Number.isFinite(dollars) && dollars >= 0)) {
          this.say(style.danger("Use /budget <dollars>, for example /budget 10, or /budget off."));

          return;
        }

        const usdMicros = dollars === undefined ? undefined : Math.round(dollars * 1_000_000);
        await this.client.request("session/budget", { id: this.session.id, usdMicros, tokens: this.spend.tokenLimit });

        return;
      }

      case "approvals": {
        const arg = text.slice(1).split(/\s+/)[1] ?? "";
        const mode = MODES_BY_NAME.get(arg);

        if (!mode) {
          this.say(style.danger("Use /approvals ask, /approvals auto-edit or /approvals full-auto."));

          return;
        }

        await this.client.request("session/approvals", { id: this.session.id, mode });

        return;
      }

      case "rewind": {
        const arg = text.slice(1).split(/\s+/)[1];

        if (!arg) {
          if (this.checkpoints.size === 0) {
            this.say(style.muted("No checkpoints yet: one is taken before each prompt."));

            return;
          }

          this.say([...this.checkpoints].map(([n, what]) => `${n}  ${what}`).join("\n"));
          this.say(style.muted("Put the files back with /rewind <number>."));

          return;
        }

        const checkpoint = Number(arg);

        try {
          const { notSaved } = await this.client.request("session/rewind", { id: this.session.id, checkpoint });

          if (notSaved.length > 0) {
            this.say(
              style.muted(`Left as they were (checkpoints don't hold nested repositories): ${notSaved.join(", ")}`),
            );
          }
        } catch (e) {
          this.say(
            style.danger(
              e instanceof ServerError && e.code === -32602
                ? `No checkpoint ${arg} in this session.`
                : describeError(e),
            ),
          );
        }

        return;
      }

      case "session":
        this.say(
          `${style.muted("session")} ${this.session.id} · resume with ${style.accent(`strive -r ${this.session.id}`)}`,
        );

        return;
      case "help":
        this.say(COMMANDS.map((c) => `${style.accent(`/${c.name}`)}  ${style.muted(c.description ?? "")}`).join("\n"));

        if (this.projectCommands.length > 0) {
          this.say(style.muted("This project's commands:"));
          this.say(
            this.projectCommands
              .map((c) => `${style.accent(`/${c.name}`)}  ${style.muted(c.description ?? "")}`)
              .join("\n"),
          );
        }

        this.say(style.muted("Enter sends · Alt+Enter new line · Tab completes · Ctrl+C exits"));

        return;
      case "quit":
      case "exit":
        this.quit(0);

        return;
      default:
        if (this.projectCommands.some((c) => c.name === cmd)) {
          await this.client.request("session/prompt", { id: this.session.id, text });

          return;
        }

        this.say(style.danger(`Unknown command /${cmd}. Type /help.`));
    }
  }
}
