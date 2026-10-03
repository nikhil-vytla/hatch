// One connection to the daemon, attached to one session: what the window
// shows and may act on. Switching sessions opens a new connection and
// closes this one, so the session left behind no longer counts the window
// as a person who can answer its approvals.
import { type Digest, type Entry, type Event, StriveClient } from "@strive/protocol";
import { ancestry } from "@strive/view";
import type { Opened, StriveEvent } from "../shared/bridge";

export class Connection {
  readonly client: StriveClient;
  readonly id: string;
  /** What the page gets when it asks for the session, kept up to date. */
  readonly snapshot: Opened;
  /**
   * The blobs the window may read: ones this session's journal names. The
   * content store holds every session's, found by digest alone.
   */
  readonly readable = new Set<Digest>();
  private forward?: (event: StriveEvent) => void;
  /** Called for each entry journaled after the attach. */
  onEntry?: (entry: Entry) => void;
  private readonly early: StriveEvent[] = [];
  private closing = false;

  private constructor(client: StriveClient, id: string, snapshot: Opened) {
    this.client = client;
    this.id = id;
    this.snapshot = snapshot;
  }

  /** Connects and attaches to `id`, listening first so nothing journaled meanwhile is missed. */
  static async open(socket: string, version: string, home: string, pick: (c: StriveClient) => Promise<string>) {
    const { client, init } = await StriveClient.connect(socket, { name: "strive-desktop", version });
    const id = await pick(client);
    let conn: Connection | undefined;
    const held: StriveEvent[] = [];
    const deliver = (event: StriveEvent) => (conn ? conn.deliver(event) : held.push(event));
    client.on("session/entry", (params) => deliver({ method: "session/entry", params }));
    client.on("session/delta", (params) => deliver({ method: "session/delta", params }));
    client.on("session/interrupt", (params) => deliver({ method: "session/interrupt", params }));

    const { session, entries } = await client.request("session/attach", { id });
    const read = async (sid: string) => (await client.request("session/read", { id: sid })).entries;
    const earlier = await ancestry(entries, read);

    conn = new Connection(client, id, { init, session, entries, earlier, home, platform: process.platform });

    for (const entry of [...earlier.flatMap((part) => part.entries), ...entries]) conn.note(entry.event);

    // Entries notified while the attach was on its way belong to the snapshot too.
    for (const event of held) conn.deliver(event);

    return conn;
  }

  private note(event: Event) {
    for (const d of digestsOf(event)) this.readable.add(d);
  }

  private deliver(event: StriveEvent) {
    if (event.method === "session/entry" && event.params.sessionId === this.id) {
      this.note(event.params.entry.event);

      // A page that reloads asks for the session again; it gets all of it.
      if (event.params.entry.seq > (this.snapshot.entries.at(-1)?.seq ?? 0)) {
        this.snapshot.entries.push(event.params.entry);
        this.onEntry?.(event.params.entry);
      }
    }

    if (this.forward) this.forward(event);
    else this.early.push(event);
  }

  /** Sends events to the page from now on, those held until now first. */
  attachPage(send: (event: StriveEvent) => void) {
    this.forward = send;

    for (const event of this.early.splice(0)) send(event);
  }

  /** Calls `closed` if the daemon goes away, not when this connection is closed on purpose. */
  onLost(closed: () => void) {
    this.client.onClose(() => {
      if (!this.closing) closed();
    });
  }

  close() {
    this.closing = true;
    this.client.close();
  }
}

/** The content-store blobs an event names that the window shows: tool inputs and outputs. */
function digestsOf(event: Event): Digest[] {
  switch (event.type) {
    case "effectStarted": {
      const r = event.record;

      return r.kind === "write"
        ? [r.content]
        : r.kind === "edit"
          ? [r.oldText, r.newText]
          : r.kind === "mcp"
            ? [r.arguments]
            : [];
    }

    case "effectFinished":
      return event.outcome.kind === "done" ? [event.outcome.output] : [];
    default:
      return [];
  }
}
