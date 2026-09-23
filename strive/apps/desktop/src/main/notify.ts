// What's worth telling a person who isn't looking at the window: the agent
// needs them, or it has stopped. Everything else waits for them to look.
import type { Event } from "@strive/protocol";

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
