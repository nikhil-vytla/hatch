import { createRoot } from "react-dom/client";
import type { Bridge, StriveEvent } from "../shared/bridge";
import { App } from "./App";
import "./styles.css";

declare global {
  interface Window {
    strive: Bridge;
  }
}

const root = document.getElementById("root");

// Events are queued from the start, before the session is asked for, so
// none that arrive while the app mounts is lost.
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

if (root) window.strive.opened().then((opened) => createRoot(root).render(<App bridge={events} opened={opened} />));
