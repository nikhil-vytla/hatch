import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export type FakeReply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

/** Handles one request. `notify` writes a notification to this connection before the reply. */
export type FakeHandler = (params: any, notify: (method: string, params: unknown) => void) => FakeReply;

/**
 * A scripted daemon on a real Unix socket, for tests that need exact message
 * orderings or failures the real daemon won't produce on demand. It speaks
 * the same wire protocol; `initialize` is answered for you.
 */
export class FakeDaemon {
  readonly socket: string;
  private readonly dir = mkdtempSync("/tmp/strv-fake-");
  private readonly server: Server;
  readonly calls: { method: string; params: any }[] = [];

  constructor(private readonly handlers: Record<string, FakeHandler>) {
    this.socket = join(this.dir, "fake.sock");
    this.server = createServer((conn) => this.serve(conn));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socket, resolve));
  }

  private serve(conn: Socket) {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        this.calls.push({ method: msg.method, params: msg.params });
        const out: string[] = [];
        const notify = (method: string, params: unknown) =>
          out.push(JSON.stringify({ jsonrpc: "2.0", method, params }));
        const reply: FakeReply =
          msg.method === "initialize"
            ? {
                result: {
                  protocolVersion: 1,
                  server: { version: "fake", build: "fake", pid: 1, startedAtMs: 0 },
                  home: this.dir,
                },
              }
            : (this.handlers[msg.method]?.(msg.params, notify) ?? {
                error: { code: -32601, message: "unknown method" },
              });
        out.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }));
        conn.write(`${out.join("\n")}\n`);
      }
    });
  }

  close() {
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
