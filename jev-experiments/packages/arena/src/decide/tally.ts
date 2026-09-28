/**
 * Visitor votes on Decide: how everyone who answered split. A vote is one option of one
 * decision in the deck; anything else is refused. Each visitor counts once per decision per
 * day (an unguessable hash of their address, the decision and the day, never the address), and
 * a visitor casting too many votes in an hour is turned away. Counts are all that is kept.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DECK } from "./deck.js";

/** The few commands a tally needs, so a dev server can keep counts in memory. */
export type Store = {
  /** Sets `key` if it is new, expiring after `seconds`; true when it was new. */
  claim(key: string, seconds: number): Promise<boolean>;
  /** Adds one to `key`, expiring after `seconds`; the new count. */
  bump(key: string, seconds: number): Promise<number>;
  addVote(decision: string, option: string): Promise<void>;
  counts(decision: string): Promise<Record<string, number>>;
};

export const VOTES_PER_HOUR = 120;

export class TallyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

/** A vote as the API receives it; `vote` checks both ids against the deck. */
export const voteSchema = z.object({ id: z.string(), option: z.string() });

export type Vote = z.infer<typeof voteSchema>;

const decisionOf = (id: string) => {
  const d = DECK.find((x) => x.id === id);

  if (!d) throw new TallyError("Unknown decision.", 400);

  return d;
};

/** Counts for one decision, every option present (zero if nobody chose it). */
export async function countsFor(store: Store, id: string) {
  const d = decisionOf(id);
  const raw = await store.counts(d.id);

  return Object.fromEntries(d.options.map((o) => [o.id, Number(raw[o.id] ?? 0)]));
}

export async function vote(
  store: Store,
  ballot: Vote,
  visitor: string,
  salt: string,
  now = new Date(),
) {
  const d = decisionOf(ballot.id);

  if (!d.options.some((o) => o.id === ballot.option)) throw new TallyError("Unknown option.", 400);

  const who = hash(salt, visitor);
  const hour = now.toISOString().slice(0, 13);

  if ((await store.bump(`decide:rate:${who}:${hour}`, 3600)) > VOTES_PER_HOUR)
    throw new TallyError("Too many votes from here this hour.", 429);

  const day = now.toISOString().slice(0, 10);
  const fresh = await store.claim(`decide:voted:${hash(salt, visitor, d.id, day)}`, 86_400);

  if (fresh) await store.addVote(d.id, ballot.option);

  return { counted: fresh, counts: await countsFor(store, d.id) };
}

/** Upstash Redis over its REST API (what Vercel's Upstash integration provides). */
export function upstash(url: string, token: string): Store {
  const run = async (...command: (string | number)[]) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
    });

    if (!r.ok) throw new TallyError("The tally is unavailable.", 503);
    const json: { result?: unknown } = await r.json();

    return json.result;
  };

  return {
    claim: async (key, seconds) => (await run("SET", key, "1", "NX", "EX", seconds)) === "OK",
    bump: async (key, seconds) => {
      const n = Number(await run("INCR", key));

      if (n === 1) await run("EXPIRE", key, seconds);

      return n;
    },
    addVote: async (decision, option) => {
      await run("HINCRBY", `decide:tally:${decision}`, option, 1);
    },
    counts: async (decision) => {
      const flat = await run("HGETALL", `decide:tally:${decision}`);
      const list = Array.isArray(flat) ? flat.map(String) : [];

      return Object.fromEntries(list.flatMap((v, i) => (i % 2 ? [] : [[v, Number(list[i + 1])]])));
    },
  };
}

/** Counts in memory, for the dev server and tests. */
export function memoryStore(): Store {
  const keys = new Map<string, number>();
  const tallies = new Map<string, Record<string, number>>();

  return {
    claim: async (key) => {
      if (keys.has(key)) return false;
      keys.set(key, 1);

      return true;
    },
    bump: async (key) => {
      const n = (keys.get(key) ?? 0) + 1;

      keys.set(key, n);

      return n;
    },
    addVote: async (decision, option) => {
      const t = tallies.get(decision) ?? {};

      t[option] = (t[option] ?? 0) + 1;
      tallies.set(decision, t);
    },
    counts: async (decision) => ({ ...tallies.get(decision) }),
  };
}
