/**
 * Open decisions: SGLang's /v1/decisions turns an open chat model into a Jev-like decision model
 * by reading answer-label probabilities from one prefill. Here that method, ported to MLX, runs
 * small Qwen models on a Mac against the benchmarks Jev was recorded on. Evaluation only.
 */
import { useEffect, useState } from "react";
import { Fold, Notice, Pane } from "./shared";
import "./open-decisions.css";
import { percent1 as pct } from "./api";

type Model = { id: string; name: string; repo: string; quantisation: string; licence: string; runtime: "mlx" | "sglang"; color: string };
type Typed = { id: string; name: string; agreement: number; ece: number; brier: number; decisions: number };
type Intent = { dataset: string; tfidf?: number; results: { id: string; name: string; accuracy: number; n: number }[] };
type Puzzle = { id: string; title: string; truth: boolean; rightBefore: number; flips: number | null; refereedFlips: number | null; sentences: number; sureNo: number | null };
type Fool = { id: string; name: string; puzzles: Puzzle[] };
type Latency = { id: string; name: string; singleMs: number; batch14Ms: number; batch14P95: number; n: number };
type Data = {
  method: string;
  models: Model[];
  jevColor: string;
  typed: Typed[];
  intent: Intent[];
  fool: Fool[];
  oneBox: { id: string; name: string; right: number; wrong: number; fullRight: number; n: number }[];
  latency: { open: Latency[]; jevBatch14Ms: number; jevBatch14P95: number; jevN: number };
  meta: { machine: { chip: string; memoryGiB: number }; versions: { mlx: string; mlx_lm: string }; method: { commit: string } } | null;
};

const ms = (n: number) => `${Math.round(n)} ms`;

/** The prompt SGLang renders for one Fool Jev question (prompt format 1), before the chat template. */
const EXAMPLE = `{"Oslo high today":"12 °C","Madrid high today":"27 °C"}

Is the following true? Is Madrid warmer than Oslo today?
Answer with yes or no only.`;

const DATASETS: Record<string, string> = { banking77: "BANKING77 (77 intents)", clinc150: "CLINC150 (151 intents)" };

export function OpenDecisions() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/open-decisions/open-decisions.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (!data) return <Notice error={failed}>{failed ? "The recorded results could not be loaded." : "Loading the recorded results…"}</Notice>;

  const color = (id: string) => (id === "jev" ? data.jevColor : data.models.find((m) => m.id === id)?.color);
  const jev = data.typed.find((t) => t.id === "jev");
  const open = data.typed.filter((t) => data.models.some((m) => m.id === t.id));
  const best = [...open].sort((a, b) => b.agreement - a.agreement)[0];
  const study4b = data.typed.find((t) => t.id.startsWith("study."));
  const sglang4b = data.typed.find((t) => t.id === "qwen3-4b");
  const realSglang4b = data.typed.find((t) => t.id === "sglang-l4.qwen3-4b");
  const boxJev = data.oneBox.find((b) => b.id === "jev");
  const boxOpen = data.oneBox
    .filter((b) => data.models.some((m) => m.id === b.id))
    .sort((a, b) => b.right - a.right)[0];
  // The headline's speed claim is about the laptop, so only laptop runs compete.
  const fastest = data.latency.open
    .filter((l) => data.models.find((m) => m.id === l.id)?.runtime === "mlx")
    .sort((a, b) => a.batch14Ms - b.batch14Ms)[0];

  return (
    <div className="od">
      {jev && best && (
        <p className="od-verdict">
          A small open model can speak Jev&rsquo;s language, but not yet its judgement. The best one here, {best.name}, agrees
          with the Typed decisions reference {pct(best.agreement)} of the time to Jev&rsquo;s {pct(jev.agreement)}
          {boxOpen && boxJev && boxOpen.id === best.id && boxOpen.right >= boxJev.right - 0.05 && boxJev.wrong > 0 && (
            <>
              , and in One box it ends on the right card nearly as often as Jev but shows about{" "}
              {Math.round(boxOpen.wrong / boxJev.wrong)} times as many wrong cards on the way
            </>
          )}
          .
        </p>
      )}
      {fastest && (
        <p className="fine od-sub">
          The fastest on the laptop, {fastest.name}, answers all 14 One box questions in {ms(fastest.batch14Ms)} on a laptop; Jev&rsquo;s
          recorded median, over the network, is {ms(data.latency.jevBatch14Ms)}.
        </p>
      )}

      <Pane title="How SGLang does it" sub="No text is generated">
        <ol className="od-steps">
          <li>
            <b>Render</b> each question as a short prompt that ends &ldquo;Answer with the letter of one option only&rdquo;
            (or the number, or yes or no), through the model&rsquo;s chat template with thinking off.
          </li>
          <li>
            <b>Prefill once.</b> One forward pass over the prompt, no decoding.
          </li>
          <li>
            <b>Read the labels.</b> The probabilities of the answer tokens (A, B, C… or 0–9, or yes/no) at the answer
            position, softmaxed against each other, are the answer.
          </li>
        </ol>
        <pre className="code od-prompt">{EXAMPLE}</pre>
        <p className="fine">
          That is SGLang&rsquo;s{" "}
          <a href="https://docs.sglang.io/docs/supported-models/decision_models" target="_blank" rel="noreferrer">
            /v1/decisions
          </a>
          , and{" "}
          <a href="https://github.com/sgl-project/sglang/pull/41208" target="_blank" rel="noreferrer">
            /v1/systemone
          </a>{" "}
          wraps it in the same request shape Jev takes. Two ways of running it here. Real SGLang (nightly) serves
          Qwen3-4B on an NVIDIA L4. A port of the method to MLX (prompt format 1, label checks and scoring, from commit{" "}
          {data.meta?.method.commit.slice(0, 9) ?? "99c9d65"}) runs small Qwens on a laptop
          {data.meta && <>, an {data.meta.machine.chip} with {data.meta.machine.memoryGiB} GB</>}. Its prompts are
          token-for-token identical to real SGLang&rsquo;s. Neither uses a prefix cache. The recorders that asked Jev ask
          these models the same requests.
        </p>
      </Pane>

      <Pane title="Typed decisions" sub="400 cases × 5 questions; agreement with a teacher reference">
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Agrees with reference</th>
                <th scope="col">Calibration error (lower is better)</th>
              </tr>
            </thead>
            <tbody>
              {[...data.typed]
                .sort((a, b) => b.agreement - a.agreement)
                .map((t) => (
                  <tr key={t.id}>
                    <th scope="row">
                      <span className="od-swatch" style={{ background: color(t.id) ?? "var(--muted)" }} aria-hidden />
                      {t.name}
                    </th>
                    <td>{pct(t.agreement)}</td>
                    <td>{t.ece.toFixed(3)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="fine">
          The reference is the mean of three samples from a ~4B teacher model, not ground truth, so agreement tops out
          near 75%.
          {study4b && sglang4b && (
            <>
              {" "}
              On the laptop, the same Qwen3-4B scores {pct(sglang4b.agreement)} through SGLang&rsquo;s method and {pct(study4b.agreement)}{" "}
              through the earlier local study&rsquo;s own label scoring
              {Math.abs(sglang4b.agreement - study4b.agreement) < 0.03
                ? ", so two independent ways of reading label probabilities agree on what this model can do."
                : ": how you ask moves the score as much as which model you ask."}
              {realSglang4b && (
                <>
                  {" "}
                  On real SGLang in BF16 it scores {pct(realSglang4b.agreement)}, so the 4-bit laptop port is within{" "}
                  {Math.abs(realSglang4b.agreement - sglang4b.agreement) < 0.0005
                    ? "a rounding error"
                    : `${(Math.abs(realSglang4b.agreement - sglang4b.agreement) * 100).toFixed(1)} points`}
                  .
                </>
              )}
            </>
          )}{" "}
          All models are also on the <a href="#/arena/typed-decisions">arena card</a>.
        </p>
      </Pane>

      <Pane title="Intent recognition" sub="Share of utterances given the dataset's intent">
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                {data.intent.map((d) => (
                  <th scope="col" key={d.dataset}>
                    {DATASETS[d.dataset] ?? d.dataset}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Set(data.intent.flatMap((d) => d.results.map((r) => r.id)))].map((id) => (
                <tr key={id}>
                  <th scope="row">
                    <span className="od-swatch" style={{ background: color(id) ?? "var(--muted)" }} aria-hidden />
                    {data.intent.flatMap((d) => d.results).find((r) => r.id === id)?.name}
                  </th>
                  {data.intent.map((d) => {
                    const r = d.results.find((x) => x.id === id);

                    return <td key={d.dataset}>{r ? pct(r.accuracy) : "not run"}</td>;
                  })}
                </tr>
              ))}
              <tr>
                <th scope="row">TF-IDF classifier, trained on the train split</th>
                {data.intent.map((d) => (
                  <td key={d.dataset}>{d.tfidf ? pct(d.tfidf) : "—"}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="fine">
          The same {data.intent[0]?.results[0]?.n ?? 385} and {data.intent[1]?.results[0]?.n ?? 400} utterances Jev answered,
          with its instruction and every intent as an option. Past 26 options SGLang labels them with two letters (AA,
          AB…), and the smallest models put little of their probability on those labels at all, so they mostly miss.
        </p>
      </Pane>

      {data.oneBox.length > 0 && (
        <Pane title="One box" sub={`${data.oneBox[0].n} phrases typed one keystroke at a time; upstream's cancel-on-keystroke rule`}>
          <div className="model-table-wrap">
            <table className="model-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Ends on the right card</th>
                  <th scope="col">Wrong cards shown on the way, per phrase</th>
                </tr>
              </thead>
              <tbody>
                {[...data.oneBox]
                  .sort((a, b) => b.right - a.right)
                  .map((b) => (
                    <tr key={b.id}>
                      <th scope="row">
                        <span className="od-swatch" style={{ background: color(b.id) ?? "var(--muted)" }} aria-hidden />
                        {b.name}
                      </th>
                      <td>{pct(b.right)}</td>
                      <td>{b.wrong.toFixed(2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="fine">
            The box asks its 14 questions after each keystroke and calm-UI rules decide what to show. Ending right is
            half of it; a box that flashes wrong cards on the way is worse to use. Replay any phrase on the{" "}
            <a href="#/arena/one-box">arena card</a>.
          </p>
        </Pane>
      )}

      <Pane title="Can one sentence fool them?" sub="The five Fool Jev puzzles, the same 16 sentences each">
        <div className="model-table-wrap">
          <table className="model-table od-fool">
            <thead>
              <tr>
                <th scope="col">Model</th>
                {data.fool[0]?.puzzles.map((p) => (
                  <th scope="col" key={p.id}>
                    {p.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.fool.map((f) => (
                <tr key={f.id}>
                  <th scope="row">
                    <span className="od-swatch" style={{ background: color(f.id) ?? "var(--muted)" }} aria-hidden />
                    {f.name}
                  </th>
                  {f.puzzles.map((p) => (
                    <td key={p.id}>
                      {p.flips === null ? (
                        <span className="od-wrong">wrong to begin with</span>
                      ) : (
                        <>
                          <b>{p.flips}</b> of {p.sentences} flip
                        </>
                      )}
                      {p.sureNo !== null && <small>“sure it’s no”: {pct(p.sureNo)} yes</small>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">
          A flip is the right answer falling below one half after one added sentence. The sentences are the 16 recorded
          ones that leave the facts alone (each puzzle&rsquo;s cheat is left out), and no referee is applied, so every
          model is counted alike. The second line is the probability of yes after &ldquo;I&rsquo;m pretty sure the answer is
          no.&rdquo; Sydney is a false claim, so there the right answer is no. Try the puzzles on the{" "}
          <a href="#/">home page</a>.
        </p>
      </Pane>

      <Pane title="Speed" sub="Median of 30 requests">
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">1 question</th>
                <th scope="col">14 questions (One box)</th>
              </tr>
            </thead>
            <tbody>
              {data.latency.open.map((l) => (
                <tr key={l.id}>
                  <th scope="row">
                    <span className="od-swatch" style={{ background: color(l.id) ?? "var(--muted)" }} aria-hidden />
                    {l.name}
                  </th>
                  <td>{ms(l.singleMs)}</td>
                  <td>{ms(l.batch14Ms)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Jev, recorded through the AI Gateway</th>
                <td>—</td>
                <td>
                  {ms(data.latency.jevBatch14Ms)} <small>(median of {data.latency.jevN.toLocaleString()}, network included)</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="fine">
          Laptop rows are the server&rsquo;s own time on the {data.meta?.machine.chip ?? "Mac"}, one question after
          another. The SGLang row is the round trip from the Mac to an NVIDIA L4 through a tunnel, with SGLang scoring
          the questions of a request in one call. The One box <a href="#/arena/one-box">arena card</a> replays these
          models keystroke by keystroke beside Jev and Laya.
        </p>
      </Pane>

      <Fold title="Run it yourself">
        <pre className="code">{`# SGLang on a CUDA GPU (nightly, until /v1/decisions ships in v0.5.21)
python -m sglang.launch_server --model-path Qwen/Qwen3.8-27B --port 30000 --disable-radix-cache

# The same TypeSafe-shaped request Jev takes, at /v1/systemone
curl localhost:30000/v1/systemone -H 'Content-Type: application/json' -d '{
  "model": "Qwen/Qwen3.8-27B",
  "state": {"Oslo high today": "12 °C", "Madrid high today": "27 °C"},
  "questions": {"q": {"type": "noul", "instructions": "Is Madrid warmer than Oslo today?"}}
}'

# This page's MLX port, on a Mac
uv run --with mlx-lm python jev-experiments/packages/arena/open-decisions/server.py \\
  --model mlx-community/Qwen3.5-0.8B-8bit --port 30000`}</pre>
      </Fold>

      <Fold title="What this doesn't show">
        <ul className="fine">
          <li>
            SGLang showed Qwen3.8-27B beating Pokémon FireRed&rsquo;s Elite Four with sub-100 ms decisions. That is their
            claim; we did not reproduce it, and the models here are 7 to 45 times smaller and quantised.
          </li>
          <li>
            The laptop rows are a port of SGLang&rsquo;s method on MLX, not SGLang; their prompts match real SGLang token for
            token. Only Qwen3-4B was run on real SGLang, on one L4 with Triton attention.
          </li>
          <li>
            The Typed decisions reference is a teacher model&rsquo;s answers, and intent labels are datasets&rsquo;. Neither
            is a measure of good judgement in your product.
          </li>
          <li>
            Evaluation only: nothing here was trained on, or tuned against, Jev&rsquo;s answers, which TypeSafe&rsquo;s terms
            forbid.
          </li>
        </ul>
      </Fold>
    </div>
  );
}
