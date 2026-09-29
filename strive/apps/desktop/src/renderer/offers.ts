// The offer to learn from a session with signs (ADR-0020): made once the
// session has gone idle (its turn ended and nothing new came for a while),
// or when the window switches away from it or closes. At most twice a
// session for the window's life: once, and once more if new signs came
// after the person dismissed it. Held above the app, which remounts on every
// switch, so an offer outlives the session it names being shown.
import type { LearningSignalsResult } from "@strive/protocol";
import type { Bridge } from "../shared/bridge";

export type Offer = { session: string; result: LearningSignalsResult };

/** What an offer asks the daemon, about sessions of the window's project. */
export type OfferDaemon = {
  signals(session: string): Promise<LearningSignalsResult>;
  run(session: string): Promise<void>;
  dismiss(session: string, through: number): Promise<void>;
};

/** The daemon through the window's bridge, which holds each request to the window's project. */
export function offerDaemon(bridge: Pick<Bridge, "request">, cwd: string): OfferDaemon {
  return {
    signals: (session) => bridge.request("learning/signals", { cwd, session }),
    run: async (session) => {
      await bridge.request("learning/run", { cwd, sessions: [session], offer: true });
    },
    dismiss: async (session, through) => {
      await bridge.request("learning/dismiss", { cwd, session, through });
    },
  };
}

/** How long a session stays idle after its turn ends before it's offered. */
export const IDLE_MS = 60_000;

/** The most offers for one session in a window's life: the first, and one more for signs after a dismissal. */
const MOST = 2;

/** Starts a timer and returns what cancels it: a test passes its own, to run the product's idle timer without waiting. */
export type Clock = (run: () => void, ms: number) => () => void;

const realClock: Clock = (run, ms) => {
  const timer = setTimeout(run, ms);

  return () => clearTimeout(timer);
};

export class Offers {
  /** How many times each session has been offered. */
  private readonly made = new Map<string, number>();
  /** Sessions the daemon is being asked about. */
  private readonly asking = new Set<string>();
  private shown?: Offer;
  private listener?: () => void;
  /** The idle timer running, and for which session. */
  private waiting?: { session: string; cancel: () => void };
  /** Called once the offer on show is answered, then forgotten. */
  private answered?: () => void;

  constructor(
    private readonly daemon: OfferDaemon,
    private readonly idleMs = IDLE_MS,
    private readonly clock: Clock = realClock,
  ) {}

  /** The offer on show, if any: one at a time. */
  get current(): Offer | undefined {
    return this.shown;
  }

  /** Called when the offer on show changes; the app shown now listens. */
  onChange(listener: () => void) {
    this.listener = listener;
  }

  /** `session`'s turn ended: it's considered once it has stayed idle for a while. */
  idle(session: string) {
    this.busy();

    const cancel = this.clock(() => {
      this.waiting = undefined;
      this.consider(session).catch(() => undefined);
    }, this.idleMs);

    this.waiting = { session, cancel };
  }

  /** A prompt or a turn started: the session isn't idle, so the wait starts again when its turn ends. */
  busy() {
    this.waiting?.cancel();
    this.waiting = undefined;
  }

  /** Asks the daemon about `session`'s signs, and offers a run for them if it says to. */
  async consider(session: string): Promise<void> {
    if (this.waiting?.session === session) this.busy();

    if (this.shown || (this.made.get(session) ?? 0) >= MOST || this.asking.has(session)) return;

    this.asking.add(session);

    try {
      // The daemon reports only signs nothing has dealt with: after a dismissal, only newer ones.
      const result = await this.daemon.signals(session);

      if (!result.ask || this.shown) return;

      this.made.set(session, (this.made.get(session) ?? 0) + 1);
      this.shown = { session, result };
      this.listener?.();
    } finally {
      this.asking.delete(session);
    }
  }

  /**
   * The window is closing on `session`: offers it now if it should be. True
   * if an offer is on show, and `then` runs once it's answered.
   */
  async beforeClose(session: string, then: () => void): Promise<boolean> {
    await this.consider(session);

    if (!this.shown) return false;

    this.answered = then;

    return true;
  }

  /** Asks the learner to study the offered session. */
  async learn(): Promise<void> {
    const offer = this.take();

    try {
      if (offer) await this.daemon.run(offer.session);
    } finally {
      this.finish();
    }
  }

  /** Declines: the daemon doesn't offer these signs again, and no automatic run acts on them. */
  async dismiss(): Promise<void> {
    const offer = this.take();

    try {
      if (offer) await this.daemon.dismiss(offer.session, Math.max(...offer.result.signals.map((s) => s.seq)));
    } finally {
      this.finish();
    }
  }

  private take(): Offer | undefined {
    const offer = this.shown;
    this.shown = undefined;
    this.listener?.();

    return offer;
  }

  private finish() {
    const then = this.answered;
    this.answered = undefined;
    then?.();
  }
}
