/**
 * Does a contestant mean what it says? Two views over recorded decisions: the room (open
 * twenty envelopes a contestant filled at one confidence and count how many agree with the
 * reference) and the dial (hand everything below a confidence to a person and see what is
 * kept, what comes to you and what slips through). Both use every recorded decision; nothing
 * is simulated.
 */
import { useEffect, useMemo, useState } from "react";
import {
  casesSchema,
  predsSchema,
  targetsSchema,
  type Cases,
  type Targets,
} from "../../../packages/arena/src/data/chunks";
import { loadChunk } from "./data";
import { colorVars, type CardModel } from "./model";
import { mulberry32Next, shuffled } from "../../../packages/seeded/src/index";

/** One recorded decision: the contestant's top answer, how sure it was, and the reference's. */
type Decision = { row: number; top: number; conf: number; ref: number; agree: boolean };

const argmax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

const words = (s: string) => s.replaceAll("_", " ");

/** Loads targets, cases and each shown contestant's predictions, reduced to decisions. */
function useDecisions(m: CardModel) {
  const { targets: targetsPath, preds, cases: casesPath } = m.card.chunks;
  const lineup = m.shown.join(",");
  const { wf, qt } = m.view;

  const [data, setData] = useState<{
    targets: Targets;
    cases: Cases | null;
    decisions: Record<string, Decision[]>;
  } | null>(null);

  useEffect(() => {
    if (!targetsPath || !preds) return;
    let alive = true;

    void (async () => {
      const targets = await loadChunk(targetsPath, targetsSchema);
      const cases = casesPath ? await loadChunk(casesPath, casesSchema) : null;
      const decisions: Record<string, Decision[]> = {};

      for (const id of lineup.split(",").filter(Boolean)) {
        const path = preds[id];

        if (!path) continue;
        const p = await loadChunk(path, predsSchema);

        decisions[id] = targets.rows.flatMap((r, row) => {
          if ((wf && r.wf !== wf && r.split !== wf) || (qt && r.type !== qt)) return [];
          const raw = p.p[row];
          const sum = raw.reduce((a, b) => a + b, 0) || 1;
          const dist = raw.map((x) => x / sum);
          const top = argmax(dist);
          const ref = argmax(r.target);

          return [{ row, top, conf: dist[top], ref, agree: top === ref }];
        });
      }

      if (alive) setData({ targets, cases, decisions });
    })();

    return () => {
      alive = false;
    };
  }, [lineup, wf, qt, targetsPath, preds, casesPath]);

  return data;
}

/** A seeded shuffle (mulberry32), so a room is the same until you reroll it. */
function sample<T>(xs: T[], n: number, seed: number) {
  const state = { rng: seed };

  return shuffled(xs, () => mulberry32Next(state)).slice(0, n);
}

const BINS = [0.5, 0.6, 0.7, 0.8, 0.9];

const binLabel = (lo: number) =>
  `${Math.round(lo * 100)}–${lo >= 0.9 ? 100 : Math.round(lo * 100) + 10}%`;

const inBin = (conf: number, lo: number) => conf >= lo && (lo >= 0.9 ? conf <= 1 : conf < lo + 0.1);

/** Contestants whose answers are one-hot state no graded confidence; they have no room. */
const graded = (ds: Decision[]) => ds.some((d) => d.conf < 0.95);

export function Room({ model: m }: { model: CardModel }) {
  const data = useDecisions(m);
  const [lo, setLo] = useState(0.9);
  const [seed, setSeed] = useState(1);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<{ id: string; d: Decision } | null>(null);

  const rooms = useMemo(() => {
    if (!data) return [];

    return m.shown.flatMap((id) => {
      const all = data.decisions[id] ?? [];

      if (!graded(all)) return [];
      const pool = all.filter((d) => inBin(d.conf, lo));

      return [
        {
          id,
          pool,
          total: all.length,
          drawn: sample(pool, 20, seed * 7919 + Math.round(lo * 100)),
        },
      ];
    });
  }, [data, m.shown, lo, seed]);

  if (!data) return <p className="muted">Loading decisions…</p>;

  const reroll = () => {
    setSeed((s) => s + 1);
    setOpened(new Set());
    setFocus(null);
  };

  const openAll = () =>
    setOpened(new Set(rooms.flatMap((r) => r.drawn.map((d) => `${r.id}:${d.row}`))));

  const detail = (id: string, d: Decision) => {
    const r = data.targets.rows[d.row];
    const c = data.cases?.cases[r.c];
    const q = c?.questions.find((x) => x.key === r.key);

    return (
      <div className="cf-detail" aria-live="polite">
        <p className="muted small">
          {m.label(id)} · {words(r.wf)}
        </p>
        <p>
          <b>{q?.instructions ?? words(r.key)}</b>
        </p>
        <p>
          {m.label(id)} said <b>{words(r.keys[d.top])}</b> at {Math.round(d.conf * 100)}%. The
          reference leans <b>{words(r.keys[d.ref])}</b> ({Math.round(r.target[d.ref] * 100)}% of its
          weight). {d.agree ? "They agree." : "They disagree."}
        </p>
        {c && (
          <details>
            <summary>The state it saw</summary>
            <pre>{JSON.stringify(c.state, null, 2)}</pre>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="cf-room">
      <div className="watch-controls" role="group" aria-label="Room controls">
        <label>
          Stated confidence
          <select
            value={lo}
            onChange={(e) => {
              setLo(Number(e.target.value));
              setOpened(new Set());
              setFocus(null);
            }}
          >
            {BINS.map((b) => (
              <option key={b} value={b}>
                {binLabel(b)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary" onClick={openAll}>
          Open every envelope
        </button>
        <button type="button" onClick={reroll}>
          Draw twenty more
        </button>
      </div>

      <div className="cf-rooms">
        {rooms.map(({ id, pool, total, drawn }) => {
          const shown = drawn.filter((d) => opened.has(`${id}:${d.row}`));
          const agreeAll = pool.filter((d) => d.agree).length;

          return (
            <section key={id} className="cf-lane" style={colorVars(m.contestant(id))}>
              <header className="ob-lane-head">
                <span className="swatch" aria-hidden="true" />
                <span className="ob-lane-name">{m.label(id)}</span>
                <span className="cf-count">
                  {shown.length ? `${shown.filter((d) => d.agree).length}/${shown.length}` : ""}
                </span>
              </header>
              {drawn.length === 0 ? (
                <p className="muted small">Never this confident on these questions.</p>
              ) : (
                <div className="cf-envelopes">
                  {drawn.map((d) => {
                    const key = `${id}:${d.row}`;
                    const open = opened.has(key);

                    return (
                      <button
                        key={key}
                        type="button"
                        className="cf-envelope"
                        data-open={open}
                        data-agree={d.agree}
                        aria-label={
                          open
                            ? `${d.agree ? "Agrees" : "Disagrees"} at ${Math.round(d.conf * 100)}%. Show this decision.`
                            : "Sealed envelope. Open it."
                        }
                        onClick={() => {
                          setOpened((o) => new Set(o).add(key));
                          setFocus({ id, d });
                        }}
                      >
                        {open ? (d.agree ? "✓" : "✗") : ""}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="muted small">
                {pool.length > 0
                  ? `${pool.length} of its ${total} decisions (${Math.round((pool.length / total) * 100)}%) were at ${binLabel(lo)}; ${((agreeAll / pool.length) * 100).toFixed(1)}% of those agree with the reference.`
                  : ""}
                {pool.length > 0 && pool.length < 20
                  ? ` Only ${pool.length} exist, so the room holds them all.`
                  : ""}
              </p>
            </section>
          );
        })}
      </div>
      {focus && detail(focus.id, focus.d)}
    </div>
  );
}

export function Dial({ model: m }: { model: CardModel }) {
  const data = useDecisions(m);
  const [tau, setTau] = useState(0.8);

  if (!data) return <p className="muted">Loading decisions…</p>;

  const lanes = m.shown.flatMap((id) => {
    const all = data.decisions[id] ?? [];

    if (!graded(all) || !all.length) return [];

    const at = (t: number) => {
      const kept = all.filter((d) => d.conf >= t);
      const slip = kept.filter((d) => !d.agree).length;

      return {
        coverage: kept.length / all.length,
        agreement: kept.length ? (kept.length - slip) / kept.length : NaN,
        slipPer1000: (slip / all.length) * 1000,
        toYouPer1000: ((all.length - kept.length) / all.length) * 1000,
      };
    };

    const curve = Array.from({ length: 10 }, (_, i) => 0.5 + i * 0.05).map((t) => ({
      t,
      ...at(t),
    }));

    return [{ id, now: at(tau), curve, n: all.length }];
  });

  const W = 460,
    H = 200,
    L = 44,
    B = 32,
    T = 10,
    R = 12;

  const x = (v: number) => L + v * (W - L - R);
  const y = (v: number) => H - B - ((v - 0.3) / 0.7) * (H - B - T);

  return (
    <div className="cf-dial">
      <label className="cf-slider">
        <span>
          Hand every decision below <b>{Math.round(tau * 100)}%</b> confidence to a person
        </span>
        <input
          type="range"
          min={0.5}
          max={0.95}
          step={0.05}
          value={tau}
          onChange={(e) => setTau(Number(e.target.value))}
        />
      </label>

      <div className="cf-dial-lanes">
        {lanes.map(({ id, now }) => (
          <div key={id} className="cf-dial-lane" style={colorVars(m.contestant(id))}>
            <p>
              <span className="swatch" aria-hidden="true" /> <b>{m.label(id)}</b>
            </p>
            <p className="cf-per">
              Per 1,000 decisions: <b>{Math.round(1000 - now.toYouPer1000)}</b> go through,{" "}
              <b>{Math.round(now.toYouPer1000)}</b> come to you, and{" "}
              <b>{Math.round(now.slipPer1000)}</b> that go through disagree with the reference.
            </p>
            <div className="bar-track" aria-hidden="true">
              <div className="bar-fill" style={{ width: `${now.coverage * 100}%` }} />
            </div>
            <p className="muted small">
              Of what goes through,{" "}
              {Number.isNaN(now.agreement) ? "none" : `${(now.agreement * 100).toFixed(1)}%`} agree.
            </p>
          </div>
        ))}
      </div>

      <svg
        className="cf-curve"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Agreement of what goes through, against the share that goes through, for each contestant as the cutoff rises"
      >
        {[0.4, 0.6, 0.8, 1].map((v) => (
          <g key={v} className="tick">
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        {[0, 0.5, 1].map((v) => (
          <text
            key={v}
            x={x(v)}
            y={H - B + 16}
            textAnchor={v === 0 ? "start" : v === 1 ? "end" : "middle"}
          >
            {Math.round(v * 100)}%
          </text>
        ))}
        <text className="axis-title" x={W - R} y={H - 2} textAnchor="end">
          share that goes through →
        </text>
        <text className="axis-title" x={L} y={T + 2}>
          ↑ agreement of what goes through
        </text>
        {lanes.map(({ id, curve }) => {
          const pts = curve.filter((p) => !Number.isNaN(p.agreement) && p.coverage >= 0.03);
          const dot = curve.reduce((a, b) => (Math.abs(b.t - tau) < Math.abs(a.t - tau) ? b : a));

          return (
            <g key={id} style={colorVars(m.contestant(id))} className="cf-series">
              <polyline points={pts.map((p) => `${x(p.coverage)},${y(p.agreement)}`).join(" ")} />
              {!Number.isNaN(dot.agreement) && dot.coverage >= 0.03 && (
                <circle cx={x(dot.coverage)} cy={y(dot.agreement)} r={5} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
