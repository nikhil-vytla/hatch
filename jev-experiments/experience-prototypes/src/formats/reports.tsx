/**
 * The benchmark pages as reports. A benchmark scene already shows its own method, results and
 * limits, so its report is a thin frame: what the page measures, the scene as its results, the
 * data and a citation. The answer key is a toy, so its report carries the tables and intervals
 * and keeps the toy as a companion.
 */
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clusteredAgreement, KEY_MODELS, type Interval, type Key, type Question } from "../../../packages/arena/src/answer-key/model";
import { AnswerKey } from "../answer-key";
import { fetchJson, percent1 as pct } from "../api";
import { RecordDate } from "../receipt";
import { REPO } from "../repo";
import type { SceneIdIn } from "../scenes";
import { Cite } from "./cite";
import { Report } from "./report";


const Source = ({ path, children }: { path: string; children: ReactNode }) => (
  <a href={`${REPO}/${path}`} target="_blank" rel="noreferrer">
    {children}
  </a>
);

/** What each benchmark page measures, said without its results: the headline strip above states those. */
type Scope = { title: string; abstract: (result: any) => ReactNode; data: string; source: { path: string; label: string } };

/** Every report scene but the answer key, which has its own report below. */
const SCOPE: Record<Exclude<SceneIdIn<"report">, "answer-key">, Scope> = {
  "open-decisions": {
    title: "Open decisions",
    abstract: () => (
      <p>
        Small open Qwen models, asked the way SGLang's decision endpoint asks them, answer the benchmarks Jev was
        recorded on: typed decisions, intent recognition, Fool Jev and One box. Each sits next to Jev's recorded answers
        on the same rows, and a model appears on a benchmark only if it answered every row.
      </p>
    ),
    data: "/open-decisions/open-decisions.json",
    source: { path: "packages/arena/open-decisions", label: "The open-model runner and build" },
  },
  judge: {
    title: "JudgeBench",
    abstract: () => (
      <p>
        Jev judges pairs of answers across the full JudgeBench dataset, and the page compares answer order, repeated
        asks and scoring methods.
      </p>
    ),
    data: "/data/judgment-reliability.json",
    source: { path: "judgment-reliability", label: "The study and its recordings" },
  },
  rewardbench2: {
    title: "RewardBench 2",
    abstract: () => (
      <p>
        Jev scores the supplied answers to RewardBench 2's prompts without seeing their preference labels. The page
        checks whether the preferred answer scores highest, across six kinds of judgment.
      </p>
    ),
    data: "/data/rewardbench2.json",
    source: { path: "rewardbench2", label: "The study and its recordings" },
  },
  classify: {
    title: "Intent recognition",
    abstract: () => (
      <p>
        Jev names the intent of real requests from two public datasets, Banking77 and CLINC150, next to a simple
        TF-IDF classifier. The page shows where each is right and the mistakes between.
      </p>
    ),
    data: "/data/classify.json",
    source: { path: "experience-prototypes/results/classify.jsonl.gz", label: "The recorded run (gzipped)" },
  },
  "local-models": {
    title: "Decision models on a Mac",
    abstract: (r) => {
      const cases = r?.cases ?? [];
      const questions = cases.reduce((n: number, c: any) => n + (c.questions?.length ?? 0), 0);

      return (
        <p>
          Small typed readouts trained on a Mac, how they transfer to workflows they weren't trained on, and their Core
          ML exports{cases.length ? `, scored on ${questions.toLocaleString()} questions from ${cases.length} recorded workflow cases` : ""}.
        </p>
      );
    },
    data: "/data/local-models.json",
    source: { path: "local-models-and-games/apple", label: "The study and its recordings" },
  },
};

/** The record's date: the manifest's, else JudgeBench's first recorded judgment, else the open models' first ask. */
function useRecorded(id: string, result: any) {
  const manifest = useContext(RecordDate);
  const [asked, setAsked] = useState<string | null>(null);

  useEffect(() => {
    if (id !== "open-decisions") return;

    let alive = true;

    fetchJson("/open-decisions/open-decisions.json")
      .then((d) => alive && setAsked(d.recorded?.first ?? null))
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [id]);

  return manifest ?? result?.availability?.first_at ?? asked ?? "";
}

function DataLinks({ file, source }: { file: string; source: { path: string; label: string } }) {
  return (
    <ul>
      <li>
        <a href={file} download>
          Download the recorded data ↓
        </a>
      </li>
      <li>
        <Source path={source.path}>{source.label}</Source>, on GitHub
      </li>
    </ul>
  );
}

/** A benchmark scene inside the report frame: scope, the scene as its results, data and a citation. */
export function BenchmarkReport({ id, result, children }: { id: keyof typeof SCOPE; result: any; children: ReactNode }) {
  const scope = SCOPE[id];
  const recorded = useRecorded(id, result);

  return (
    <Report
      abstract={scope.abstract(result)}
      sections={[{ id: "results", title: "Results", content: children }]}
      data={<DataLinks file={scope.data} source={scope.source} />}
      cite={<Cite title={scope.title} scene={id} recorded={recorded} />}
    />
  );
}

const KEYS: { id: string; label: string; key: Key }[] = [
  { id: "teacher", label: "The benchmark's teacher", key: { kind: "teacher" } },
  { id: "consensus", label: "The other models, averaged", key: { kind: "consensus", voters: KEY_MODELS.map((m) => m.id) } },
];

const Cell = ({ i }: { i: Interval }) => (
  <>
    {pct(i.estimate)}{" "}
    <small>
      ({pct(i.low)}–{pct(i.high)})
    </small>
  </>
);

/** Who wrote the answer key? as a report: method, a table with clustered intervals, limits, and the toy. */
export function AnswerKeyReport({ result }: { result: any }) {
  const recorded = useContext(RecordDate) ?? "";
  const cases: Question[][] = useMemo(() => (result?.cases ?? []).map((c: any) => c.questions), [result]);
  const questions = cases.reduce((n, c) => n + c.length, 0);
  const table = useMemo(
    () =>
      KEY_MODELS.map((m) => ({ ...m, intervals: KEYS.map((k) => clusteredAgreement(cases, k.key, m.id)) })).sort(
        (a, b) => b.intervals[0].estimate - a.intervals[0].estimate,
      ),
    [cases],
  );

  return (
    <Report
      abstract={
        <p>
          Five models answered the same {questions.toLocaleString()} workflow questions from {cases.length} cases. We
          grade them against two answer keys, the benchmark's teacher and the other models averaged, and give each
          model's agreement with a 95% interval. The answers never change; only the key does.
        </p>
      }
      sections={[
        {
          id: "method",
          title: "Method",
          content: (
            <ul>
              <li>The teacher key is the dataset's own answers: the mean of three samples from a roughly 4B-class teacher model.</li>
              <li>The averaged key grades each model against the mean of the other four models' probabilities, so a model never votes on itself.</li>
              <li>Agreement is the share of questions where the model's top answer is the key's top answer.</li>
              <li>
                Questions about the same case share its state, so they aren't independent. The interval treats each case
                as a cluster (a cluster-robust interval for the share), which is wider than counting questions alone.
              </li>
            </ul>
          ),
        },
        {
          id: "results",
          title: "Results",
          content: (
            <>
              <div className="fmt-table-wrap">
                <table className="fmt-table">
                  <caption className="fmt-fine">
                    Agreement with each key. 95% interval, clustered by case, computed in your browser from the recorded
                    answers.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      {KEYS.map((k) => (
                        <th scope="col" key={k.id}>
                          {k.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.map((m) => (
                      <tr key={m.id}>
                        <th scope="row">{m.name}</th>
                        {m.intervals.map((i, n) => (
                          <td key={KEYS[n].id}>
                            <Cell i={i} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ),
        },
        {
          id: "limits",
          title: "Limits",
          content: (
            <ul>
              <li>Neither key is correctness. The teacher is a small model too.</li>
              <li>The averaged key's voters are the five models on this page, so it partly measures how much a model resembles them.</li>
              <li>All the questions come from one benchmark, Typed Decisions, so the ranking says nothing about other tasks.</li>
            </ul>
          ),
        },
        {
          id: "companion",
          title: "Try it: change the key",
          content: (
            <div className="fmt-companion">
              <AnswerKey result={result} />
            </div>
          ),
        },
      ]}
      data={
        <DataLinks
          file="/data/local-models.json"
          source={{ path: "packages/arena/src/answer-key/model.ts", label: "The grading and interval code" }}
        />
      }
      cite={<Cite title="Who wrote the answer key?" scene="answer-key" recorded={recorded} />}
    />
  );
}
