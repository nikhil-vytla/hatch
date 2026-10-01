/**
 * The judgment queue. The world hands it things to judge (a line in earshot, gossip, a notice);
 * it asks a model and applies answers whenever they arrive. One job runs at a time, newest lines
 * before old gossip, and stale gossip is dropped rather than letting the queue grow.
 *
 * Three backends answer the same questions:
 * - student: the small model trained for this game (live-worlds/free-model); the line is embedded
 *   once in the browser and every listener is answered from it;
 * - local: a zero-shot classifier in the browser, one request at a time, applied as each lands;
 * - jev: everything in a job merged into one batched call (on the visitor's own key).
 */
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import { eventText } from "../free-model/features";
import { judgeGossip, judgeLine, judgeReaction } from "../free-model/runtime";
import {
  answerLocally,
  gossipRequest,
  lineRequest,
  merge,
  reactionRequest,
  split,
  toGossipDecision,
  toHearDecision,
  type Answer,
  type Event,
} from "./decide";
import { applyGossip, applyHear, goal, markBusy, type Meeting, type Resident, type World } from "./engine";

export type JevReply = { answers: Record<string, Answer>; latency_ms?: number; usage?: { input_tokens?: number } | null };

export type Backend =
  | { kind: "student"; name: string; embed: (text: string) => Promise<ArrayLike<number>> }
  | { kind: "local"; name: string; classify: ZeroShot }
  | { kind: "jev"; name: string; ask: (state: unknown, questions: Record<string, unknown>) => Promise<JevReply> };

type Job = { kind: "hear"; event: Event; listeners: Resident[] } | { kind: "gossip"; meetings: Meeting[] };

// TypeSafe's list price: $0.042 per million input tokens, output free.
export const USD_PER_TOKEN = 0.042 / 1e6;

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

export class Brain {
  private jobs: Job[] = [];
  private running = false;
  /** Spent on the visitor's key, at list price. */
  costUsd = 0;
  calls = 0;
  lastError = "";

  constructor(
    private world: () => World,
    public backend: Backend,
    private onChange: () => void = () => {},
  ) {}

  get pending() {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  hear(event: Event, listeners: Resident[]) {
    if (!listeners.length) return;

    markBusy(listeners);
    this.jobs.unshift({ kind: "hear", event, listeners });
    void this.pump();
  }

  gossip(meetings: Meeting[]) {
    if (!meetings.length) return;

    markBusy(meetings.map((m) => m.listener));
    this.jobs.push({ kind: "gossip", meetings });

    // Old gossip is dropped, never left to pile up: the listeners just didn't catch it.
    while (this.jobs.filter((j) => j.kind === "gossip").length > 4) {
      const i = this.jobs.findIndex((j) => j.kind === "gossip");
      const [old] = this.jobs.splice(i, 1);

      if (old.kind === "gossip") for (const m of old.meetings) m.listener.busy = false;
    }

    void this.pump();
  }

  private async pump() {
    if (this.running) return;

    this.running = true;

    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        try {
          if (job.kind === "hear") await this.runHear(job.event, job.listeners);
          else await this.runGossip(job.meetings);

          this.lastError = "";
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : String(e);

          for (const r of job.kind === "hear" ? job.listeners : job.meetings.map((m) => m.listener)) r.busy = false;
        }

        this.onChange();
      }
    } finally {
      this.running = false;
    }
  }

  private async runHear(event: Event, listeners: Resident[]) {
    const w = this.world();
    const g = goal(w.goal ?? "gig");
    const b = this.backend;

    if (b.kind === "student") {
      const started = now();
      const emb = await b.embed(eventText(event));
      const line = judgeLine(emb, event);

      for (const [i, r] of listeners.entries()) {
        const t = now();
        const reaction = judgeReaction(emb, event, line, r, g);
        // The embedding is computed once; its time is charged to the first listener.
        const ms = Math.round(now() - t + (i === 0 ? t - started : 0));

        applyHear(this.world(), r, toHearDecision(line, reaction, event, b.name, ms, this.world().t));
      }

      return;
    }

    if (b.kind === "local") {
      let started = now();
      const line = await answerLocally(b.classify, lineRequest(event));
      const lineMs = now() - started;

      for (const [i, r] of listeners.entries()) {
        started = now();

        const reaction = await answerLocally(b.classify, reactionRequest(r, event, g));
        // The line is judged once; its time is shared among the listeners it served.
        const ms = Math.round(now() - started + (i === 0 ? lineMs : 0));

        applyHear(this.world(), r, toHearDecision(line, reaction, event, b.name, ms, this.world().t));
        this.onChange();
      }

      return;
    }

    const started = now();
    const req = merge([{ key: "line", req: lineRequest(event) }, ...listeners.map((r) => ({ key: r.id, req: reactionRequest(r, event, g) }))]);
    const reply = await b.ask(req.state, req.questions);
    const ms = Math.round(reply.latency_ms ?? now() - started);
    const line = split(reply.answers, "line");

    this.account(reply);

    for (const r of listeners)
      applyHear(this.world(), r, toHearDecision(line, split(reply.answers, r.id), event, b.name, Math.round(ms / listeners.length), this.world().t));
  }

  private async runGossip(meetings: Meeting[]) {
    const b = this.backend;

    if (b.kind === "student") {
      for (const m of meetings) {
        const started = now();

        applyGossip(this.world(), m, toGossipDecision(judgeGossip(m), m.rumour.says, b.name, Math.round(now() - started), this.world().t));
      }

      return;
    }

    if (b.kind === "local") {
      for (const m of meetings) {
        const started = now();
        const a = await answerLocally(b.classify, gossipRequest(m));

        applyGossip(this.world(), m, toGossipDecision(a, m.rumour.says, b.name, Math.round(now() - started), this.world().t));
        this.onChange();
      }

      return;
    }

    const started = now();
    const req = merge(meetings.map((m, i) => ({ key: `g${i}`, req: gossipRequest(m) })));
    const reply = await b.ask(req.state, req.questions);
    const ms = Math.round(reply.latency_ms ?? now() - started);

    this.account(reply);

    for (const [i, m] of meetings.entries())
      applyGossip(this.world(), m, toGossipDecision(split(reply.answers, `g${i}`), m.rumour.says, b.name, Math.round(ms / meetings.length), this.world().t));
  }

  private account(reply: JevReply) {
    this.calls++;
    this.costUsd += (reply.usage?.input_tokens ?? 0) * USD_PER_TOKEN;
  }
}
