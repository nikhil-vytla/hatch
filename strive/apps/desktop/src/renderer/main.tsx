import { createRoot } from "react-dom/client";
import type { Bridge } from "../shared/bridge";
import { App } from "./App";
import "./styles.css";

declare global {
  interface Window {
    strive: Bridge;
  }
}

const root = document.getElementById("root");

if (root) {
  window.strive.opened().then((opened) => createRoot(root).render(<App bridge={window.strive} opened={opened} />));
}
