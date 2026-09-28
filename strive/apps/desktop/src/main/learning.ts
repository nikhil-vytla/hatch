// The window's project's learning session, followed on a connection of its
// own: switching sessions leaves it alone. It observes, so it's never a
// person the learner waits on; decisions go through the session's connection.
import { type Entry, type SessionReadResult, StriveClient } from "@strive/protocol";

export class Learning {
  private client?: Promise<StriveClient>;
  private following?: Promise<string | undefined>;
  /** The learning session's entries this connection has seen, by seq. */
  private readonly seen = new Map<number, Entry>();
  private closed = false;

  constructor(
    private readonly socket: string,
    private readonly version: string,
    private readonly cwd: string,
    /** Each entry journaled after the follow began, in order, with every entry seen so far. */
    private readonly onEntry: (entry: Entry, seen: Entry[]) => void,
  ) {}

  private connect(): Promise<StriveClient> {
    this.client ??= StriveClient.connect(this.socket, { name: "strive-desktop", version: this.version }).then(
      ({ client }) => client,
    );

    return this.client;
  }

  /**
   * The project's learning session, followed from now on; none if the
   * project has none yet. Finding one never creates it: only a run does.
   */
  follow(): Promise<string | undefined> {
    this.following ??= this.start().then((id) => {
      // Asked again later, it looks again: a run may have made one by then.
      if (id === undefined) this.following = undefined;

      return id;
    });

    return this.following;
  }

  private async start(): Promise<string | undefined> {
    const client = await this.connect();
    const { sessions } = await client.request("session/list", { cwd: this.cwd, kind: "learning" });
    // The oldest is the project's, as the daemon picks it.
    const id = sessions.at(-1)?.id;

    if (id === undefined || this.closed) return undefined;

    let snapshot = true;
    const held: Entry[] = [];

    client.on("session/entry", ({ sessionId, entry }) => {
      if (sessionId !== id) return;

      if (snapshot) held.push(entry);
      else this.add(entry, true);
    });

    const { entries } = await client.request("session/attach", { id, observer: true });

    for (const e of entries) this.add(e, false);
    snapshot = false;

    for (const e of held) this.add(e, true);

    return id;
  }

  private add(entry: Entry, live: boolean) {
    if (this.seen.has(entry.seq)) return;
    this.seen.set(entry.seq, entry);

    if (live)
      this.onEntry(
        entry,
        [...this.seen.values()].sort((a, b) => a.seq - b.seq),
      );
  }

  /** The learning session's journal, if the project has one. */
  async read(): Promise<SessionReadResult | null> {
    const id = await this.follow();

    return id === undefined ? null : (await this.connect()).request("session/read", { id });
  }

  close() {
    this.closed = true;
    void this.client?.then(
      (c) => c.close(),
      () => undefined,
    );
  }
}
