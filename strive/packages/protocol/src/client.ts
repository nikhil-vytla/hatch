// JSON-RPC 2.0 client for strived: newline-delimited JSON over a Unix socket.
// Requests are typed by the generated `Methods` map, so a method name, its
// params and its result can't disagree with the Rust daemon.
import { createConnection, type Socket } from "node:net";
import type { ClientInfo } from "./generated/ClientInfo";
import type { InitializeResult } from "./generated/InitializeResult";
import { type MethodName, type Methods, PROTOCOL_VERSION } from "./generated/Methods";
import type { RpcError } from "./generated/RpcError";

export class ServerError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, e: RpcError) {
    super(`${method}: ${e.message} (${e.code})`);
    this.name = "ServerError";
    this.code = e.code;
    this.data = e.data;
  }
}

export type Notification = { method: string; params: unknown };

type Pending = { method: string; resolve: (v: any) => void; reject: (e: Error) => void };

export class StriveClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(n: Notification) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.shutdown(err));
    socket.on("close", () => this.shutdown());
  }

  /** Connects and performs the `initialize` handshake. */
  static async connect(path: string, client: ClientInfo): Promise<{ client: StriveClient; init: InitializeResult }> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(path);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    const c = new StriveClient(socket);
    const init = await c.request("initialize", { protocolVersion: PROTOCOL_VERSION, client });
    return { client: c, init };
  }

  request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  onNotification(fn: (n: Notification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: (err?: Error) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  close(): void {
    this.socket.end();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) this.onMessage(line);
    }
  }

  private onMessage(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.shutdown(new Error("daemon sent invalid JSON"));
    }
    if (typeof msg.method === "string" && msg.id === undefined) {
      for (const fn of this.listeners) fn({ method: msg.method, params: msg.params });
      return;
    }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new ServerError(p.method, msg.error));
    else p.resolve(msg.result);
  }

  private shutdown(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err ?? new Error(`${p.method}: connection closed`));
    this.pending.clear();
    for (const fn of this.closeListeners) fn(err);
  }
}
