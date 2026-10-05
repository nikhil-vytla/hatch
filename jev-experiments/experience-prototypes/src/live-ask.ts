/**
 * Asking Jev live, on the visitor's key. A scene hands this module a request and renders the
 * status it returns; everything between the two lives here:
 *
 * - the key gate: no key, no request, and the shared no-key failure (LiveFailure offers "Add key");
 * - supersede and abort: a new ask, `cancel()`, or the scene unmounting aborts the one in flight,
 *   and a superseded answer never reaches the scene, even if the server ignored the abort;
 * - failure classification (live-failure.ts), so every failure reads the same everywhere;
 * - the session meter: every /api/evaluate response, and every Jev call a streamed composition
 *   makes on the server, counts once;
 * - the receipt data for what was just asked.
 *
 * `createLiveAsk` is the plain implementation (tests drive it with a fake fetch); `useLiveAsk`
 * is the React hook over it.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { EvaluationError, getApiKey, NO_KEY_MESSAGE, readResponse, rememberRequest } from "./api";
import { compositionEvents } from "./composition-stream";
import { describeFailure, failureLine, type Failure } from "./live-failure";
import { fromLive, fromLiveBatches, type ReceiptData } from "./receipt";
import { recordCall } from "./session-meter";

export type JevRequest = { state: unknown; questions: Record<string, unknown> };

/** Real-time callers set a short budget so a slow request fails fast instead of retrying for up to 48 s. */
export type Budget = { deadlineMs: number; maxAttempts: number };

/** What a multi-call ask is given: Jev calls tied to this ask's lifetime and meter. */
export type Jev = {
  /** Aborted when this ask is superseded, cancelled or unmounted. */
  signal: AbortSignal;
  /** One /api/evaluate call. Resolves to the response body; rejects with an EvaluationError. */
  evaluate(request: JevRequest, budget?: Budget): Promise<any>;
  /**
   * A streamed composition from /api/compose: yields the composer's events (step, complete).
   * Each Jev call the server makes is metered as it's reported; an error event rejects.
   */
  compose(body: unknown): AsyncGenerator<any>;
};

/** Either one evaluate request, or a function that makes any number of calls through `jev`. */
export type Work<T> = (JevRequest & { budget?: Budget }) | ((jev: Jev) => Promise<T>);

export type LiveStatus<T = unknown> =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "done"; value: T; receipt: ReceiptData | null }
  | { kind: "failed"; failure: Failure };

export type AskOptions = {
  /**
   * "supersede" (default) aborts the ask in flight. "queue" lets it finish and runs only the
   * newest queued ask after it, for real-time scenes that keep one request in flight.
   * "parallel" runs alongside the asks in flight (a scene that keeps a few batches going);
   * `cancel()` and a superseding ask still abort them all.
   */
  whenBusy?: "supersede" | "queue" | "parallel";
  /** Called when this ask fails (not when it's superseded or cancelled), with what was thrown. */
  onFailure?: (failure: Failure, cause: unknown) => void;
};

export type LiveAsk<T = any> = {
  readonly status: LiveStatus<T>;
  /**
   * Asks Jev. Resolves to the answer, or undefined when there's no key, the ask failed (the
   * status says why), or it was superseded or cancelled. Never rejects.
   */
  ask<R extends T = T>(work: Work<R>, options?: AskOptions): Promise<R | undefined>;
  /**
   * For a scene that checks before starting something live (a run, a switch to Jev): true when
   * a key is connected; otherwise the status becomes the no-key failure and nothing is sent.
   */
  hasKey(): boolean;
  /** Aborts the ask in flight and drops any queued one; the status returns to idle unless it was done or failed. */
  cancel(): void;
  /** Cancels and clears the status to idle. */
  reset(): void;
  subscribe(listener: () => void): () => void;
};

export type LiveAskDeps = {
  fetch?: typeof fetch;
  /** The visitor's key; empty when none is connected. */
  key?: () => string;
};

const IDLE = { kind: "idle" } as const;

/** The shared no-key failure, before any request is sent. */
export const noKeyFailure = () => describeFailure(new EvaluationError(NO_KEY_MESSAGE, 401, { error: NO_KEY_MESSAGE }), NO_KEY_MESSAGE);

const aborted = () => new DOMException("Superseded", "AbortError");

/** An EvaluationError whose message reads the same as the failure it classifies as. */
function failed(message: string, status: number, body: unknown) {
  const e = new EvaluationError(message, status, body);
  const f = describeFailure(e, NO_KEY_MESSAGE);

  // Known states read the same everywhere; anything else keeps the server's own words.
  if (f.kind !== "error") e.message = failureLine(f);

  return e;
}

/** One metered /api/evaluate call. */
async function evaluateWith(deps: Required<LiveAskDeps>, request: JevRequest, signal?: AbortSignal, budget?: Budget) {
  const key = deps.key();

  if (!key) throw new EvaluationError(NO_KEY_MESSAGE, 401, { error: NO_KEY_MESSAGE });

  let response: Response;

  try {
    response = await deps.fetch("/api/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(budget ? { "x-jev-deadline-ms": String(budget.deadlineMs), "x-jev-max-attempts": String(budget.maxAttempts) } : {}),
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (e) {
    // A cancelled request stays an AbortError; anything else never reached the server.
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new EvaluationError(failureLine(describeFailure(new TypeError(String(e)))), 0, null);
  }

  // The request reached the server, so it counts on the session meter whatever came back.
  let body;

  try {
    body = await readResponse(response);
  } catch (e) {
    recordCall(false);
    throw new EvaluationError(e instanceof Error ? e.message : String(e), response.status, null);
  }

  recordCall(response.ok, body);
  // An answer that arrives after its ask was superseded never reaches the scene's code.
  signal?.throwIfAborted();

  if (!response.ok) throw failed(body?.error ?? "The run could not complete.", response.status, body);

  rememberRequest(body, request);

  return body;
}

/** A streamed /api/compose call; "call" events go to the meter, an "error" event rejects. */
async function* composeStream(deps: Required<LiveAskDeps>, body: unknown, signal: AbortSignal, bodies: unknown[]) {
  const key = deps.key();

  if (!key) throw new EvaluationError(NO_KEY_MESSAGE, 401, { error: NO_KEY_MESSAGE });

  let response: Response;

  try {
    response = await deps.fetch("/api/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new EvaluationError(failureLine(describeFailure(new TypeError(String(e)))), 0, null);
  }

  if (!response.ok || !response.body) {
    const b = await readResponse(response).catch((e) => {
      throw new EvaluationError(e instanceof Error ? e.message : String(e), response.status, null);
    });

    throw failed(b?.error ?? "The composition could not start.", response.status, b);
  }

  for await (const event of compositionEvents(response.body, signal)) {
    if (event?.type === "call") {
      // One Jev call the server made for this composition, with what the gateway reported.
      recordCall(event.ok === true, event);
      if (event.ok) bodies.push(event);
      continue;
    }

    // The server's closing line; without a gateway status (-1) it reads as its own words.
    if (event?.type === "error")
      throw failed(String(event.error ?? "The composition was interrupted."), typeof event.status === "number" ? event.status : -1, event);

    yield event;
  }
}

const defaults = (deps: LiveAskDeps = {}): Required<LiveAskDeps> => ({
  fetch: deps.fetch ?? ((...args) => fetch(...args)),
  key: deps.key ?? getApiKey,
});

/**
 * One metered /api/evaluate call with no lifecycle of its own, for an engine that schedules and
 * cancels its own requests (the arena's Tetris lanes). It rejects with an EvaluationError whose
 * message is the shared failure line; scenes use `useLiveAsk` instead.
 */
export const evaluateOnce = (request: JevRequest, options: { signal?: AbortSignal; budget?: Budget } = {}, deps?: LiveAskDeps) =>
  evaluateWith(defaults(deps), request, options.signal, options.budget);

export function createLiveAsk<T = any>(deps: LiveAskDeps = {}): LiveAsk<T> {
  const d = defaults(deps);
  let status: LiveStatus<T> = IDLE;
  /** The asks in flight: one, except under "parallel". */
  const running = new Set<AbortController>();
  let queued: { work: Work<any>; options: AskOptions; settle: (v: any) => void } | null = null;
  const listeners = new Set<() => void>();

  const set = (next: LiveStatus<T>) => {
    status = next;
    for (const l of listeners) l();
  };

  const abortAll = () => {
    for (const c of running) c.abort(aborted());
    running.clear();
  };

  const fail = (failure: Failure, options: AskOptions, cause: unknown) => {
    set({ kind: "failed", failure });
    options.onFailure?.(failure, cause);
  };

  async function start<R>(work: Work<R>, options: AskOptions): Promise<R | undefined> {
    if (options.whenBusy !== "parallel") abortAll();

    if (!d.key()) return void fail(noKeyFailure(), options, null);

    const controller = new AbortController();
    const live = () => running.has(controller) && !controller.signal.aborted;
    const bodies: unknown[] = [];

    running.add(controller);
    set({ kind: "asking" });

    const jev: Jev = {
      signal: controller.signal,
      evaluate: async (request, budget) => {
        const body = await evaluateWith(d, request, controller.signal, budget);

        bodies.push(body);

        return body;
      },
      compose: (body) => composeStream(d, body, controller.signal, bodies),
    };

    try {
      const value =
        typeof work === "function" ? await work(jev) : ((await jev.evaluate({ state: work.state, questions: work.questions }, work.budget)) as R);

      if (!live()) return undefined;
      running.delete(controller);
      // Under "parallel", the status stays "asking" while others are in flight.
      if (running.size) set({ kind: "asking" });
      else
        set({
          kind: "done",
          value: value as unknown as T,
          receipt:
            typeof work !== "function"
              ? fromLive(bodies[0], { state: work.state, questions: work.questions })
              : bodies.length === 1
                ? fromLive(bodies[0])
                : bodies.length
                  ? fromLiveBatches(bodies)
                  : null,
        });

      return value;
    } catch (e) {
      if (!live()) return undefined;
      running.delete(controller);
      fail(describeFailure(e, NO_KEY_MESSAGE), options, e);

      return undefined;
    } finally {
      // Nothing an ask started outlives it: a failed batch stops its siblings.
      controller.abort(aborted());
      if (!running.size && queued) {
        const next = queued;

        queued = null;
        void start(next.work, next.options).then(next.settle);
      }
    }
  }

  const live: LiveAsk<T> = {
    get status() {
      return status;
    },
    ask(work, options = {}) {
      if (options.whenBusy === "queue" && running.size) {
        queued?.settle(undefined);

        return new Promise((settle) => {
          queued = { work, options, settle };
        });
      }

      if (options.whenBusy !== "parallel") {
        queued?.settle(undefined);
        queued = null;
      }

      return start(work, options);
    },
    hasKey() {
      if (d.key()) return true;
      abortAll();
      set({ kind: "failed", failure: noKeyFailure() });

      return false;
    },
    cancel() {
      queued?.settle(undefined);
      queued = null;
      abortAll();

      if (status.kind === "asking") set(IDLE);
    },
    reset() {
      live.cancel();
      set(IDLE);
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };

  return live;
}

/**
 * A live ask owned by a component: aborted when the component unmounts (or React hides it),
 * re-rendering on every status change. `busy`, `failure` and `receipt` read from the status.
 */
export function useLiveAsk<T = any>(deps?: LiveAskDeps) {
  const [live] = useState(() => createLiveAsk<T>(deps));
  const status = useSyncExternalStore(
    live.subscribe,
    () => live.status,
    () => IDLE as LiveStatus<T>,
  );

  useEffect(() => () => live.cancel(), [live]);

  return {
    status,
    busy: status.kind === "asking",
    failure: status.kind === "failed" ? status.failure : null,
    receipt: status.kind === "done" ? status.receipt : null,
    ask: live.ask,
    hasKey: live.hasKey,
    cancel: live.cancel,
    reset: live.reset,
    /** The plain object, for code outside React (a game loop's backend) that needs the same lifecycle. */
    live,
  };
}
