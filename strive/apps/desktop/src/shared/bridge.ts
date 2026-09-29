// What the preload script exposes to the renderer as `window.strive`.
import type {
  Digest,
  Entry,
  InitializeResult,
  MethodName,
  Methods,
  Notifications,
  SessionInfo,
  SessionReadResult,
} from "@strive/protocol";
import type { History } from "@strive/workspace";
import type { Cited } from "./cited";

export type Opened = {
  init: InitializeResult;
  session: SessionInfo;
  entries: Entry[];
  home: string;
  /** `darwin` draws the traffic lights over the window's own titlebar. */
  platform: string;
  /**
   * How long a session stays idle after its turn ends before it's offered
   * for learning, when not the usual minute (`STRIVE_DESKTOP_OFFER_IDLE_MS`,
   * for tests).
   */
  offerIdleMs?: number;
};

export type StriveEvent = {
  [N in keyof Notifications]: { method: N; params: Notifications[N] };
}[keyof Notifications];

export type Bridge = {
  opened(): Promise<Opened>;
  request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  /** This project's sessions, newest first. */
  sessions(): Promise<SessionInfo[]>;
  /** Shows another of this project's sessions, or a new one; what it shows. */
  switchTo(id?: string): Promise<Opened>;
  /** A tool's input or output from the content store, as text: only ones this session's journal names. */
  blob(digest: Digest): Promise<string>;
  /**
   * The project's learning session's journal, or null if the project has
   * none yet. From then on its new entries come to `onLearning`.
   */
  learning(): Promise<SessionReadResult | null>;
  /** The file one of this project's proposals replaces, as the learner read it; null if there was none. */
  proposalBefore(proposal: number): Promise<string | null>;
  /**
   * The entries of one of this project's sessions that evidence cites, with
   * the other half of each cited effect and its output.
   */
  cited(session: string, seqs: number[]): Promise<Cited>;
  /** Listens for the window's lifetime (a function returned across the bridge isn't callable). */
  onEvent(listener: (event: StriveEvent) => void): void;
  /** Entries journaled in the project's learning session, once `learning` has found it. */
  onLearning(listener: (entry: Entry) => void): void;
  onClosed(listener: () => void): void;
  /** The person asked to close the window: the page may offer to learn first, then calls `close`. */
  onClosing(listener: () => void): void;
  /** Closes the window. */
  close(): Promise<void>;
  loadWorkspace(): Promise<History | undefined>;
  saveWorkspace(history: History): Promise<void>;
};
