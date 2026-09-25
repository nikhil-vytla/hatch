// The renderer's only door to the app: a few named calls, no Node, no raw
// IPC. Everything goes through the main process, which checks the sender.
import type { Entry } from "@strive/protocol";
import type { History } from "@strive/workspace";
import { contextBridge, ipcRenderer } from "electron";
import type { Bridge, StriveEvent } from "../shared/bridge";

const bridge: Bridge = {
  opened: () => ipcRenderer.invoke("strive:opened"),
  request: (method, params) => ipcRenderer.invoke("strive:request", method, params),
  blob: (digest) => ipcRenderer.invoke("strive:blob", digest),
  sessions: () => ipcRenderer.invoke("strive:sessions"),
  switchTo: (id) => ipcRenderer.invoke("strive:switch", id),
  learning: () => ipcRenderer.invoke("strive:learning"),
  proposalBefore: (proposal) => ipcRenderer.invoke("strive:proposal-before", proposal),
  onEvent: (listener) => {
    ipcRenderer.on("strive:event", (_, event: StriveEvent) => listener(event));
  },
  onLearning: (listener) => {
    ipcRenderer.on("strive:learning-entry", (_, entry: Entry) => listener(entry));
  },
  onClosed: (listener) => {
    ipcRenderer.on("strive:closed", listener);
  },
  loadWorkspace: (): Promise<History | undefined> => ipcRenderer.invoke("workspace:load"),
  saveWorkspace: (history) => ipcRenderer.invoke("workspace:save", JSON.stringify(history)),
};

contextBridge.exposeInMainWorld("strive", bridge);
