// A fork (ADR-0030) goes on from its parents' conversations: every client
// that shows or rebuilds a fork follows them back the same way.
import type { Entry } from "@strive/protocol";

/** The most forks of forks a conversation is followed back through. */
const FORK_DEPTH = 16;

/**
 * The conversations a fork goes on from (ADR-0030), oldest first, each up
 * to the entry the next forked from it. None past a summary: one covers
 * everything before it, the parent's conversation included.
 */
export async function ancestry(
  entries: Entry[],
  read: (id: string) => Promise<Entry[]>,
): Promise<{ session: string; entries: Entry[] }[]> {
  const chain: { session: string; entries: Entry[] }[] = [];
  let current = entries;

  for (let depth = 0; depth < FORK_DEPTH; depth++) {
    if (current.some((e) => e.event.type === "compacted")) break;
    const from = current.map((e) => e.event).find((e) => e.type === "forkedFrom");

    if (from?.type !== "forkedFrom") break;
    const { session, seq } = from;
    const parent = (await read(session)).filter((e) => e.seq <= seq);

    chain.unshift({ session, entries: parent });
    current = parent;
  }

  return chain;
}
