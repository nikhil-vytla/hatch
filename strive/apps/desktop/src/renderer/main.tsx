import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Bridge, Opened, StriveEvent } from "../shared/bridge";
import { App } from "./App";
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

const events: Bridge = {
  ...window.strive,
  onEvent: (l) => {
    listener = l;

    for (const event of queued.splice(0)) l(event);
  },
};

function Shell({ first }: { first: Opened }) {
  const [opened, setOpened] = useState(first);

  const switchTo = async (id?: string) => {
    const before = listener;
    listener = undefined;

    try {
      setOpened(await window.strive.switchTo(id));
    } catch (e) {
      // Still on the same session: its app goes on getting events, those held meanwhile first.
      if (before) events.onEvent(before);
      throw e;
    }
  };

  return <App key={opened.session.id} bridge={events} opened={opened} onSwitch={switchTo} />;
}

if (root) window.strive.opened().then((opened) => createRoot(root).render(<Shell first={opened} />));
