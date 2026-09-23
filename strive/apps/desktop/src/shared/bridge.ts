// What the preload script exposes to the renderer as `window.strive`.
import type { Entry, InitializeResult, MethodName, Methods, Notifications, SessionInfo } from "@strive/protocol";
import type { History } from "@strive/workspace";

export type Opened = { init: InitializeResult; session: SessionInfo; entries: Entry[]; home: string };

export type StriveEvent = {
  [N in keyof Notifications]: { method: N; params: Notifications[N] };
}[keyof Notifications];

export type Bridge = {
  opened(): Promise<Opened>;
  request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  /** Listens for the window's lifetime (a function returned across the bridge isn't callable). */
  onEvent(listener: (event: StriveEvent) => void): void;
  onClosed(listener: () => void): void;
  loadWorkspace(): Promise<History | undefined>;
  saveWorkspace(history: History): Promise<void>;
};
