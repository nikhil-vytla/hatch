import { useState } from "react";
import { formatSpread, formatValue } from "./data";
import { colorVars, compareBy, type CardModel } from "./model";

/** Every measure for the contestants in the figure; column headings sort. */
export function Table({ model: m }: { model: CardModel }) {
  const [sortId, setSortId] = useState(m.metric.id);
  const sortBy = m.card.metrics.find((mm) => mm.id === sortId) ?? m.metric;

  const rows = [...m.shown].sort((a, b) => {
    const ea = m.estimate(a, sortBy),
      eb = m.estimate(b, sortBy);

    if (!ea || !eb) return ea ? -1 : eb ? 1 : 0;

    return compareBy(sortBy, ea.value, eb.value);
  });

  return (
    <div className="table-wrap">
      <table className="results dense">
        <thead>
          <tr>
            <th scope="col">Contestant</th>
            {m.card.metrics.map((mm) => (
              <th
                key={mm.id}
                scope="col"
                aria-sort={
                  mm.id === sortBy.id
                    ? mm.better === "higher"
                      ? "descending"
                      : "ascending"
                    : "none"
                }
              >
                <button
                  type="button"
                  className="sort"
                  onClick={() => setSortId(mm.id)}
                  title={mm.help}
                >
                  {mm.label}
                  <span className="sort-dir" aria-hidden="true">
                    {mm.id === sortBy.id ? (mm.better === "higher" ? " ↓" : " ↑") : ""}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((id) => (
            <tr key={id} style={colorVars(m.contestant(id))} data-kind={m.contestant(id)?.kind}>
              <th scope="row">
                <span className="swatch" aria-hidden="true" />
                {m.nameOf(id)}
              </th>
              {m.card.metrics.map((mm) => {
                const e = m.estimate(id, mm);
                const [d0, d1] = mm.domain ?? [0, 1];
                const width = e ? Math.max(2, ((e.value - d0) / (d1 - d0 || 1)) * 100) : 0;

                const values = m.shown.flatMap((o) => {
                  const v = m.estimate(o, mm)?.value;

                  return v === undefined ? [] : [v];
                });

                const best = e !== undefined && values.every((v) => compareBy(mm, e.value, v) <= 0);

                return (
                  <td key={mm.id} data-best={best}>
                    <span className="cell-value">{formatValue(mm, e)}</span>
                    {best && <span className="sr-only"> (best)</span>}
                    <small>{formatSpread(mm, e)}</small>
                    {e && (
                      <span
                        className="cell-bar"
                        style={{ width: `${width}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
