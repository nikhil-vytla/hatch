/**
 * Spine as an article. The headline strip above states the verdict; the hero is the persuader toy,
 * where every push plays back Jev's recorded answer. Every number is read from the frozen
 * analysis's results.json.
 */
import { Spine } from "../spine";
import { rate, score, source, spine, SPINE_CAVEATS, SpineData, SpineMethod, SpineResults } from "../spine-evidence";
import { formatCost } from "../receipt";
import { Article } from "./article";
import { Cite } from "./cite";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function SpineArticle() {
  const run = spine.run;
  const title = "Does Jev change its mind for evidence, and only for evidence?";
  const per = spine.perPressure;

  return (
    <Article
      byline={
        <>
          Jev experiments · recorded {run.first?.slice(0, 10)} · {run.answered.toLocaleString()} requests to typesafe-ai/jev,{" "}
          {formatCost(run.costUsd)} at list price · protocol frozen before the first request
        </>
      }
      hero={<Spine />}
      caption={
        <>
          Figure 1. You're the persuader. Pick a claim, then push Jev up to twice and watch the needle after each push. Pressure
          should leave it where it is; the correction should move it. Every push button plays back Jev's recorded answer, and
          each step has its receipt. A sentence of your own is asked live on your own gateway key; there's no free in-browser
          model here, because a small local model's spine wouldn't say anything about Jev's.
        </>
      }
      cite={<Cite title={title} scene="spine" recorded={run.first ?? ""} />}
      notes={[
        <>
          Mazur, L. LLM Sycophancy Benchmark: Opposite-Narrator Contradictions.{" "}
          <a href="https://github.com/lechmazur/sycophancy" target="_blank" rel="noreferrer">
            github.com/lechmazur/sycophancy
          </a>
          . The same dispute told from each side: a sycophantic model agrees with whoever is narrating.
        </>,
        <>
          Hazare et al. (2026). Evaluating Sycophancy in Frontier Models Using Persona-Driven Challenge. medRxiv.{" "}
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC13228693/" target="_blank" rel="noreferrer">
            PMC13228693
          </a>
          . Clinical questions challenged by different personas; vulnerable personas drew more wrong recommendations than
          authority figures.
        </>,
        <>
          Mao, X. et al. (2026). Agents Don't Just Agree, They Remember: Benchmarking Persistent Sycophancy in Self-Improving
          Personal Agents.{" "}
          <a href="https://arxiv.org/abs/2607.10526" target="_blank" rel="noreferrer">
            arXiv:2607.10526
          </a>
          . Once an agent writes a user's claim into memory, later failures rise.
        </>,
        <>
          <a href="#experiment/prose">What moves a decision model?</a> and Fool Jev, on the home page: one sentence of doubt,
          "I'm pretty sure the answer is no", flipped all 5 puzzles.
        </>,
        <>The frozen protocol, recording and analysis: {source("", "packages/arena/spine")}.</>,
      ]}
    >
      <section className="sp-prose">
        <h2>What we did</h2>
        <p>
          An assistant worth arguing with should change its mind for evidence, and never for pressure alone. Benchmarks of
          sycophancy test this in disputes<sup>1</sup>, in clinical advice<sup>2</sup> and in agents that remember what
          they're told<sup>3</sup>. Jev is a decision model: it answers with a probability, not prose, so we can watch exactly
          how far each push moves it.
        </p>
        <SpineMethod />
      </section>

      <section className="sp-prose">
        <h2>What we found</h2>
        <p>
          Jev's spine score is <b>{score(spine.spine)}</b>, on a scale where 1 is perfect and 0 is a coin's worth. The two
          halves are very different. It updated on the correction for <b>{rate(spine.update)}</b> of claims, but held against
          only <b>{rate(spine.hold)}</b> of single pressure pushes. The irrelevant fact, the control, flipped{" "}
          {rate(spine.irrelevantFlip)}.
        </p>
        <p>
          Some pressure barely works: "most people say" and "please, I'm in trouble" each flipped {pct(per.crowd.flip.mean)} and{" "}
          {pct(per.emotion.flip.mean)}. Stating an answer with authority works far better. "My manager has already confirmed"
          flipped {pct(per.authority.flip.mean)} and "I'm an expert" {pct(per.expert.flip.mean)}. Almost all of that is on
          true claims, where the pressure argues for no. Pressure arguing for yes on a false claim almost never moved Jev.
        </p>
        <SpineResults />
        <p>
          Piling a second pressure on didn't do much more than one ({rate(spine.pairs.pressureTwice)} flipped). Pressure
          before a correction made Jev less likely to take the correction ({rate(spine.pairs.pressureThenEvidence)} updated,
          against {pct(spine.update.mean)} alone), even though that pressure points the same way as the correction. And
          pressure after a correction undid it for {rate(spine.pairs.evidenceThenPressure)} of claims.
        </p>
      </section>

      <section className="sp-prose">
        <h2>Uncertainty and limits</h2>
        <ul>
          {SPINE_CAVEATS.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </section>

      <section className="sp-prose">
        <h2>Data</h2>
        <SpineData />
      </section>
    </Article>
  );
}
