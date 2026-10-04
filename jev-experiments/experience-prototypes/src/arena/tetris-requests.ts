/**
 * The Jev request behind each lane's latest decision on the arena's Tetris board, for "Build this".
 * The board asks once per piece (or per tick in real time), so a lane shows its latest request:
 *
 * - Your key: the exact body `framedJev` hands to the site's gateway call.
 * - Recorded lanes: the replays keep answers, not requests, so the request is rebuilt from the
 *   board with the recorder's own `buildRequest`. Designs that remember judgements can't be
 *   rebuilt from the board; their replay chunks carry the recorded request instead.
 *
 * tetris-requests.test.ts checks every rebuilt request against the recordings' request logs.
 */
import type { Contestant, Question, TimedEvent } from "../../../packages/arena/src/tetris";
import {
  buildRequest,
  type Exchange,
  type FramingId,
  type Send,
  type Wire,
} from "../../../packages/arena/src/tetris-framings";

export type LaneRequest = {
  request: Wire;
  response?: unknown;
  /** Rebuilt from the board, rather than the request as sent or recorded. */
  rebuilt: boolean;
};

/** Where a lane's latest request is kept as it plays. */
export type RequestNote = { latest: LaneRequest | null };

const REMEMBERS = new Set<FramingId>(["spot-clean-cached", "spot-clean-confident"]);

const sameBoard = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

/** Wraps a recorded player so each decision it answers notes the request behind it. */
function noting(
  player: Contestant,
  requestFor: (q: Question) => LaneRequest | null,
  note: RequestNote,
): Contestant {
  return {
    ...player,
    ask(q, mode, signal) {
      const reply = player.ask(q, mode, signal);
      const asked = "missing" in reply ? null : requestFor(q);

      if (asked) note.latest = asked;

      return reply;
    },
  };
}

/** A turn recording: the same lookup `recordedFraming` uses, with the request rebuilt from the board. */
export function notingTurns(
  player: Contestant,
  exchanges: Exchange[],
  framing: FramingId,
  note: RequestNote,
): Contestant {
  return noting(
    player,
    (q) => {
      const x = exchanges.find(
        (e) =>
          e.framing === framing && e.pieceId === q.pieceId && sameBoard(e.board, q.state.board),
      );

      return x
        ? { request: buildRequest(framing, q).body, response: x.response, rebuilt: true }
        : null;
    },
    note,
  );
}

/** A real-time recording: the same lookup `timedReplay` uses; a remembering design's request is recorded. */
export function notingTimed(
  player: Contestant,
  events: (TimedEvent & { body?: Wire })[],
  framing: FramingId | undefined,
  note: RequestNote,
): Contestant {
  return noting(
    player,
    (q) => {
      const e = events.find(
        (x) =>
          x.sentAt === q.sentAt && x.pieceId === q.pieceId && sameBoard(x.board, q.state.board),
      );

      if (!e || !framing) return null;

      if (e.body) return { request: e.body, rebuilt: false };

      // A remembering design with no request answered from memory and sent nothing.
      return REMEMBERS.has(framing)
        ? null
        : { request: buildRequest(framing, q).body, rebuilt: true };
    },
    note,
  );
}

/** Your key: notes each body as it is sent, then its response. */
export function notingSend(send: Send, note: RequestNote): Send {
  return (body, signal) => {
    note.latest = { request: body, rebuilt: false };

    return send(body, signal).then((response) => {
      if (note.latest?.request === body) note.latest = { request: body, response, rebuilt: false };

      return response;
    });
  };
}
