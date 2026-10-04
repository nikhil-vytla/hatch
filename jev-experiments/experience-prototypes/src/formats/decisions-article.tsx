/**
 * Decisions in an interface: One box and When to ask a person as one article. The hero is the
 * One box card forming as a phrase is typed (recorded), with the box live on your own key just
 * below; then what the held-out phrases show, what a calm UI costs, the latency budget, and the
 * handoff figure for calibrated confidence. Every number is read from the arena card or the
 * classify record; the views here keep their state locally, so nothing rewrites the address.
 */
import { useEffect, useMemo, useState } from "react";
import type { ArenaIndex, Card } from "../../../packages/arena/src/data/schema";
import { allN, HANDOFF_THRESHOLD, heldOutN, heldOutRows, intentFacts, jevPolicies } from "../../../packages/arena/src/decisions-in-ui/facts";
import { QUESTIONS } from "../../../packages/arena/src/one-box/questions";
import { TYPING } from "../../../packages/arena/src/one-box/replay";
import { loadIndex, type View } from "../arena/data";
import { useCardModel } from "../arena/model";
import { TryBox } from "../arena/try-box";
import { BuildThis } from "../build-this";
import { TypingWatch } from "../arena/typing";
import "../arena/arena.css";
import { Handoff } from "../handoff";
import { Article } from "./article";
import { Cite } from "./cite";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const two = (x: number) => x.toFixed(2);
const ms = (x: number) => `${Math.round(x).toLocaleString()} ms`;
const interval = (lo?: number, hi?: number, f = pct) => (lo === undefined || hi === undefined ? "" : `${f(lo)}–${f(hi)}`);
const title = "What do fast, calibrated decisions do inside a real UI?";

/** The figure's starting view: held-out phrases, Jev beside the closest model, Laya and the rules. */
const START: View = {
  card: "one-box",
  lens: "typing",
  wf: "held-out",
  c: ["jev@cancel", "sglang-l4.qwen3-4b@cancel", "laya@cancel", "code.keyword"],
};

/** The arena card model with its view held here instead of in the address. */
function useLocalModel(card: Card) {
  const [view, setView] = useState<View>(START);
  const base = useCardModel(card, view, false);

  return { ...base, set: (patch: Partial<View>) => setView((v) => ({ ...v, ...patch })) };
}

function Figures({ card, which }: { card: Card; which: "watch" | "try" }) {
  const m = useLocalModel(card);

  return which === "watch" ? <TypingWatch model={m} /> : <TryBox model={m} />;
}

export function DecisionsArticle({ result }: { result: any }) {
  const [index, setIndex] = useState<ArenaIndex | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    loadIndex().then(setIndex, () => setFailed(true));
  }, []);

  const banking = useMemo(() => intentFacts(result?.experiments?.banking77?.rows ?? []), [result]);
  const clinc = useMemo(() => intentFacts(result?.experiments?.clinc150?.rows ?? []), [result]);
  const card = index?.cards.find((c) => c.id === "one-box");

  if (failed) return <p className="muted">The One box recording could not be loaded.</p>;
  if (!index || !card) return <p className="muted">Loading the One box recording…</p>;

  const rows = heldOutRows(card);
  const jev = rows.find((r) => r.id === "jev@cancel");
  const policies = jevPolicies(card);
  const cancel = policies.find((p) => p.policy === "cancel");
  const latest = policies.find((p) => p.policy === "latest");
  const runSet = card.contestants.find((c) => c.id === "jev@cancel")?.runSets[0];
  const recorded = index.runSets.find((r) => r.id === runSet)?.recordedAt ?? index.generatedAt;
  const models = rows.filter((r) => r.latency !== null);
  const fewest = jev && rows.every((r) => r.wrong.value >= jev.wrong.value);
  const ahead = jev ? rows.filter((r) => r.right.value > jev.right.value) : [];
  const wordGap = TYPING.msPerKey + TYPING.wordPauseMs;
  const cost = card.results["jev@cancel"]?.cost?.value;

  return (
    <Article
      byline={
        <>
          Jev experiments · One box recorded {recorded.slice(0, 10)} · {allN(card)} typed phrases, {heldOutN(card)} of them
          held out · {banking?.total.toLocaleString() ?? "—"} BANKING77 and {clinc?.total.toLocaleString() ?? "—"} CLINC150
          requests to typesafe-ai/jev
        </>
      }
      hero={
        <>
          <Figures card={card} which="watch" />
          <details className="fmt-full-scene">
            <summary>Try your own phrase (the keyword rules run here free; Jev runs live on your key)</summary>
            <Figures card={card} which="try" />
          </details>
        </>
      }
      caption={
        <>
          Figure 1. A held-out phrase typed at {TYPING.msPerKey} ms a key, with a {TYPING.wordPauseMs} ms pause after each
          word. Each lane is the card one box would show as the letters arrive. Press play, or step to another phrase.
          Recorded answers; nothing here calls a model unless you open "Try your own" with a key connected.
        </>
      }
      cite={<Cite title={title} scene="decisions-in-ui" recorded={recorded} />}
      notes={[
        <>
          Calm-UI thresholds and keyword rules from{" "}
          <a href="https://github.com/anishfn/shapeshift" target="_blank" rel="noreferrer">
            Shapeshift
          </a>{" "}
          (MIT), used untuned.
        </>,
        <>
          Casanueva, I. et al. (2020). Efficient intent detection with dual sentence encoders (BANKING77). Larson, S. et al.
          (2019). An evaluation dataset for intent classification and out-of-scope prediction (CLINC150).
        </>,
        <>Guo, C. et al. (2017). On calibration of modern neural networks. ICML.</>,
      ]}
    >
      <BuildThis
        request={{ state: { text: "lunch with priya thursday at noon on zoom" }, questions: QUESTIONS }}
        rebuilt
        note="Every keystroke's request has this shape: what's typed so far, and the same One box questions."
        label="Build this: One box's request"
      />
      <section>
        <h2>The question</h2>
        <p>
          A decision model inside an interface is judged by what people see, not by its final answer. One box turns what you
          type into a card (an event, a reminder, a sum) and changes that card as you type. A good box shows the right card
          early and rarely shows a wrong one. When the model isn't sure, the interface should hand the decision to a person.
          This article looks at both: the box as you type, then how much a stated confidence can be trusted.
        </p>
      </section>

      <section>
        <h2>On held-out phrases, the fewest wrong cards</h2>
        {jev && (
          <p>
            Typing the {heldOutN(card)} held-out phrases, Jev's box ends on the right card for <b>{pct(jev.right.value)}</b>{" "}
            (95% interval {interval(jev.right.lo, jev.right.hi)}), showing <b>{two(jev.wrong.value)}</b> wrong cards a
            phrase{fewest ? ", the fewest of any contestant" : ""}.{" "}
            {ahead.map((r) => (
              <span key={r.id}>
                {r.name} ends right slightly more often ({pct(r.right.value)}) but shows {two(r.wrong.value)} wrong cards a
                phrase, about {Math.round(r.wrong.value / Math.max(jev.wrong.value, 0.001))} times as many.{" "}
              </span>
            ))}
            The intervals overlap on right-at-the-end; the gap is in what you see on the way.
          </p>
        )}
        <div className="fmt-table-wrap">
          <table className="fmt-table">
            <caption className="fmt-fine">
              Held-out phrases ({heldOutN(card)}), each contestant under the cancel-on-keystroke policy. 95% case-bootstrap
              intervals.
            </caption>
            <thead>
              <tr>
                <th scope="col">Contestant</th>
                <th scope="col">Ends on the right card</th>
                <th scope="col">Wrong cards a phrase</th>
                <th scope="col">Visible changes</th>
                <th scope="col">Answer time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  <td>
                    {pct(r.right.value)} <span className="fmt-fine">{interval(r.right.lo, r.right.hi)}</span>
                  </td>
                  <td>
                    {two(r.wrong.value)} <span className="fmt-fine">{interval(r.wrong.lo, r.wrong.hi, two)}</span>
                  </td>
                  <td>{two(r.changes.value)}</td>
                  <td>{r.latency === null ? "no model call" : ms(r.latency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {cancel && latest && (
        <section>
          <h2>What a calm interface costs</h2>
          <p>
            Two policies decide when the box asks. <i>Latest</i> answers every keystroke and shows whatever arrives.{" "}
            <i>Cancel</i>, upstream's policy, drops the request in flight when you type again and waits for calm before
            committing a card. Over all {allN(card)} phrases, with Jev in both, cancel cuts wrong cards from{" "}
            <b>{two(latest.wrong)}</b> to <b>{two(cancel.wrong)}</b> a phrase and visible changes from {two(latest.changes)}{" "}
            to {two(cancel.changes)}. The box ends right just as often ({pct(cancel.right)} both ways). The price is time:
            the right card arrives for good after {ms(cancel.timeToRight)} instead of {ms(latest.timeToRight)}.
          </p>
        </section>
      )}

      {jev && jev.latency !== null && (
        <section>
          <h2>The latency budget</h2>
          <p>
            Keys arrive every {TYPING.msPerKey} ms, and the gap at a word boundary is {wordGap} ms. Jev's median answer takes{" "}
            <b>{ms(jev.latency)}</b>, longer than one keystroke but shorter than a word gap, so under cancel its answers land
            in the pauses between words. The open models answer in{" "}
            {models
              .filter((r) => r.id !== "jev@cancel")
              .map((r) => `${ms(r.latency ?? 0)} (${r.name})`)
              .join(", ")}
            . The keyword rules make no model call and answer after the {TYPING.debounceMs} ms debounce. Answer times are
            the recorded ones; a box on your own network will differ.
            {cost !== undefined && <> Jev costs ${cost.toFixed(2)} per 1,000 typed phrases at list price.</>}
          </p>
        </section>
      )}

      <section>
        <h2>When to ask a person</h2>
        <p>
          A box can only hand a decision to a person if its confidence means something. On recorded intent requests, Jev
          acts alone when its top answer's confidence is at least {pct(HANDOFF_THRESHOLD)}, and asks otherwise.
        </p>
        {banking && clinc && (
          <p>
            At that threshold Jev handles <b>{pct(banking.handled)}</b> of BANKING77 requests alone and gets{" "}
            <b>{(banking.right * 100).toFixed(1)}%</b> of those right, against {pct(banking.accuracy)} right over every
            request. On CLINC150 it handles {pct(clinc.handled)} and gets {(clinc.right * 100).toFixed(1)}% right.
            Calibration error is {two(banking.ece)} on BANKING77 and {two(clinc.ece)} on CLINC150 (ten equal bins<sup>3</sup>
            ). On BANKING77 its mean stated confidence is {pct(banking.confidence)} against {pct(banking.accuracy)} right
            {banking.confidence > banking.accuracy ? ": Jev is overconfident, so even a high threshold lets some mistakes through" : ""}
            . Typed Decisions, the figure's third tab, has its own calibration note.
          </p>
        )}
        <figure className="fmt-hero">
          <Handoff result={result} />
          <figcaption>
            Figure 2. Move the threshold: requests above it are handled by Jev, those below go to a person. Switch dataset
            for CLINC150 and Typed Decisions. Recorded answers. The <a href="#experiment/handoff">full scene</a> also finds
            the cheapest threshold for a given cost of a mistake.
          </figcaption>
        </figure>
      </section>

      <section>
        <h2>Method</h2>
        <p>{card.provenance}.</p>
        <p>
          The intent requests are recorded Jev answers with per-intent probabilities; confidence is the top intent's
          share. Calibration error weights each bin's gap between stated confidence and accuracy by its size.
        </p>
      </section>

      <section>
        <h2>Uncertainty and limits</h2>
        <ul>
          <li>
            {heldOutN(card)} held-out phrases is a small set. Several contestants' intervals overlap, so the ranking on
            right-at-the-end is not settled; the wrong-card gap is the clearer result.
          </li>
          <li>The phrases and their expected cards were written by a model and reviewed, not collected from real users.</li>
          <li>Typing is simulated at one steady speed. Real typists pause, correct and paste.</li>
          <li>Answer times are from one recording on one network, and Laya runs only on a Mac.</li>
          <li>The handoff figures use one recording per request; the threshold is chosen on the same data it's shown on.</li>
        </ul>
      </section>

      <section>
        <h2>Data</h2>
        <p>
          The One box card, its phrases and every recorded frame are in the arena's{" "}
          <a href="/arena/index.json" download>
            index.json
          </a>{" "}
          and{" "}
          <a href={`/arena/${card.chunks.phrases ?? ""}`} download>
            phrases.json
          </a>
          . The intent requests are in{" "}
          <a href="/data/classify.json" download>
            classify.json
          </a>
          . Full scenes: <a href="#/arena/one-box">One box in the arena</a> (every contestant, both policies, every lens)
          and <a href="#experiment/handoff">When to ask a person</a> (the cost calculator and its sources).
        </p>
      </section>
    </Article>
  );
}
