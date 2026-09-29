import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  type MethodName,
  type Methods,
  type NotificationName,
  type Notifications,
  PROTOCOL_VERSION,
  type RpcError,
} from "@strive/protocol";

export type FakeReply<M extends MethodName> = { result: Methods[M]["result"] } | { error: RpcError };

export type Notify = <N extends NotificationName>(method: N, params: Notifications[N]) => void;

/** Handles one request. `notify` writes a notification to this connection before the reply. */
export type FakeHandler<M extends MethodName> = (params: Methods[M]["params"], notify: Notify) => FakeReply<M>;

/** Scripted replies by method; typed by the protocol, so a fixture can't drift from the daemon. */
export type FakeHandlers = { [M in MethodName]?: FakeHandler<M> };

/**
 * A scripted daemon on a real Unix socket, for tests that need exact message
 * orderings or failures the real daemon won't produce on demand. It speaks
 * the same wire protocol; `initialize` is answered for you.
 */
export class FakeDaemon {
  readonly socket: string;
  private readonly dir = mkdtempSync("/tmp/strv-fake-");
  private readonly server: Server;
  readonly calls: { method: string; params: unknown }[] = [];
  private readonly conns = new Set<Socket>();

  constructor(private readonly handlers: FakeHandlers) {
    this.socket = join(this.dir, "fake.sock");
    this.server = createServer((conn) => this.serve(conn));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socket, resolve));
  }

  /** Sends a notification to every connection, when no request prompts it (an interrupt, say). */
  push<N extends NotificationName>(method: N, params: Notifications[N]) {
    for (const conn of this.conns) conn.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private serve(conn: Socket) {
    this.conns.add(conn);
    conn.on("close", () => this.conns.delete(conn));
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

        const notify: Notify = (method, params) => out.push(JSON.stringify({ jsonrpc: "2.0", method, params }));

        // SAFETY: the handler is looked up by the request's own method, and the client under
        // test sends that method's params (its `request` is typed by the same `Methods` map).
        const handler = this.handlers[msg.method as MethodName] as FakeHandler<MethodName> | undefined;

        const reply =
          msg.method === "initialize"
            ? {
                result: {
                  protocolVersion: PROTOCOL_VERSION,
                  server: { version: "fake", build: "fake", pid: 1, startedAtMs: 0 },
                  home: this.dir,
                },
              }
            : (handler?.(msg.params, notify) ?? {
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
