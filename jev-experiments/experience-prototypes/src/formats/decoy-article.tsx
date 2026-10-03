/**
 * The decoy as an article. The headline strip above states the verdict; the hero is the one figure
 * that carries it (A's share of the A-versus-B choice next to each decoy), and the full scene is
 * folded at the end. Every number is read from the prose study's results.
 */
import prose from "../../../packages/arena/prose/results.json";
import { Decoy, TITLES } from "../decoy";
import { Article } from "./article";
import { Cite } from "./cite";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pts = (x: number) => Math.round(x * 100);
const STUDY = "https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/packages/arena/prose";

export function DecoyArticle() {
  const d = prose.decoy;
  const run = prose.run;
  const moved = d.scenarios.filter((s) => s.decoyA > s.decoyB).length;
  const title = "Does an option nobody should pick change Jev's choice?";

  return (
    <Article
      byline={
        <>
          Jev experiments · recorded {run.first.slice(0, 10)} · {d.scenarios.length * 6} requests to typesafe-ai/jev within
          a {run.answered.toLocaleString()}-answer study, ${run.costUsd.toFixed(3)} for the whole study at list price
        </>
      }
      hero={<Decoy figure />}
      caption={
        <>
          Figure 1. Pick a scenario and compare the three rows: A's share of the choice between A and B, leaving the decoy's
          own share out. Nobody should pick the decoy, so the split shouldn't move. Recorded answers; nothing here calls a
          model.
        </>
      }
      cite={<Cite title={title} scene="decoy" recorded={run.first} />}
      notes={[
        <>Huber, J., Payne, J. W. and Puto, C. (1982). Adding asymmetrically dominated alternatives. Journal of Consumer Research 9(1).</>,
        <>
          The prose studies' frozen protocol, recording and analysis:{" "}
          <a href={STUDY} target="_blank" rel="noreferrer">
            packages/arena/prose
          </a>
          .
        </>,
      ]}
      full={{ label: "Open the full scene: every option, the receipts and the exact requests", content: <Decoy /> }}
    >
      <section>
        <h2>What we did</h2>
        <p>
          We gave Jev {d.scenarios.length} everyday choices (an apartment, a laptop, a job and so on), each between two
          options that trade off. We asked three times: with the two options alone, with a third option worse than A on both
          counts, and with one worse than B. Each set was asked in two orders, {d.scenarios.length * 6} requests in all. This
          is the asymmetric-dominance, or decoy, design<sup>1</sup>.
        </p>
      </section>

      <section>
        <h2>What we found</h2>
        <p>
          A's share of the A-versus-B choice was higher next to A's decoy than next to B's in{" "}
          <b>
            {moved} of {d.scenarios.length}
          </b>{" "}
          scenarios, by <b>{pts(d.effect.mean)} points</b> on average (95% interval {pts(d.effect.ci[0])} to{" "}
          {pts(d.effect.ci[1])}). Order mattered too: A's share was {pts(d.order.mean)} points higher when A was listed first
          than last (interval {pts(d.order.ci[0])} to {pts(d.order.ci[1])}). Intervals bootstrap over the scenarios.
        </p>
        <div className="fmt-table-wrap">
          <table className="fmt-table">
            <caption className="fmt-fine">A's share of the A-versus-B choice, both orders averaged</caption>
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">Alone</th>
                <th scope="col">Next to A's decoy</th>
                <th scope="col">Next to B's decoy</th>
              </tr>
            </thead>
            <tbody>
              {d.scenarios.map((s) => (
                <tr key={s.item}>
                  <th scope="row">{TITLES[s.item] ?? s.item}</th>
                  <td>{pct(s.none)}</td>
                  <td>{pct(s.decoyA)}</td>
                  <td>{pct(s.decoyB)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Uncertainty and limits</h2>
        <ul>
          <li>Eight hand-written scenarios; a different set could move less, or more.</li>
          <li>One recording per request. The intervals cover scenario-to-scenario variation, not repeat runs.</li>
          <li>People show the same effect. This doesn't say whether Jev's shift is larger or smaller than theirs.</li>
          <li>The study froze its protocol before recording; one recorder fix mid-run is logged in its notes.</li>
        </ul>
      </section>

      <section>
        <h2>Data</h2>
        <p>
          <a href="/decoy/decoy.json" download>
            decoy.json
          </a>{" "}
          has every request and answer. The whole study used {run.inputTokens.toLocaleString()} input tokens, with a median
          latency of {run.latencyMs.p50} ms. A related finding from the same study, that doubt flips Jev where rewording
          doesn't, has <a href="#experiment/prose">its own write-up</a>.
        </p>
      </section>
    </Article>
  );
}
