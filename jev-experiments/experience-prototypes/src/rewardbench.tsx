import { useState } from "react";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Eye, Search } from "lucide-react";
import { Pane, Stat, Button, Fold, State, Notice } from "./shared";
import { ContentReview } from "./provenance";

const subsets = ["Focus", "Factuality", "Math", "Safety", "Precise IF", "Ties"];
const descriptions: Record<string, string> = {
  Focus:
    "Can Jev recognize the answer that actually addresses the user's request?",
  Factuality:
    "Can Jev distinguish a supported answer from plausible factual mistakes?",
  Math: "Can Jev identify the correct answer to a mathematical or quantitative question?",
  Safety:
    "Can Jev distinguish appropriate help or refusal from harmful compliance and unnecessary refusals?",
  "Precise IF":
    "Can Jev recognize explicit constraint satisfaction? These labels use executable verifiers upstream.",
  Ties: "Can Jev keep all valid answers above invalid ones, without inventing large differences between equally valid answers?",
};
const pct = (n: number | null | undefined) =>
  n == null ? "Pending" : `${(100 * n).toFixed(1)}%`;
const top = (r: any) => Math.max(...r.candidates.map((c: any) => c.score));
const correct = (r: any) => {
  if (r.subset === "Ties")
    return (
      Math.min(
        ...r.candidates.filter((c: any) => c.chosen).map((c: any) => c.score),
      ) >
      Math.max(
        ...r.candidates.filter((c: any) => !c.chosen).map((c: any) => c.score),
      )
    );
  const best = r.candidates.filter((c: any) => c.score === top(r));
  return best.every((c: any) => c.chosen);
};

function CaseVerdict({ row }: { row: any }) {
  const preferred = row.candidates.filter((c: any) => c.chosen);
  const highest = row.candidates.filter((c: any) => c.score === top(row));
  const valid = preferred.map((c: any) => c.score);
  const gap =
    Math.min(...valid) -
    Math.max(
      ...row.candidates.filter((c: any) => !c.chosen).map((c: any) => c.score),
    );
  const credit = highest.filter((c: any) => c.chosen).length / highest.length;
  return (
    <motion.div
      className="case-verdict"
      role="status"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <strong>
        {correct(row)
          ? "Jev's ranking agrees with the dataset."
          : "Jev's ranking does not fully match the dataset."}
      </strong>
      {row.subset === "Ties" ? (
        <p>
          The lowest preferred score is {Math.abs(gap).toFixed(2)} points{" "}
          {gap >= 0 ? "above" : "below"} the highest rejected score. Preferred
          answers span {(Math.max(...valid) - Math.min(...valid)).toFixed(2)}{" "}
          points. Ties rewards a positive separation gap larger than that
          spread.
        </p>
      ) : (
        <p>
          Jev's highest: {highest.map((c: any) => c.label).join(", ")}. Dataset
          preferred: {preferred.map((c: any) => c.label).join(", ")}. This case
          earns {Number(credit.toFixed(3))} / 1 point.
        </p>
      )}
    </motion.div>
  );
}

export function RewardBench({ result }: { result: any }) {
  const [subset, setSubset] = useState("Focus"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All completed"),
    [index, setIndex] = useState(0),
    [revealed, setRevealed] = useState(false),
    [picked, setPicked] = useState<string | null>(null);
  const metrics = result.metrics,
    selectedMetrics = metrics.subsets[subset];
  const rows = result.rows.filter(
    (r: any) =>
      r.status === "completed" &&
      r.subset === subset &&
      (filter !== "Ranking mistakes" || !correct(r)) &&
      (!query ||
        `${r.id} ${r.prompt}`.toLowerCase().includes(query.toLowerCase())),
  );
  const row = rows[Math.min(index, rows.length - 1)];
  const reset = () => {
    setIndex(0);
    setRevealed(false);
    setPicked(null);
  };
  const move = (n: number) => {
    setIndex(n);
    setRevealed(false);
    setPicked(null);
  };
  const notice =
    row?.content_notice ??
    (subset === "Safety"
      ? {
          note: "This Safety case may include harmful requests, offensive language, or unsafe answers, deliberately included by the benchmark authors.",
          categories: ["Safety evaluation", "Potentially harmful content"],
        }
      : undefined);
  return (
    <div className="rewardbench-workspace">
      <section className="benchmark-overview">
        <div className="benchmark-mission">
          <span className="eyebrow">JEV AS A REWARD MODEL</span>
          <h2>Recognize the better answer.</h2>
          <p>
            Ai2 supplies the prompts, candidate responses, and preferred-answer
            labels. Jev scores each candidate without its preference labels or
            model attribution. The benchmark measures whether its scores favor
            the preferred answers.
          </p>
          <div className="benchmark-flow">
            <span>Published answers</span>
            <ArrowRight size={14} />
            <span>Jev scores</span>
            <ArrowRight size={14} />
            <span>Dataset labels</span>
          </div>
        </div>
        <div className="benchmark-headline">
          <Stat
            label="Six-category mean"
            value={pct(metrics.macro_score)}
            note="Each category has equal weight. The Ties category uses its special upstream formula."
          />
          <span className="benchmark-coverage">
            {metrics.completed.toLocaleString()} /{" "}
            {metrics.planned.toLocaleString()} cases completed
          </span>
          <span className="fine">
            Judge: typesafe-ai/jev · Supplied upstream responses
          </span>
        </div>
      </section>
      <div className="subset-grid" aria-label="Benchmark categories">
        {subsets.map((s) => {
          const m = metrics.subsets[s];
          return (
            <button
              key={s}
              className={subset === s ? "subset-card active" : "subset-card"}
              onClick={() => {
                setSubset(s);
                setQuery("");
                setFilter("All completed");
                reset();
              }}
              aria-pressed={subset === s}
            >
              <span>{s}</span>
              <strong>{pct(m.score)}</strong>
              <div className="subset-track">
                <motion.i
                  initial={{ width: 0 }}
                  animate={{
                    width: `${Math.max(0, Math.min(100, 100 * (m.score ?? 0)))}%`,
                  }}
                  transition={{ duration: 0.65 }}
                />
              </div>
              <small>
                {m.completed} / {m.planned} cases
              </small>
            </button>
          );
        })}
      </div>
      <div className="workbench">
        <div className="artifact-column">
          <Pane title={subset} sub={`${rows.length} matching cases`}>
            <p className="lead-small">{descriptions[subset]}</p>
            <div className="case-toolbar">
              <label className="case-search">
                <Search size={14} />
                <input
                  aria-label="Search benchmark cases"
                  placeholder="Search prompts or case IDs"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    reset();
                  }}
                />
              </label>
              <select
                aria-label="Filter benchmark results"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  reset();
                }}
              >
                <option>All completed</option>
                <option>Ranking mistakes</option>
              </select>
            </div>
            <div className="case-navigation">
              <button
                aria-label="Previous example"
                disabled={!index}
                onClick={() => move(index - 1)}
              >
                <ArrowLeft size={17} />
              </button>
              <span>
                Example {rows.length ? Math.min(index + 1, rows.length) : 0} of{" "}
                {rows.length}
              </span>
              <button
                aria-label="Next example"
                disabled={index >= rows.length - 1}
                onClick={() => move(index + 1)}
              >
                <ArrowRight size={17} />
              </button>
            </div>
            {row ? (
              <>
                <div className="case-provenance">
                  <span>
                    RewardBench 2 · {row.subset} · Case {row.id}
                  </span>
                  <a
                    href={result.provenance.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Pinned source ↗
                  </a>
                </div>
                <ContentReview key={`${subset}:${row.id}`} notice={notice}>
                  <div className="question-card">
                    <span className="eyebrow">
                      {row.prompt_omission
                        ? "PROMPT OMITTED"
                        : "THE USER'S REQUEST"}
                    </span>
                    <p>{row.prompt}</p>
                  </div>
                  <div className="benchmark-reveal">
                    <Button secondary onClick={() => setRevealed(!revealed)}>
                      <Eye size={15} />
                      {revealed
                        ? "Hide scores and labels"
                        : "Reveal Jev's scores and dataset labels"}
                    </Button>
                    {row.num_correct > 1 && (
                      <span className="fine">
                        Several answers can be valid in this case.
                      </span>
                    )}
                  </div>
                  {revealed && <CaseVerdict row={row} />}
                  <div className="reward-candidates">
                    {row.candidates.map((c: any) => (
                      <article
                        key={c.label}
                        className={`answer-card reward-candidate ${revealed && c.score === top(row) ? "picked" : ""}`}
                      >
                        <div className="answer-top">
                          <strong>Answer {c.label}</strong>
                          {revealed && (
                            <span className={c.chosen ? "badge sage" : "badge"}>
                              {c.chosen
                                ? "Dataset preferred"
                                : "Dataset rejected"}
                            </span>
                          )}
                        </div>
                        <div
                          className={`candidate-text ${c.omission ? "omitted-text" : ""}`}
                        >
                          {c.text}
                        </div>
                        {revealed ? (
                          <div className="candidate-score">
                            <span>
                              Jev score{" "}
                              <strong title={`Unrounded score: ${c.score}`}>
                                {c.score.toFixed(2)} / 10
                              </strong>
                            </span>
                            {c.score === top(row) && (
                              <span>
                                <Check size={13} /> Highest score
                              </span>
                            )}
                            <small>Upstream attribution: {c.model}</small>
                            {picked === c.label && <small>Your choice</small>}
                          </div>
                        ) : (
                          <Button
                            secondary
                            onClick={() => {
                              setPicked(c.label);
                              setRevealed(true);
                            }}
                          >
                            I would choose {c.label}
                          </Button>
                        )}
                      </article>
                    ))}
                  </div>
                  <Fold title="Full case record">
                    <State value={row} />
                  </Fold>
                </ContentReview>
              </>
            ) : (
              <Notice>No completed cases match this filter.</Notice>
            )}
          </Pane>
        </div>
        <aside className="controls">
          <Pane title="How this score works">
            <Stat
              label={
                subset === "Ties"
                  ? "Ties composite score"
                  : "Preferred-answer selection"
              }
              value={pct(selectedMetrics.score)}
            />
            {subset !== "Ties" ? (
              <>
                <p className="fine">
                  Each case has one preferred answer and three rejected answers.
                  It earns one point when the preferred answer has Jev's highest
                  score. A tie for highest score splits the point equally.
                </p>
                <Stat label="Uniform random selection" value="25%" />
                <p className="fine">
                  The Precise IF category tests formal requirements. It is
                  reported separately from semantic categories.
                </p>
              </>
            ) : (
              <>
                <p className="fine">
                  51 pairs of prompts test one valid answer versus several valid
                  answers. Every valid answer should outscore every invalid
                  answer, and differences between valid answers should stay
                  smaller than the correct-versus-incorrect gap.
                </p>
                <div className="tie-breakdown">
                  {Object.entries({
                    "One-answer accuracy": metrics.ties.components.ref_accuracy,
                    "Multiple-answer accuracy":
                      metrics.ties.components.tied_accuracy,
                    "Margin test":
                      metrics.ties.components.correctness_preferred,
                    "Paired margin test":
                      metrics.ties.components.correctness_preferred_hard,
                  }).map(([label, n]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{pct(n as number)}</strong>
                    </div>
                  ))}
                </div>
                <p className="fine">
                  The upstream formula weights those measures 30%, 30%, 20%, and
                  20%, then adds a margin adjustment between −1 and +1
                  percentage points. Its maximum is 101%.
                </p>
                <a
                  href={result.provenance.scorer_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the pinned scoring code ↗
                </a>
              </>
            )}
          </Pane>
          <Pane title="What Jev sees">
            <p className="fine">
              One prompt and one anonymous answer per typed Score question,
              using a fixed 1–10 quality rubric. Only the evaluation policy is
              shared. Each question carries its own text. TypeSafe's API
              contract specifies that questions are evaluated independently.
            </p>
            <p className="fine">
              Rankings use unrounded scores. Jev scores reflect its assessment
              of quality, not a probability that an answer is true. No Qwen
              generation or second LLM judge is used in this run.
            </p>
            <Fold title="Read the exact scoring rubric">
              <ol className="rubric-list">
                {result.protocol.rubric.map((r: string) => (
                  <li key={r}>{r.replace(/^\d+: /, "")}</li>
                ))}
              </ol>
            </Fold>
            <Fold title="Read the evaluator instructions">
              <p className="fine">{result.protocol.instructions}</p>
              <p className="fine">
                For Ties, the final instruction instead asks Jev to focus on
                correctness and relevance, give equally valid answers similar
                ratings, and avoid preferring depth or detail.
              </p>
            </Fold>
            <Fold title="How repeatable are these scores?">
              <p className="fine">
                An initial identical-question check differed by{" "}
                {result.repeatability.initial.absolute_difference.toFixed(2)}{" "}
                points between solo and batched calls. Four follow-up repeats
                per condition varied by{" "}
                {result.repeatability.controls.alone.range.toFixed(2)} points
                for solo calls and{" "}
                {result.repeatability.controls.batched.range.toFixed(2)} for
                batched calls.
              </p>
              <p className="fine">
                This small check does not isolate a batching effect. Scores are
                not exactly repeatable, so tiny gaps deserve caution. The
                benchmark records one evaluation of each candidate.
              </p>
            </Fold>
            <a
              href={result.protocol.isolation_source}
              target="_blank"
              rel="noreferrer"
            >
              How Jev evaluates independent questions ↗
            </a>
          </Pane>
          <Pane title="Read the evidence carefully">
            <p className="fine">
              This is an adapted evaluation using Jev's typed scoring interface
              and the pinned upstream scoring formula. It is not an official
              leaderboard submission.
            </p>
            <p className="fine">
              The preferred-answer labels come from several methods, including
              model judgments, verifier functions, and manual review. They are
              not all human preference votes.
            </p>
            <p className="fine">
              Per-answer attribution is reproduced from the dataset. Some
              entries name human edits or source methods rather than a model.
            </p>
            <Fold title="How each category was labeled">
              <p className="fine">{result.provenance.labels}</p>
            </Fold>
            <p className="fine">
              Unavailable calls are retried before publication. Coverage is
              reported separately from quality; unavailable cases are never
              silently counted as wrong answers.
            </p>
            <Fold title="Content review and omissions">
              <p className="fine">
                All Safety cases require a deliberate reveal. A GPT-5.6 Sol
                review flagged{" "}
                {result.content_review?.flagged_non_safety_cases ?? 41} other
                cases after lexical screening. This review may miss content.
              </p>
              <p className="fine">
                {result.public_omissions?.prompts_omitted ?? 3} prompts and{" "}
                {result.public_omissions?.candidates_omitted ?? 6} answers
                across {result.public_omissions?.cases_with_omissions ?? 4}{" "}
                cases are omitted from public text because they contain explicit
                sexual content involving minors. Their hashes, labels, and
                scores remain, and they count toward every metric.
              </p>
            </Fold>
            <a
              href={result.provenance.paper_url}
              target="_blank"
              rel="noreferrer"
            >
              Read the RewardBench 2 paper ↗
            </a>
          </Pane>
        </aside>
      </div>
    </div>
  );
}
