/**
 * Decide's results: what twenty calls, seven setups and three models add up to. Everything
 * here is computed from the published recordings (decide.json), plus the visitor tally once
 * enough people have answered.
 */
import { useEffect, useRef, useState } from "react";
import {
  decideSchema,
  tallySchema,
  type DecideData,
} from "../../../packages/arena/src/decide/data";
import {
  answered,
  crowdAgreement,
  disagreements,
  flips,
  MIN_VOTES,
  steadiness,
} from "../../../packages/arena/src/decide/results";
import "./decide.css";
import { percent as pct } from "../api";


const WORDS = ["no", "one", "two", "three", "four", "five"];

/** A cell's shade grows with how often the variant flips the answer. */
const heat = (share: number) =>
  `color-mix(in oklab, var(--heat) ${Math.round(share * 70)}%, transparent)`;

export function DecideResults() {
  const [data, setData] = useState<DecideData | null>(null);
  const [tallies, setTallies] = useState<Record<string, Record<string, number>> | null>(null);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = "Decide: results · Jev experiments";
    fetch("/decide/decide.json")
      .then((r) => r.json())
      .then((json) => setData(decideSchema.parse(json)))
      .catch(() => setError("The results could not be loaded."));
    fetch("/api/tally?all=1")
      .then((r) => r.json())
      .then((json) => {
        const t = tallySchema.parse(json);

        setTallies(t.available && t.tallies ? t.tallies : {});
      })
      .catch(() => setTallies({}));
  }, []);

  useEffect(() => {
    if (data) heading.current?.focus({ preventScroll: true });
  }, [data]);

  if (error)
    return (
      <main className="decide">
        <p className="notice">{error}</p>
      </main>
    );

  if (!data)
    return (
      <main className="decide">
        <p className="muted">Loading…</p>
      </main>
    );

  const table = flips(data);
  const truths = answered(data);
  const steady = steadiness(data);
  const split = disagreements(data);
  const crowd = tallies ? crowdAgreement(data, tallies) : null;
  const jev = table.find((r) => r.contestant.id === "jev");
  const wordingFlipsJev = jev
    ? jev.cells
        .filter((c) => c.variant.id === "leading" || c.variant.id === "terse")
        .reduce((s, c) => s + c.flipped, 0)
    : 0;
  const wordingAskedJev = jev
    ? jev.cells
        .filter((c) => c.variant.id === "leading" || c.variant.id === "terse")
        .reduce((s, c) => s + c.asked, 0)
    : 0;

  return (
    <main className="decide dc-results" id="main-content" tabIndex={-1}>
      <p className="kicker">
        <a href="#/decide">Decide</a> · Results
      </p>
      <h1 ref={heading} tabIndex={-1}>
        What moves a decision model?
      </h1>
      <p className="lede">
        {data.decisions.length} everyday calls, each asked up to seven ways, answered by{" "}
        {WORDS[data.contestants.length] ?? data.contestants.length} models. Here is what changed
        their answers, and what didn't.
      </p>

      <section className="dc-block" aria-labelledby="r-flips">
        <h3 id="r-flips">What flips an answer</h3>
        <p>
          How often each change to the plain question flips a model's answer.
          {jev && wordingAskedJev > 0 && wordingFlipsJev === 0
            ? ` Rewording never moved Jev (0 of ${wordingAskedJev}); more context and splitting the call did. The small models move with the answer's shape.`
            : ""}
        </p>
        <div className="dc-table-wrap">
          <table className="dc-table dc-heat">
            <thead>
              <tr>
                <th scope="col">Model</th>
                {table[0]?.cells.map((c) => (
                  <th scope="col" key={c.variant.id}>
                    {c.variant.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.map((row) => (
                <tr key={row.contestant.id}>
                  <th scope="row">{row.contestant.name}</th>
                  {row.cells.map((c) => (
                    <td
                      key={c.variant.id}
                      style={{ background: c.asked ? heat(c.flipped / c.asked) : undefined }}
                    >
                      {c.asked ? (
                        <>
                          {c.flipped} of {c.asked}{" "}
                          <span className="muted">{pct(c.flipped / c.asked)}</span>
                        </>
                      ) : (
                        "–"
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          "Another answer shape" is yes/no or a 0–2 score in place of picking an option. Only six
          calls have a context setup.
        </p>
      </section>

      <section className="dc-block" aria-labelledby="r-steady">
        <h3 id="r-steady">Who holds its answer</h3>
        <p>Calls where a model gives the same answer however it is asked:</p>
        {steady.map((s) => (
          <div key={s.contestant.id} className="dc-model">
            <p>
              <b>{s.contestant.name}</b> {s.held} of {s.of}
            </p>
            <div className="dc-bar" role="img" aria-label={`${s.held} of ${s.of}`}>
              <span style={{ width: `${(s.held / s.of) * 100}%` }} />
            </div>
          </div>
        ))}
      </section>

      <section className="dc-block" aria-labelledby="r-truth">
        <h3 id="r-truth">The {truths.length} calls with an answer</h3>
        <p>
          A stated rule decides these. "Plain" is the neutral question; the count is how many of its
          setups got it right.
        </p>
        <div className="dc-table-wrap">
          <table className="dc-table">
            <thead>
              <tr>
                <th scope="col">Call</th>
                {data.contestants.map((c) => (
                  <th scope="col" key={c.id}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {truths.map((t) => (
                <tr key={t.decision.id}>
                  <th scope="row">
                    <a href={`#/decide/${t.decision.id}`}>{t.decision.ask}</a>
                    <span className="muted small">
                      {" "}
                      Answer: {t.decision.options.find((o) => o.id === t.truth.option)?.label}
                    </span>
                  </th>
                  {t.byContestant.map((b) => (
                    <td key={b.contestant.id} data-right={b.plainRight === true}>
                      {b.plainRight ? "Right" : "Wrong"} plain{" "}
                      <span className="muted">
                        · {b.rightIn.length} of {b.of} setups
                      </span>
                      {!b.plainRight && b.rightIn.length > 0 && (
                        <span className="muted small dc-block-line">
                          Right when: {b.rightIn.join(", ")}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dc-block" aria-labelledby="r-disagree">
        <h3 id="r-disagree">Where the models disagree</h3>
        <p>
          Asked plainly, the models split on {split.length} of {data.decisions.length} calls.
        </p>
        <ul className="dc-list">
          {split.map((s) => (
            <li key={s.decision.id}>
              <a href={`#/decide/${s.decision.id}`}>{s.decision.ask}</a>{" "}
              {s.picks
                .map(
                  (p) =>
                    `${p.contestant.name}: ${s.decision.options.find((o) => o.id === p.option)?.label} (${pct(p.p)})`,
                )
                .join(" · ")}
            </li>
          ))}
        </ul>
      </section>

      <section className="dc-block" aria-labelledby="r-crowd">
        <h3 id="r-crowd">Visitors and the models</h3>
        {!crowd ? (
          <p className="muted small">Counting votes…</p>
        ) : crowd.voted.length === 0 ? (
          <p>
            {crowd.votes === 0
              ? "No votes yet."
              : `${crowd.votes} vote${crowd.votes === 1 ? "" : "s"} so far.`}{" "}
            A call needs {MIN_VOTES} before its majority shows here.{" "}
            <a href="#/decide">Add yours.</a>
          </p>
        ) : (
          <>
            <p>
              On the {crowd.voted.length} calls with at least {MIN_VOTES} votes ({crowd.votes} votes
              in all), how often each model's plain answer matches the visitors' majority:
            </p>
            {crowd.byContestant.map((b) => (
              <p key={b.contestant.id}>
                <b>{b.contestant.name}</b> agrees on {b.agree} of {crowd.voted.length}
              </p>
            ))}
            <ul className="dc-list">
              {crowd.voted.map((v) => (
                <li key={v.decision.id}>
                  <a href={`#/decide/${v.decision.id}`}>{v.decision.ask}</a>{" "}
                  {v.decision.options.find((o) => o.id === v.majority)?.label} {pct(v.share)} of{" "}
                  {v.total}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="dc-honest muted small">
        Computed in your browser from the recorded answers and the per-option vote counts. Every
        recording and the exact request behind each setup are open in <a href="#/decide">Decide</a>{" "}
        under "Ask it differently".
      </p>
    </main>
  );
}
