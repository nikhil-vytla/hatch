import type { Terminal } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";

export class VirtualTerminal implements Terminal {
  private readonly term: xterm.Terminal;
  private onInput?: (data: string) => void;
  private pending = Promise.resolve();

  constructor(
    readonly columns = 80,
    readonly rows = 24,
  ) {
    this.term = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
  }

  get kittyProtocolActive() {
    return false;
  }

  start(onInput: (data: string) => void) {
    this.onInput = onInput;
  }
  stop() {
    this.onInput = undefined;
  }
  async drainInput() {}
  write(data: string) {
    this.pending = this.pending.then(() => new Promise<void>((r) => this.term.write(data, r)));
  }
  moveBy(lines: number) {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    else if (lines < 0) this.write(`\x1b[${-lines}A`);
  }
  hideCursor() {
    this.write("\x1b[?25l");
  }
  showCursor() {
    this.write("\x1b[?25h");
  }
  clearLine() {
    this.write("\x1b[K");
  }
  clearFromCursor() {
    this.write("\x1b[J");
  }
  clearScreen() {
    this.write("\x1b[2J\x1b[H");
  }
  setTitle() {}
  setProgress() {}

  type(data: string) {
    if (!this.onInput) throw new Error("terminal not started");
    this.onInput(data);
  }

  async screen(): Promise<string[]> {
    await this.pending;
    const buf = this.term.buffer.active;
    const lines: string[] = [];

    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");

    while (lines.length && lines[lines.length - 1] === "") lines.pop();

    return lines;
  }

  async waitFor(text: string, timeoutMs = 2000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const s = await this.screen();

      if (s.some((l) => l.includes(text))) return s;

      if (Date.now() > deadline) throw new Error(`screen never showed ${JSON.stringify(text)}:\n${s.join("\n")}`);
      await Bun.sleep(10);
    }
  }
}
