import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, X, Eye, Search } from "lucide-react";
import {
  Pane,
  Field,
  Button,
  Pills,
  Stat,
  State,
  Bars,
  Availability,
  Notice,
  Fold,
} from "./shared";
import { pretty, percent } from "./api";
import { ContentReview } from "./provenance";
export function Benchmarks({ id, result }: { id: string; result: any }) {
  const [dataset, setDataset] = useState("banking77"),
    [index, setIndex] = useState(0),
    [filter, setFilter] = useState("All results"),
    [reveal, setReveal] = useState(false),
    [picked, setPicked] = useState<string | null>(null),
    [query, setQuery] = useState("");
  const all =
    id === "classify"
      ? (result.experiments?.[dataset]?.rows ?? [])
      : (result.rows ?? []);
  const rows = all.filter(
    (r: any) =>
      !r.error &&
      (filter !== "Mistakes" || r.prediction !== r.target) &&
      (!query ||
        JSON.stringify([r.text, r.question, r.prompt, r.target])
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const row = rows[Math.min(index, rows.length - 1)];
  const metric =
    id === "classify" ? result.experiments?.[dataset]?.jev : result.metrics;
  const description =
    id === "judge"
      ? "Two answers to the same question. Which one is more correct? The dataset supplies the expected answer; Jev evaluates both orders."
      : id === "language"
        ? "A local Qwen model wrote four alternatives. Jev selected one. IFEval checks explicit instructions such as word counts and required phrases in code. These checks do not measure every aspect of good writing."
        : result.description;
  function move(n: number) {
    setIndex(Math.max(0, Math.min(rows.length - 1, n)));
    setReveal(false);
    setPicked(null);
  }
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane
          title={
            id === "judge"
              ? "Read it. Judge it. Compare."
              : id === "language"
                ? "The writer’s alternatives"
                : "The actual test cases"
          }
        >
          <p className="lead-small">{description}</p>
          <div className="case-toolbar">
            {id === "classify" && (
              <Pills
                values={["banking77", "clinc150"]}
                value={dataset}
                onChange={(v) => {
                  setDataset(v);
                  move(0);
                }}
              />
            )}
            {id !== "language" && (
              <Pills
                values={["All results", "Mistakes"]}
                value={filter}
                onChange={(v) => {
                  setFilter(v);
                  move(0);
                }}
              />
            )}
            <label className="case-search">
              <Search size={14} />
              <input
                placeholder="Search the examples"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  move(0);
                }}
              />
            </label>
          </div>
          <div className="case-navigation">
            <button
              aria-label="Previous example"
              onClick={() => move(index - 1)}
              disabled={!index}
            >
              <ArrowLeft size={17} />
            </button>
            <span>
              Example {rows.length ? Math.min(index + 1, rows.length) : 0} of{" "}
              {rows.length}
            </span>
            <button
              aria-label="Next example"
              onClick={() => move(index + 1)}
              disabled={index >= rows.length - 1}
            >
              <ArrowRight size={17} />
            </button>
          </div>
          {row ? (
            <ContentReview
              key={`${id}:${dataset}:${all.indexOf(row)}`}
              notice={row.content_notice}
            >
              <div className="question-card">
                <span className="eyebrow">
                  {id === "judge" ? "THE QUESTION" : "THE REQUEST"}
                </span>
                <p>{row.question ?? row.prompt ?? row.text ?? row.case}</p>
                {row.variant && (
                  <span className="badge">
                    Intervention: {pretty(row.variant)}
                  </span>
                )}
              </div>
              {id === "judge" ? (
                <>
                  <div className="answer-pair">
                    {["A", "B"].map((letter) => (
                      <div
                        className={
                          "answer-card " +
                          (picked === letter ? "picked" : "") +
                          (reveal && row.target === letter ? " correct" : "")
                        }
                        key={letter}
                      >
                        <div className="answer-top">
                          <strong>Answer {letter}</strong>
                          {reveal && (
                            <span className="badge">
                              {row.target === letter
                                ? "Dataset winner"
                                : row.prediction === letter
                                  ? "Jev selected"
                                  : "Alternative"}
                            </span>
                          )}
                        </div>
                        <div className="candidate-text">
                          {row[letter === "A" ? "candidate_a" : "candidate_b"]}
                        </div>
                        <Button
                          secondary
                          onClick={() => {
                            setPicked(letter);
                            setReveal(true);
                          }}
                        >
                          I would choose {letter}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button secondary onClick={() => setReveal(!reveal)}>
                    <Eye size={15} />
                    {reveal ? "Hide the judgments" : "Reveal the judgments"}
                  </Button>
                  {reveal && (
                    <div className="stats-row">
                      <Stat
                        label="Your choice"
                        value={picked ?? "Not selected"}
                      />
                      <Stat label="Jev selected" value={row.prediction} />
                      <Stat label="Dataset winner" value={row.target} />
                    </div>
                  )}
                </>
              ) : id === "language" ? (
                <div className="writer-candidates">
                  {row.selection_error && (
                    <Notice>
                      These writer candidates completed, but Jev’s selection was
                      unavailable for this case.
                    </Notice>
                  )}
                  {(row.candidates ?? []).map((text: string, i: number) => (
                    <article
                      className={
                        "answer-card " + (row.selected === i ? "picked" : "")
                      }
                      key={i}
                    >
                      <div className="answer-top">
                        <strong>Candidate {i + 1}</strong>
                        {row.checks?.[i] && (
                          <span className="badge">
                            Executable checks:{" "}
                            {row.checks[i].strict ? "pass" : "fail"}
                          </span>
                        )}
                        {row.selected === i && (
                          <span className="badge sage">Jev’s selection</span>
                        )}
                      </div>
                      <div className="candidate-text">{text}</div>
                    </article>
                  ))}
                  {row.reference?.text && (
                    <article className="answer-card">
                      <strong>Reference model</strong>
                      <div className="candidate-text">{row.reference.text}</div>
                    </article>
                  )}
                </div>
              ) : (
                <div className="label-comparison">
                  <div>
                    <span>Jev’s judgment</span>
                    <strong>{pretty(row.prediction)}</strong>
                  </div>
                  <span
                    className={
                      "match-icon " +
                      (row.prediction === row.target ? "yes" : "no")
                    }
                  >
                    {row.prediction === row.target ? <Check /> : <X />}
                  </span>
                  <div>
                    <span>Expected intent</span>
                    <strong>{pretty(row.target)}</strong>
                  </div>
                </div>
              )}
              <Fold title="Source and case details">
                <p>
                  Case: {row.id ?? row.pair_id}.{" "}
                  {row.source && `Source: ${row.source}.`}{" "}
                  {row.response_model &&
                    `Answers generated by ${row.response_model}.`}
                </p>
                {result.source_url && (
                  <a href={result.source_url} target="_blank" rel="noreferrer">
                    Pinned dataset and methodology ↗
                  </a>
                )}
                <State title="Full case record" value={row} />
              </Fold>
            </ContentReview>
          ) : (
            <Notice>No completed examples match this filter.</Notice>
          )}
        </Pane>
      </div>
      <aside className="controls">
        <Pane title="What the numbers mean">
          {metric && (
            <>
              <Stat
                label="Accuracy on returned answers"
                value={percent(metric.accuracy_answered ?? 0)}
                note="How often a completed judgment matched the expected answer."
              />
              <Stat
                label="Cases with a result"
                value={`${metric.answered} / ${metric.attempted}`}
                note="Unanswered requests are availability failures, not incorrect model judgments."
              />
            </>
          )}
          {id === "judge" && (
            <Stat
              label="Order disagreement"
              value={percent(result.order_disagreement_rate ?? 0)}
              note="Among pairs answered in both orders, how often the preferred answer changed."
            />
          )}
          {id === "language" && (
            <>
              <Stat
                label="First candidate passes"
                value={percent(
                  result.summary?.baseline_strict_all_attempted ?? 0,
                )}
              />
              <Stat
                label="Jev-selected candidate passes"
                value={percent(
                  result.summary?.jev_selected_strict_all_attempted ?? 0,
                )}
              />
              <Stat
                label="A passing candidate existed"
                value={percent(result.summary?.best_of_four_oracle_strict ?? 0)}
                note="The best possible selection from these same four candidates."
              />
            </>
          )}
          {row?.probabilities && (id !== "judge" || reveal) && (
            <>
              <h4>Model probabilities</h4>
              <Bars
                values={
                  Object.fromEntries(
                    Object.entries(row.probabilities)
                      .sort((a: any, b: any) => b[1] - a[1])
                      .slice(0, 6),
                  ) as Record<string, number>
                }
                selected={row.prediction}
              />
              <p className="fine">
                Probabilities are model outputs, not guarantees.
              </p>
            </>
          )}
          <Availability rows={all} result={result} />
        </Pane>
      </aside>
    </div>
  );
}
function Curve({
  series,
  labels,
}: {
  series: { name: string; color: string; values: number[] }[];
  labels: string[];
}) {
  const width = 640,
    height = 250,
    left = 42,
    top = 16,
    w = width - left - 20,
    h = height - top - 32;
  return (
    <div className="curve">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={series.map((s) => s.name).join(" compared with ")}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((n) => (
          <g key={n}>
            <line
              x1={left}
              y1={top + (1 - n) * h}
              x2={width - 12}
              y2={top + (1 - n) * h}
              stroke="var(--line)"
            />
            <text
              x={left - 8}
              y={top + (1 - n) * h + 4}
              textAnchor="end"
              fill="var(--muted)"
              fontSize="10"
            >
              {Math.round(n * 100)}%
            </text>
          </g>
        ))}
        {series.map((s) => (
          <motion.path
            key={s.name}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1 }}
            d={s.values
              .map(
                (v, i) =>
                  `${i ? "L" : "M"}${left + (i / Math.max(1, s.values.length - 1)) * w} ${top + (1 - v) * h}`,
              )
              .join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth="3"
          />
        ))}
        {labels
          .filter(
            (_, i) =>
              i === 0 ||
              i === labels.length - 1 ||
              i === Math.floor(labels.length / 2),
          )
          .map((l, i) => (
            <text
              x={left + (i * w) / 2}
              y={height - 5}
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              fill="var(--muted)"
              fontSize="10"
              key={i}
            >
              {l}
            </text>
          ))}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
export function Learning({ id, result }: { id: string; result: any }) {
  const [step, setStep] = useState(0);
  let content: any;
  let text = "";
  if (id === "reward") {
    const curve = result.curve ?? [];
    content = (
      <>
        <Curve
          labels={curve.map((r: any) => `${r.step} updates`)}
          series={[
            {
              name: "Reward on training examples",
              color: "var(--coral)",
              values: curve.map((r: any) => r.mean_teacher_reward),
            },
            {
              name: "Accuracy on independent test cases",
              color: "var(--sage)",
              values: curve.map((r: any) => r.oracle_test_accuracy),
            },
          ]}
        />
        <div className="stats-row">
          <Stat label="Training examples" value={result.train_size} />
          <Stat label="Held-out examples" value={result.test_size} />
          <Stat
            label="Final test accuracy"
            value={percent(curve.at(-1)?.oracle_test_accuracy ?? 0)}
          />
        </div>
      </>
    );
    text =
      "The orange curve is the reward the policy is trained to maximize. The green curve asks whether it picks the correct drink on unseen examples. Their divergence is the interesting result. This pilot trains a linear policy, not a language model.";
  } else if (id === "teach") {
    const entries = Object.entries(result.methods ?? {}) as [string, any][];
    content = (
      <Curve
        labels={(entries[0]?.[1].curve ?? []).map(
          (r: any) => `${r.attempted_labels} labels`,
        )}
        series={entries.map(([name, m], i) => ({
          name:
            name === "random" ? "Random examples" : "Uncertain examples first",
          color: i ? "var(--sage)" : "var(--coral)",
          values: m.curve.map((r: any) => r.accuracy ?? 0),
        }))}
      />
    );
    text =
      "Both strategies get the same attempted label budget. One picks examples at random; the other asks about examples its current student finds uncertain. These small authored fixtures did not show an advantage for uncertainty sampling.";
  } else if (id === "replica") {
    content = (
      <div className="replica-comparison">
        {["choice", "noul", "score"].map((k) => (
          <Pane
            key={k}
            title={
              k === "noul"
                ? "Yes / no"
                : k === "score"
                  ? "Ordered scores"
                  : "Choose an intent"
            }
          >
            <div className="stats-row">
              <Stat
                label="Before training"
                value={percent(result.before?.[k]?.accuracy ?? 0)}
              />
              <Stat
                label="After training"
                value={percent(result.after?.[k]?.accuracy ?? 0)}
              />
            </div>
            <Bars
              values={{
                before: result.before?.[k]?.accuracy ?? 0,
                after: result.after?.[k]?.accuracy ?? 0,
              }}
            />
          </Pane>
        ))}
      </div>
    );
    text =
      "A SmolLM2-360M model received actual parameter updates. Choosing an intent improved; the binary task did not. The three tasks must be assessed separately. This version learns from labeled data rather than distilling Jev’s outputs.";
  } else if (id === "optimize") {
    const methods = Object.entries(result.methods ?? {}) as [string, any][];
    content = (
      <>
        <div className="stats-row">
          {methods.map(([n, m]) => (
            <Stat
              key={n}
              label={pretty(n)}
              value={percent(
                m.test_accuracy ??
                  m.test?.accuracy_all_attempted ??
                  m.validation_accuracy ??
                  0,
              )}
              note="Accuracy on 50 held-out test cases. Validation scores appear with each candidate below."
            />
          ))}
        </div>
        {methods.map(([name, m]) => (
          <Fold key={name} title={`${pretty(name)}: candidate prompts`}>
            <div className="prompt-history">
              {m.history?.map((h: any, i: number) => (
                <article key={i}>
                  <span className="badge">
                    Candidate {i + 1} · validation{" "}
                    {percent(h.validation_accuracy ?? h.accuracy ?? 0)}
                  </span>
                  <p>{h.prompt}</p>
                </article>
              ))}
            </div>
          </Fold>
        ))}
      </>
    );
    text =
      "The optimizer proposes changes to the instructions and evaluates them on validation examples. Final held-out results test whether those changes generalize. A higher validation score alone is not an improvement.";
  } else {
    content = (
      <div className="latency-chart">
        {(result.groups ?? []).map((g: any, i: number) => (
          <div className="latency-group" key={i}>
            <span>
              {g.state_words.toLocaleString()} words · {g.questions} questions
            </span>
            <div>
              <motion.i
                initial={{ width: 0 }}
                animate={{ width: Math.min(100, g.p50_ms / 15) + "%" }}
              />
            </div>
            <strong>{Math.round(g.p50_ms)} ms</strong>
            <small>
              p95 {Math.round(g.p95_ms)} ms · {g.answered}/{g.attempted} results
            </small>
          </div>
        ))}
      </div>
    );
    text =
      "The median is the middle request’s duration. The 95th percentile shows a slower end of the experience. These recorded timings include waiting and retries, so they describe this run rather than a pure model-speed measurement.";
  }
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pane
          title={
            id === "reward"
              ? "Learning to score well. Learning to do well."
              : "Follow the experiment"
          }
        >
          <p className="lead-small">{text}</p>
          {content}
        </Pane>
        {id === "teach" && (
          <Pane title="Examples the teacher labeled">
            {(result.teacher_rows ?? [])
              .slice(step, step + 8)
              .map((r: any, i: number) => (
                <div className="example-row" key={i}>
                  <p>{r.text}</p>
                  <span className="badge">Expected: {pretty(r.target)}</span>
                  <span className="badge">Jev: {pretty(r.answer?.value)}</span>
                </div>
              ))}
            <Button
              secondary
              onClick={() =>
                setStep((s) => (s + 8) % (result.teacher_rows?.length ?? 8))
              }
            >
              More examples
            </Button>
          </Pane>
        )}
      </div>
      <aside className="controls">
        <Pane title="How to read this result">
          <p>{text}</p>
          {result.note && <p className="fine">{result.note}</p>}
          {result.limitations && (
            <ul>
              {result.limitations.map((s: string) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <State title="Recorded methods and measurements" value={result} />
        </Pane>
      </aside>
    </div>
  );
}
