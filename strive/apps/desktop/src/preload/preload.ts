// The renderer's only door to the app: a few named calls, no Node, no raw
// IPC. Everything goes through the main process, which checks the sender.
import type { History } from "@strive/workspace";
import { contextBridge, ipcRenderer } from "electron";
import type { Bridge, StriveEvent } from "../shared/bridge";

const bridge: Bridge = {
  opened: () => ipcRenderer.invoke("strive:opened"),
  request: (method, params) => ipcRenderer.invoke("strive:request", method, params),
  blob: (digest) => ipcRenderer.invoke("strive:blob", digest),
  onEvent: (listener) => {
    ipcRenderer.on("strive:event", (_, event: StriveEvent) => listener(event));
  },
  onClosed: (listener) => {
    ipcRenderer.on("strive:closed", listener);
  },
  loadWorkspace: (): Promise<History | undefined> => ipcRenderer.invoke("workspace:load"),
  saveWorkspace: (history) => ipcRenderer.invoke("workspace:save", JSON.stringify(history)),
};

contextBridge.exposeInMainWorld("strive", bridge);
