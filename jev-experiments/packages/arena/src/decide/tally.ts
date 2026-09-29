/**
 * Visitor votes on Decide: how everyone who answered split. A vote is one option of one
 * decision in the deck; anything else is refused. Each visitor counts once per decision per
 * day: the tally keeps an unguessable hash of their address and the day, never the address,
 * and forgets earlier days' hashes. Counts are all that is kept beyond that.
 *
 * Storage is one small document per decision, read and then written back only if nobody else
 * wrote in between (a conditional write); a conflict is retried. So a store needs no counters,
 * which lets Vercel Blob hold it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DECK } from "./deck.js";

export const tallyDocSchema = z.object({
  counts: z.record(z.string(), z.number()),
  /** Visitor hash → the day (YYYY-MM-DD) they voted. Only today's are kept. */
  voters: z.record(z.string(), z.string()),
});

export type TallyDoc = z.infer<typeof tallyDocSchema>;

/** A document store with conditional writes. `version` is null when the document is new. */
export type Store = {
  read(decision: string): Promise<{ doc: TallyDoc; version: string | null }>;
  /** Writes only if the document is still at `version`; false when someone wrote first. */
  write(decision: string, doc: TallyDoc, version: string | null): Promise<boolean>;
};

export const EMPTY: TallyDoc = { counts: {}, voters: {} };

/** A vote as the API receives it; `vote` checks both ids against the deck. */
export const voteSchema = z.object({ id: z.string(), option: z.string() });

export type Vote = z.infer<typeof voteSchema>;

export class TallyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * One visitor, for counting. An IPv6 connection usually owns a whole /64 of addresses, so an
 * IPv6 visitor is their /64; otherwise one person could vote once per address.
 */
export function visitorOf(ip: string) {
  const v = ip.trim().toLowerCase();

  if (!v.includes(":")) return v;

  // An IPv4 address written as IPv6 (::ffff:203.0.113.9) is still one IPv4 visitor.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);

  if (mapped) return mapped[1];

  const [head, tail = ""] = v.split("::");
  const left = head ? head.split(":") : [];
  const right = v.includes("::") && tail ? tail.split(":") : [];

  const groups = v.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;

  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** Past this many visitors in a day, a decision stops counting new votes until tomorrow. */
export const MAX_VOTERS_PER_DAY = 20_000;

const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);

const decisionOf = (id: string) => {
  const d = DECK.find((x) => x.id === id);

  if (!d) throw new TallyError("Unknown decision.", 400);

  return d;
};

const countsOf = (id: string, doc: TallyDoc) =>
  Object.fromEntries(decisionOf(id).options.map((o) => [o.id, doc.counts[o.id] ?? 0]));

/** Counts for one decision, every option present (zero if nobody chose it). */
export async function countsFor(store: Store, id: string) {
  decisionOf(id);

  return countsOf(id, (await store.read(id)).doc);
}

/** Counts for every decision, for the results page. */
export async function allCounts(store: Store) {
  const pairs = await Promise.all(
    DECK.map(async (d) => [d.id, await countsFor(store, d.id)] as const),
  );

  return Object.fromEntries(pairs);
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

  const day = now.toISOString().slice(0, 10);
  const who = hash(salt, visitorOf(visitor), d.id, day);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { doc, version } = await store.read(d.id);

    if (doc.voters[who] === day) return { counted: false, counts: countsOf(d.id, doc) };

    const voters = Object.fromEntries(Object.entries(doc.voters).filter(([, v]) => v === day));

    if (Object.keys(voters).length >= MAX_VOTERS_PER_DAY)
      return { counted: false, counts: countsOf(d.id, doc) };

    const next: TallyDoc = {
      counts: { ...doc.counts, [ballot.option]: (doc.counts[ballot.option] ?? 0) + 1 },
      voters: { ...voters, [who]: day },
    };

    if (await store.write(d.id, next, version))
      return { counted: true, counts: countsOf(d.id, next) };
  }

  throw new TallyError("The tally is busy; try again.", 503);
}

/** Documents in memory, for the dev server and tests. */
export function memoryStore(): Store {
  const docs = new Map<string, { doc: TallyDoc; version: number }>();

  return {
    read: async (decision) => {
      const hit = docs.get(decision);

      return hit ? { doc: hit.doc, version: String(hit.version) } : { doc: EMPTY, version: null };
    },
    write: async (decision, doc, version) => {
      const hit = docs.get(decision);

      if ((hit ? String(hit.version) : null) !== version) return false;
      docs.set(decision, { doc, version: (hit?.version ?? 0) + 1 });

      return true;
    },
  };
}
