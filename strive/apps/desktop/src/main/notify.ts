// What's worth telling a person who isn't looking at the window: the agent
// needs them, or it has stopped. Everything else waits for them to look.
import type { Entry, Event } from "@strive/protocol";

export type Notice = { title: string; body: string };

export function noticeFor(event: Event, session: string): Notice | undefined {
  switch (event.type) {
    case "approvalRequested":
      return { title: "strive needs your approval", body: `${session}: allow it to ${event.description}?` };
    case "turnEnded":
      switch (event.reason.kind) {
        case "done":
          return { title: "strive finished", body: session };
        case "failed":
          return { title: "strive stopped", body: `${session}: ${event.reason.error}` };
        case "timedOut":
          return { title: "strive ran out of time", body: `${session}: stopped at the ${event.reason.seconds}s limit` };
        case "interrupted":
          return undefined; // a person did that
        default:
          return event.reason satisfies never;
      }

    default:
      return undefined;
  }
}

/**
 * A learning run that ended with proposals: worth a look. `ended` is a
 * `turnEnded` in the learning session; `entries` are those seen up to it.
 */
export function learnedNotice(entries: Entry[], ended: Entry, project: string): Notice | undefined {
  if (ended.event.type !== "turnEnded" || ended.event.reason.kind !== "done") return undefined;

  const before = entries.filter((e) => e.seq < ended.seq);
  const asked = before.findLast((e) => e.event.type === "learnRequested")?.seq ?? 0;
  const made = before.filter((e) => e.seq > asked && e.event.type === "proposalMade").length;

  if (made === 0) return undefined;

  return {
    title: "strive learned something",
    body: `${project}: ${made} ${made === 1 ? "proposal" : "proposals"} to review`,
  };
}
