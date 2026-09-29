// The offer to learn from a session with signs (ADR-0020): made when the
// session's turn ends or the window switches away from it, at most once a
// session for the window's life. Held above the app, which remounts on
// every switch, so an offer outlives the session it names being shown.
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
      await bridge.request("learning/run", { cwd, sessions: [session] });
    },
    dismiss: async (session, through) => {
      await bridge.request("learning/dismiss", { cwd, session, through });
    },
  };
}

export class Offers {
  /** Sessions offered, never offered again. */
  private readonly made = new Set<string>();
  /** Sessions the daemon is being asked about. */
  private readonly asking = new Set<string>();
  private shown?: Offer;
  private listener?: () => void;

  constructor(private readonly daemon: OfferDaemon) {}

  /** The offer on show, if any: one at a time. */
  get current(): Offer | undefined {
    return this.shown;
  }

  /** Called when the offer on show changes; the app shown now listens. */
  onChange(listener: () => void) {
    this.listener = listener;
  }

  /** Asks the daemon about `session`'s signs, and offers a run for them if it says to. */
  async consider(session: string): Promise<void> {
    if (this.shown || this.made.has(session) || this.asking.has(session)) return;

    this.asking.add(session);

    try {
      const result = await this.daemon.signals(session);

      if (!result.ask || this.shown) return;

      this.made.add(session);
      this.shown = { session, result };
      this.listener?.();
    } finally {
      this.asking.delete(session);
    }
  }

  /** Asks the learner to study the offered session. */
  async learn(): Promise<void> {
    const offer = this.take();

    if (offer) await this.daemon.run(offer.session);
  }

  /** Declines: the daemon doesn't offer these signs again, and no automatic run acts on them. */
  async dismiss(): Promise<void> {
    const offer = this.take();

    if (offer) await this.daemon.dismiss(offer.session, Math.max(...offer.result.signals.map((s) => s.seq)));
  }

  private take(): Offer | undefined {
    const offer = this.shown;
    this.shown = undefined;
    this.listener?.();

    return offer;
  }
}
