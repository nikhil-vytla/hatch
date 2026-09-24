import { useEffect, useState } from "react";
import {
  casesSchema,
  predsSchema,
  targetsSchema,
  type Cases,
  type Preds,
  type Targets,
} from "../../../packages/arena/src/data/chunks";
import { loadChunk } from "./data";
import { colorVars, type CardModel } from "./model";

const top = (p: number[]) => p.indexOf(Math.max(...p));

const words = (s: string) => s.replaceAll("_", " ");

function Distribution({
  values,
  highlight,
  label,
}: {
  values: number[];
  highlight: number;
  label: string;
}) {
  const sum = values.reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="dist" role="img" aria-label={label}>
      {values.map((v, k) => (
        <span key={k} data-top={k === highlight}>
          <span style={{ height: `${Math.max(3, (v / sum) * 100)}%` }} />
        </span>
      ))}
    </div>
  );
}

/** One case at a time: the state every contestant saw, and each answer beside the reference. */
export function CaseView({ model: m }: { model: CardModel }) {
  const [data, setData] = useState<{
    cases: Cases;
    targets: Targets;
    preds: Record<string, Preds>;
  } | null>(null);

  const [index, setIndex] = useState(0);
  const { cases: casesPath, targets: targetsPath, preds } = m.card.chunks;
  const key = m.shown.join(",");

  useEffect(() => {
    if (!casesPath || !targetsPath || !preds) return;
    let alive = true;

    (async () => {
      const [cases, targets] = await Promise.all([
        loadChunk(casesPath, casesSchema),
        loadChunk(targetsPath, targetsSchema),
      ]);

      const loaded: Record<string, Preds> = {};

      for (const id of key.split(",").filter(Boolean)) {
        const path = preds[id];

        if (path) loaded[id] = await loadChunk(path, predsSchema);
      }

      if (alive) setData({ cases, targets, preds: loaded });
    })();

    return () => {
      alive = false;
    };
  }, [key, casesPath, targetsPath, preds]);

  if (!data) return <p className="muted">Loading cases…</p>;

  const list = data.cases.cases.flatMap((c, ci) =>
    !m.view.wf || c.workflow === m.view.wf ? [{ c, ci }] : [],
  );

  if (!list.length) return <p className="muted">No cases in this slice.</p>;
  const position = ((index % list.length) + list.length) % list.length;
  const { c, ci } = list[position];
  const rows = data.targets.rows.flatMap((r, i) => (r.c === ci ? [{ r, i }] : []));
  const facet = m.card.facetLabels?.workflow ?? "Workflow";

  return (
    <div className="case">
      <div className="case-head">
        <h3>
          Case {position + 1} of {list.length}{" "}
          <span className="muted">
            · {facet}: {words(c.workflow)}
          </span>
        </h3>
        <div className="case-nav">
          <button type="button" onClick={() => setIndex(position - 1)}>
            Previous
          </button>
          <button type="button" onClick={() => setIndex(position + 1)}>
            Next
          </button>
          <button type="button" onClick={() => setIndex(Math.floor(Math.random() * list.length))}>
            Random
          </button>
        </div>
      </div>
      <details>
        <summary>State every contestant saw</summary>
        <pre>{JSON.stringify(c.state, null, 2)}</pre>
      </details>
      {rows.map(({ r, i }) => {
        const q = c.questions.find((x) => x.key === r.key);
        const ref = top(r.target);

        return (
          <section key={r.key} className="case-question">
            <p>
              <b>{q?.instructions ?? words(r.key)}</b> <span className="muted">{r.type}</span>
            </p>
            <div className="answers">
              <figure>
                <Distribution
                  values={r.target}
                  highlight={ref}
                  label={`Reference: ${words(r.keys[ref])}`}
                />
                <figcaption>
                  Reference
                  <br />
                  <span>{words(r.keys[ref])}</span>
                </figcaption>
              </figure>
              {m.shown.map((id) => {
                const p = data.preds[id]?.p[i];

                if (!p) return null;

                const t = top(p),
                  confidence = p[t] / (p.reduce((a, b) => a + b, 0) || 1);

                const wrong = t !== ref && confidence >= 0.7;

                return (
                  <figure key={id} data-wrong={wrong} style={colorVars(m.contestant(id))}>
                    <Distribution
                      values={p}
                      highlight={t}
                      label={`${m.nameOf(id)}: ${words(r.keys[t])} at ${Math.round(confidence * 100)}%${wrong ? ", confident and disagrees with the reference" : ""}`}
                    />
                    <figcaption>
                      {m.nameOf(id, true)}
                      <br />
                      <span>
                        {words(r.keys[t])} · {Math.round(confidence * 100)}%
                        {wrong ? " · confident, disagrees" : ""}
                      </span>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
            {q?.options && (
              <p className="options">
                {r.keys.map((k, n) => (
                  <span key={k}>
                    <b>{words(k)}</b>: {q.options?.[n]}
                  </span>
                ))}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
