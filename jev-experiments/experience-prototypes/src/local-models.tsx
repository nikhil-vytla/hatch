import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Pane, Stat, Fold, Button, Notice } from "./shared";
const pct = (n: number) => `${(Math.round(n * 1000 + 1e-8) / 10).toFixed(1)}%`;
const number = (n: number | null | undefined, d = 3) =>
  n == null ? "—" : n.toFixed(d);
const workflow = (s: string) => s.replaceAll("_", " ");
function TrainingCurve({ curve }: { curve: any[] }) {
  const rows = curve.filter((r) => r.validation_kl != null);
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.validation_kl)) + 0.03,
    min = Math.min(...rows.map((r) => r.validation_kl)) - 0.03;
  const x = (n: number) => 50 + (n / 600) * 355,
    y = (n: number) => 140 - ((n - min) / (max - min)) * 110;
  return (
    <svg
      className="training-curve"
      viewBox="0 0 440 175"
      role="img"
      aria-label="Validation KL divergence during training, lower is better"
    >
      <line
        x1="50"
        x2="405"
        y1="140"
        y2="140"
        stroke="currentColor"
        opacity=".15"
      />
      {[min, max].map((n) => (
        <text key={n} x="5" y={y(n) + 4}>
          {n.toFixed(2)}
        </text>
      ))}
      <polyline
        points={rows.map((r) => `${x(r.step)},${y(r.validation_kl)}`).join(" ")}
        fill="none"
        stroke="var(--sage)"
        strokeWidth="2"
      />
      {rows.map((r) => (
        <g key={r.step}>
          <circle
            cx={x(r.step)}
            cy={y(r.validation_kl)}
            r="4"
            fill="var(--sage)"
          />
          <text x={x(r.step)} y="160" textAnchor="middle">
            {r.step}
          </text>
        </g>
      ))}
      <text x="205" y="174">
        Training steps
      </text>
    </svg>
  );
}
export function LocalModels({ result: r }: { result: any }) {
  const [model, setModel] = useState("laya-tuned"),
    [group, setGroup] = useState("all"),
    [caseIndex, setCaseIndex] = useState(0),
    [questionIndex, setQuestionIndex] = useState(0),
    [onlyDisagreement, setOnlyDisagreement] = useState(false);
  const rows = useMemo(
    () =>
      (r.cases ?? []).filter(
        (c: any) =>
          (group === "all" || c.workflow === group) &&
          (!onlyDisagreement ||
            c.questions.some((q: any) => {
              const p = q.predictions[model];
              return (
                p &&
                p.indexOf(Math.max(...p)) !==
                  q.target.indexOf(Math.max(...q.target))
              );
            })),
      ),
    [r, group, onlyDisagreement, model],
  );
  const c = rows[caseIndex] ?? rows[0],
    q = c?.questions[questionIndex] ?? c?.questions[0],
    selected = r.models?.find((m: any) => m.id === model),
    before = r.models?.find((m: any) => m.id === "laya-base"),
    after = r.models?.find((m: any) => m.id === "laya-tuned");
  if (!r.models?.length)
    return <Notice>Local model measurements are not available.</Notice>;
  const actualIndex = c ? rows.indexOf(c) : 0,
    train = r.training,
    cm = r.coreml;
  return (
    <div className="local-models">
      <div className="local-overview">
        <div>
          <span className="eyebrow">APPLE SILICON / RECORDED MEASUREMENTS</span>
          <h2>How small can a useful decision model be?</h2>
          <p>
            Three ways to turn text into probabilities: read a language model’s
            next-token scores, score complete option text, or train a dedicated
            decision head. Local inference ran on an Apple M4 Max with 48 GiB of
            memory; the Jev reference used AI Gateway. The website lets you
            inspect these recorded runs.
          </p>
          <p>
            References come from a synthetic teacher. Agreement here measures
            how closely a model matches that teacher, not independently verified
            correctness.
          </p>
        </div>
        <div className="local-summary">
          <Stat label="Held-out cases" value="400" />
          <Stat label="Decisions per model" value="2,000" />
          <Stat
            label="Head fine-tune"
            value={`${pct(before.metrics.accuracy)} → ${pct(after.metrics.accuracy)}`}
          />
          <Stat
            label="Fine-tune + evaluation"
            value={`${(train.training_seconds / 60).toFixed(1)} min`}
          />
        </div>
      </div>
      <div className="local-methods">
        <article>
          <span className="method-number">01 / FIRST TOKEN</span>
          <h3>Shared state, separate questions</h3>
          <p>
            Encode the state once, copy its prompt cache for each question, and
            read the logits for verified single-token labels. This adapts Eric
            Zhang’s approach to MLX. Branches run sequentially here.
          </p>
        </article>
        <article>
          <span className="method-number">02 / OPTION TEXT</span>
          <h3>Score the whole answer</h3>
          <p>
            Read the likelihood of every token in each option. Mean token
            likelihood reduces the automatic preference for short strings.
            Compare it with label scoring on the same Qwen 0.6B weights.
          </p>
        </article>
        <article>
          <span className="method-number">03 / TRAINED HEAD</span>
          <h3>Specialize an encoder</h3>
          <p>
            Port Laya’s encoder and scorer to native MLX, freeze the encoder,
            and train the decision head. Export the selected model to Core ML
            and check real predictions against MLX.
          </p>
        </article>
      </div>
      <Pane
        title="Same test cases, different approaches"
        sub="Click a model to inspect its answers"
      >
        <Notice>
          The trained Laya head improves over its starting checkpoint, but does
          not beat the training-label prior on this test. This demonstrates the
          port and training process; it is not yet a reliable model for
          automatic form filling.
        </Notice>
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th>MODEL / METHOD</th>
                <th>TEACHER AGREEMENT ↑</th>
                <th>SOFT-LABEL KL ↓</th>
                <th>BRIER ↓</th>
                <th>WARM CASE TIME</th>
              </tr>
            </thead>
            <tbody>
              {r.models.map((m: any) => (
                <tr key={m.id} className={model === m.id ? "selected" : ""}>
                  <td>
                    <button
                      onClick={() => {
                        setModel(m.id);
                        setCaseIndex(0);
                      }}
                    >
                      {m.name}
                      <small>{m.kind}</small>
                    </button>
                  </td>
                  <td>
                    {pct(m.metrics.accuracy)}
                    <div className="metric-bar">
                      <motion.i animate={{ width: pct(m.metrics.accuracy) }} />
                    </div>
                  </td>
                  <td>{number(m.metrics.kl)}</td>
                  <td>{number(m.metrics.brier)}</td>
                  <td>
                    {m.case_latency_ms
                      ? `${Math.round(m.case_latency_ms.median)} ms`
                      : m.id === "jev"
                        ? "Network batches"
                        : m.kind.startsWith("Code")
                          ? "No model call"
                          : "Not measured"}
                    {m.case_latency_ms && (
                      <small>p95 {Math.round(m.case_latency_ms.p95)} ms</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">
          Local case time includes one state and five questions, after model
          loading and warm-up. Core ML makes five sequential calls padded to 768
          tokens; MLX uses dynamic padding. Hosted Jev used network batches of
          4–8 cases; its timings are reported separately. Code baselines do not
          run a model.
        </p>
        <Fold title="How to read these measurements">
          <p className="fine">
            Teacher agreement compares the most likely model option with the
            most likely synthetic teacher option. KL measures disagreement with
            the complete soft label distribution; lower is better. Brier is the
            mean squared probability error per option, averaged across
            questions. ECE measures confidence versus teacher agreement in ten
            equal-width bins. Score MAE compares expected ordinal levels. Each
            workflow contributes 100 cases.
          </p>
          <p className="fine">
            API probabilities can contain exact zeros. KL uses the same 1e-12
            floor for every model, so a zero assigned to an option with teacher
            probability can incur a large penalty. Read it alongside Brier and
            agreement.
          </p>
          <p className="fine">
            The tuned head learned from 960 training cases and selected its
            checkpoint and temperature on 240 separate validation cases. None of
            the 400 test cases were used for tuning. Untuned models remain
            general models; the tuned head is a specialist for these four
            workflows.
          </p>
          <p className="fine">
            Single-token probabilities are normalized over only the listed
            options. Full-option scores use mean token log-likelihood, followed
            by a softmax. Neither method guarantees calibrated real-world
            confidence.
          </p>
        </Fold>
      </Pane>
      <div className="training-panels">
        <Pane title="What training changed" sub="Validation only">
          <TrainingCurve curve={train.curve} />
          <p>
            600 steps, 4,800 training decisions, two epochs. The encoder stayed
            frozen. Checkpoint selection minimized validation KL; temperature{" "}
            {train.temperature} was also selected on validation.
          </p>
          <div className="runtime-checks">
            <div>
              <span>Test KL before / after</span>
              <strong>
                {number(before.metrics.kl)} / {number(after.metrics.kl)}
              </strong>
            </div>
            <div>
              <span>Test Brier before / after</span>
              <strong>
                {number(before.metrics.brier)} / {number(after.metrics.brier)}
              </strong>
            </div>
          </div>
        </Pane>
        <Pane
          title="Core ML, checked on real hardware"
          sub={cm?.passed ? "Export evaluated" : "See conversion notes"}
        >
          {cm?.passed ? (
            <>
              <p>
                <Check size={13} /> Float16 package converted and executed
                locally. All {cm.checks.length} initial parity checks chose the
                same option as MLX. Largest probability difference:{" "}
                {Math.max(
                  ...cm.checks.map((x: any) => x.max_probability_error),
                ).toFixed(5)}
                .
              </p>
              <div className="runtime-checks">
                {Object.entries<any>(cm.latency).map(([k, v]) => (
                  <div key={k}>
                    <span>
                      {k === "ALL" ? "Core ML chooses hardware" : "CPU only"}
                    </span>
                    <strong>
                      {Math.round(v.warm_median_ms)} ms / question
                    </strong>
                  </div>
                ))}
                <div>
                  <span>Package size</span>
                  <strong>{(cm.package_bytes / 2 ** 20).toFixed(0)} MiB</strong>
                </div>
              </div>
              {cm.full_test && (
                <p>
                  Across all 2,000 test decisions, the export changed{" "}
                  {cm.full_test.mlx_argmax_differences} argmax choices relative
                  to MLX. Its actual teacher agreement is{" "}
                  {pct(cm.full_test.metrics.accuracy)}; see the separate Core ML
                  row above. The largest probability change across the full test
                  was {pct(cm.full_test.max_probability_error)}. Float16
                  inference is approximate.
                </p>
              )}
              <p>
                One question, padded to 768 tokens and eight option slots. These
                timings use a different workload from the case-time table.
                Neural Engine placement was not measured.
              </p>
            </>
          ) : (
            <p>{cm?.error ?? "Conversion evidence is not attached."}</p>
          )}
          <p>
            MLX performed the training. Core ML is the exported inference
            target. No proprietary Jev weights were used.
          </p>
        </Pane>
      </div>
      <Pane
        title="Inspect every decision"
        sub={`${rows.length} cases`}
        className="model-explorer"
      >
        <div className="model-explorer-controls">
          <label>
            Model
            <select
              aria-label="Inspect model"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setCaseIndex(0);
              }}
            >
              {r.models.map((m: any) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Workflow
            <select
              aria-label="Decision workflow"
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                setCaseIndex(0);
              }}
            >
              <option value="all">All workflows</option>
              {r.workflows.map((w: string) => (
                <option key={w} value={w}>
                  {workflow(w)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={onlyDisagreement}
              onChange={(e) => {
                setOnlyDisagreement(e.target.checked);
                setCaseIndex(0);
              }}
            />{" "}
            Disagrees with teacher
          </label>
        </div>
        {c ? (
          <>
            <div className="model-explorer-controls">
              <Button
                secondary
                aria-label="Previous decision case"
                disabled={actualIndex === 0}
                onClick={() => {
                  setCaseIndex(actualIndex - 1);
                  setQuestionIndex(0);
                }}
              >
                <ArrowLeft size={14} />
              </Button>
              <label>
                Case
                <select
                  aria-label="Decision case"
                  value={actualIndex}
                  onChange={(e) => {
                    setCaseIndex(Number(e.target.value));
                    setQuestionIndex(0);
                  }}
                >
                  {rows.map((x: any, i: number) => (
                    <option key={x.id} value={i}>
                      {i + 1} · {x.id}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                secondary
                aria-label="Next decision case"
                disabled={actualIndex === rows.length - 1}
                onClick={() => {
                  setCaseIndex(actualIndex + 1);
                  setQuestionIndex(0);
                }}
              >
                <ArrowRight size={14} />
              </Button>
            </div>
            <div className="model-evidence">
              <Pane title="The complete state" sub={workflow(c.workflow)}>
                <pre className="case-state">
                  {typeof c.state === "string"
                    ? c.state
                    : JSON.stringify(c.state, null, 2)}
                </pre>
                <p className="source-line">
                  <a href={r.dataset.url}>Typed Decisions</a> · original test ID{" "}
                  <code>{c.id}</code>
                  <br />
                  Revision <code>{r.dataset.revision}</code> ·{" "}
                  {r.dataset.license}
                </p>
              </Pane>
              <Pane title="Question and probabilities">
                <select
                  aria-label="Decision question"
                  value={questionIndex}
                  onChange={(e) => setQuestionIndex(Number(e.target.value))}
                >
                  {c.questions.map((x: any, i: number) => (
                    <option key={x.key} value={i}>
                      {x.key} · {x.type}
                    </option>
                  ))}
                </select>
                <p style={{ fontSize: 13, lineHeight: 1.8 }}>
                  {q.instructions}
                </p>
                <div className="option-comparison">
                  {q.keys.map((key: string, i: number) => (
                    <div key={key}>
                      <h4>
                        {key} · {q.options[i]}
                      </h4>
                      <div className="option-bars">
                        <span>Model</span>
                        <div>
                          <motion.i
                            animate={{ width: pct(q.predictions[model][i]) }}
                          />
                        </div>
                        <span>{pct(q.predictions[model][i])}</span>
                      </div>
                      <div className="option-bars teacher">
                        <span>Teacher</span>
                        <div>
                          <i style={{ width: pct(q.target[i]) }} />
                        </div>
                        <span>{pct(q.target[i])}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Pane>
            </div>
          </>
        ) : (
          <Notice>No cases match this filter.</Notice>
        )}
        <p className="fine">
          Selected model: {selected?.name}. No state, question, or criterion
          text was truncated. Teacher labels average sampled model judgments;
          their uncertainty is visible above.
        </p>
      </Pane>
      <Fold title="Results by workflow">
        <p className="fine">
          {selected?.name}, 100 cases and 500 decisions per workflow.
        </p>
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th>WORKFLOW</th>
                <th>TEACHER AGREEMENT</th>
                <th>KL</th>
                <th>BRIER</th>
              </tr>
            </thead>
            <tbody>
              {r.workflows.map((w: string) => (
                <tr key={w}>
                  <td>{workflow(w)}</td>
                  <td>{pct(selected.by_workflow[w].accuracy)}</td>
                  <td>{number(selected.by_workflow[w].kl)}</td>
                  <td>{number(selected.by_workflow[w].brier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>
      <Fold title="Models, timings, and provenance">
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th>MODEL</th>
                <th>ECE ↓</th>
                <th>SCORE MAE ↓</th>
                <th>PEAK MLX MEMORY</th>
              </tr>
            </thead>
            <tbody>
              {r.models.map((m: any) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{number(m.metrics.ece)}</td>
                  <td>{number(m.metrics.score_mae)}</td>
                  <td>
                    {m.peak_mlx_gib ? `${m.peak_mlx_gib.toFixed(2)} GiB` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.models
          .filter((m: any) => m.url)
          .map((m: any) => (
            <p className="source-line" key={m.id}>
              <a href={m.url}>{m.name}</a> ·{" "}
              <code>
                {m.revision ?? "Hosted service; weights not published"}
              </code>
              <br />
              {m.method}
            </p>
          ))}
        <p className="fine">{r.timing_note}</p>
        <p className="source-line">
          Protocol, scripts, environment, and conversion checks are in{" "}
          <a href="https://github.com/nikhil-vytla/hatch/tree/jev-apple-arcade/jev-experiments/local-models-and-games">
            the research folder
          </a>
          .
        </p>
      </Fold>
    </div>
  );
}
export function ResearchMap({ result: r }: { result: any }) {
  const [tab, setTab] = useState("benchmarks"),
    [filter, setFilter] = useState("All");
  const items = r[tab] ?? [];
  const categories = [
    "All",
    ...new Set<string>(items.map((x: any) => x.category)),
  ];
  return (
    <div>
      <div className="local-overview">
        <div>
          <span className="eyebrow">RESEARCH MAP / NEXT QUESTIONS</span>
          <h2>Give each experiment something to prove.</h2>
          <p>
            Benchmarks test a specific capability. Product experiments test
            whether that capability makes an experience better. Each card
            includes a concrete demo and a way to measure it.
          </p>
        </div>
        <div>
          <Notice>
            These are proposals unless marked Implemented. No scores or
            completed runs are implied.
          </Notice>
        </div>
      </div>
      <div className="research-controls">
        <button
          className={tab === "benchmarks" ? "active" : ""}
          onClick={() => {
            setTab("benchmarks");
            setFilter("All");
          }}
        >
          Benchmark shortlist · {r.benchmarks?.length}
        </button>
        <button
          className={tab === "ideas" ? "active" : ""}
          onClick={() => {
            setTab("ideas");
            setFilter("All");
          }}
        >
          New directions · {r.ideas?.length}
        </button>
        <select
          aria-label="Research category"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="research-grid">
        {items
          .filter((x: any) => filter === "All" || filter === x.category)
          .map((x: any) => (
            <article className="research-card" key={x.name}>
              <small>
                {x.category.toUpperCase()} · {x.status.toUpperCase()}
              </small>
              <h3>{x.name}</h3>
              <p style={{ color: "var(--ink)" }}>{x.question}</p>
              <p className="research-demo">{x.demo}</p>
              <Fold title="Protocol and success criteria">
                <p>{x.protocol}</p>
                <p style={{ marginTop: 12 }}>Measure: {x.measure}</p>
                <p style={{ marginTop: 12 }}>Limits: {x.caveat}</p>
              </Fold>
              {x.url && (
                <p className="source-line">
                  <a href={x.url}>
                    Original source <ArrowUpRight size={11} />
                  </a>
                  {x.experiment && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={`#experiment/${x.experiment}`}>
                        Explore the completed experiment
                      </a>
                    </>
                  )}
                </p>
              )}
            </article>
          ))}
      </div>
      <Pane title="Ideas grounded in working implementations">
        <p className="fine">
          The sgnt.ai post led to a useful method comparison. We checked the
          linked implementations directly. Jev’s private architecture remains
          unknown; similarities in the API do not establish equivalent quality
          or speed.
        </p>
        <div className="source-line">
          {r.sources?.map((s: any) => (
            <p key={s.url}>
              <a href={s.url}>{s.name} ↗</a>
            </p>
          ))}
        </div>
      </Pane>
    </div>
  );
}
