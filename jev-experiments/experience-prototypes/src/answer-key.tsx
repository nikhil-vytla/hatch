/**
 * Who wrote the answer key? Five models answered the same 2,000 Typed Decisions questions.
 * Grade them against the benchmark's teacher, against the other models' averaged answers, or
 * against one model's answers, and watch the ranking move while nobody's answers change.
 */
import { useMemo, useState } from "react";
import { rank, type Key, type Question } from "../../packages/arena/src/answer-key/model";
import { Receipt } from "./receipt";
import { Pane, Pills } from "./shared";

/** One model per family, so the consensus doesn't count Laya three times. */
const MODELS: { id: string; name: string }[] = [
  { id: "jev", name: "Jev" },
  { id: "Qwen3-4B-Instruct-2507-4bit", name: "Qwen3-4B" },
  { id: "laya-tuned", name: "Laya (fine-tuned)" },
  { id: "Qwen3-0.6B-4bit", name: "Qwen3-0.6B" },
  { id: "SmolLM2-360M-Instruct", name: "SmolLM2-360M" },
];

const KEYS: { label: string; key: Key; about: string }[] = [
  {
    label: "The benchmark's teacher",
    key: { kind: "teacher" },
    about:
      "The dataset's own answers: the mean of three samples from a roughly 4B-class teacher model. This is how the benchmark and the study above score.",
  },
  {
    label: "The other models, averaged",
    key: { kind: "consensus", voters: MODELS.map((m) => m.id) },
    about:
      "Each model is graded against the average of the other four models' probabilities. TypeSafe's workflow evals build their key this way from two frontier models; here the voters are the models on this page.",
  },
  { label: "Jev's answers", key: { kind: "model", model: "jev" }, about: "Jev's own top answers as the key; Jev itself isn't ranked." },
  {
    label: "Qwen3-4B's answers",
    key: { kind: "model", model: "Qwen3-4B-Instruct-2507-4bit" },
    about: "Qwen3-4B's own top answers as the key; Qwen3-4B itself isn't ranked.",
  },
];

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function AnswerKey({ result }: { result: any }) {
  const [label, setLabel] = useState(KEYS[1].label);
  const questions: Question[] = useMemo(() => (result?.cases ?? []).flatMap((c: any) => c.questions), [result]);
  const ids = MODELS.map((m) => m.id);
  const chosen = KEYS.find((k) => k.label === label) ?? KEYS[0];
  const rows = useMemo(() => rank(questions, chosen.key, ids), [questions, chosen]);
  // Rank the same models against the teacher, so a model left out as the key doesn't move the others.
  const byTeacher = useMemo(() => rank(questions, { kind: "teacher" }, rows.map((r) => r.model)), [questions, rows]);
  const name = (id: string) => MODELS.find((m) => m.id === id)?.name ?? id;
  const teacherRank = (id: string) => byTeacher.find((r) => r.model === id)?.rank;

  return (
    <div className="answer-key">
      <p className="lede-small">
        Five models answered the same {questions.length.toLocaleString()} workflow questions. Their answers are
        fixed. Only the answer key changes.
      </p>
      <Pills values={KEYS.map((k) => k.label)} value={label} onChange={setLabel} />
      <Pane title={`Graded against ${chosen.label.toLowerCase()}`} sub="Share of questions where the model's top answer matches the key's">
        <p className="fine">{chosen.about}</p>
        <p className="sr-only" aria-live="polite">
          {rows[0] ? `Graded against ${chosen.label.toLowerCase()}: ${name(rows[0].model)} ranks first at ${pct(rows[0].agreement)}.` : ""}
        </p>
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Model</th>
                <th scope="col">Agrees with the key</th>
                <th scope="col">Rank against the teacher</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const was = teacherRank(r.model);
                const moved = was !== undefined && chosen.key.kind !== "teacher" ? was - r.rank : 0;

                return (
                  <tr key={r.model}>
                    <td>{r.rank}</td>
                    <th scope="row">{name(r.model)}</th>
                    <td>{pct(r.agreement)}</td>
                    <td>
                      {was}
                      {moved > 0 ? ` (up ${moved})` : moved < 0 ? ` (down ${-moved})` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {questions[0] && (
          <Receipt
            label="Source"
            data={{
              mode: "recorded",
              questions: questions.length,
              raw: {
                request: { state: result.cases[0].state, question: result.cases[0].questions[0].instructions },
                response: { target: questions[0].target, predictions: questions[0].predictions },
                note: `The first of ${questions.length.toLocaleString()} recorded questions, as published in /data/local-models.json. This record kept each model's probabilities, not per-request time or cost.`,
              },
            }}
          />
        )}
      </Pane>
      <p className="fine">
        Against the teacher, Jev leads Qwen3-4B by about 19 points. Against the other models averaged, Qwen3-4B comes
        first and Jev second: when weaker models agree with each other, they outvote the one that is usually right.
        Neither key is correctness; the teacher is a small model too. A leaderboard built on a consensus of models
        partly measures how much a contestant resembles the voters.
      </p>
    </div>
  );
}
