import type { Entry } from "@strive/protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Bridge, Opened, StriveEvent } from "../shared/bridge";
import { App } from "./App";
import { Offers, offerDaemon } from "./offers";
import "./styles.css";

declare global {
  interface Window {
    strive: Bridge;
  }
}

const root = document.getElementById("root");

// Events are queued from the start, before the session is asked for, so
// none that arrive while the app mounts is lost. A switch to another
// session queues them again until the new one's app is listening.
const queued: StriveEvent[] = [];

let listener: ((event: StriveEvent) => void) | undefined;

window.strive.onEvent((event) => (listener ? listener(event) : queued.push(event)));

// The learning session's entries go to the app shown now. One that arrives
// mid-switch is missed; the next app reads the journal whole when it mounts.
let learningListener: ((entry: Entry) => void) | undefined;

window.strive.onLearning((entry) => learningListener?.(entry));

const events: Bridge = {
  ...window.strive,
  onEvent: (l) => {
    listener = l;

    for (const event of queued.splice(0)) l(event);
  },
  onLearning: (l) => {
    learningListener = l;
  },
};

function Shell({ first }: { first: Opened }) {
  const [opened, setOpened] = useState(first);
  // Every session of the window is in one project, so one set of offers serves them all.
  const [offers] = useState(() => new Offers(offerDaemon(events, first.session.cwd)));

  const switchTo = async (id?: string) => {
    const before = listener;
    const left = opened.session.id;
    listener = undefined;

    try {
      setOpened(await window.strive.switchTo(id));
    } catch (e) {
      // Still on the same session: its app goes on getting events, those held meanwhile first.
      if (before) events.onEvent(before);
      throw e;
    }

    // Left behind, a session with signs is offered for learning.
    offers.consider(left).catch(() => undefined);
  };

  return <App key={opened.session.id} bridge={events} opened={opened} onSwitch={switchTo} offers={offers} />;
}

if (root) window.strive.opened().then((opened) => createRoot(root).render(<Shell first={opened} />));
