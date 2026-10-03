/**
 * The earlier SmolLM pilot (formerly its own scene), folded into Decision models on a Mac. It
 * trained on dataset labels, not Jev's answers, and its yes/no head got worse; this says both.
 */
import { useEffect, useState } from "react";
import { percent, fetchJson } from "./api";
import { Fold, Notice } from "./shared";

type Task = { accuracy: number; brier: number };

const TASKS: [string, string][] = [
  ["choice", "Pick one of 4"],
  ["noul", "Yes or no"],
  ["score", "Score 0–2"],
];

export function SmolLMPilot() {
  const [record, setRecord] = useState<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchJson("/data/replica.json")
      .then((d) => setRecord(d.result))
      .catch(() => setFailed(true));
  }, []);

  const jev = record?.jev_reference?.rows ?? [];
  const answered = jev.filter((r: any) => !r.error);
  const right = answered.filter((r: any) => r.prediction === r.target).length;
  const n = record?.after_rows?.length ?? 0;

  return (
    <Fold title="An earlier pilot: training SmolLM2-360M on dataset labels">
      {!record ? (
        <Notice>{failed ? "The pilot's record could not be loaded." : "Loading the pilot…"}</Notice>
      ) : (
        <>
          <p className="fine">
            On 20 Sep 2026, before the study above, we trained{" "}
            {record.trainable_parameters?.toLocaleString()} parameters (LoRA adapters and small
            heads) on {record.base} for {record.training_steps} steps (
            {Math.round(record.training_seconds)} s on an M4 Max). It borrowed its shape, a shared
            prefix with a separate branch per question, from{" "}
            <a href="https://github.com/jaredpalmer/kev" target="_blank" rel="noreferrer">
              Kev
            </a>
            , not Kev's full recipe. It learned from the datasets' own labels, not from Jev's
            answers, so it is not a copy of Jev. The questions come from BANKING77, with supplied
            distractors; {n} per type.
          </p>
          <div className="model-table-wrap">
            <table className="model-table">
              <thead>
                <tr>
                  <th scope="col">Question type</th>
                  <th scope="col">Before training</th>
                  <th scope="col">After</th>
                  <th scope="col">Brier before → after (lower is better)</th>
                </tr>
              </thead>
              <tbody>
                {TASKS.map(([key, label]) => {
                  const b: Task | undefined = record.before?.[key];
                  const a: Task | undefined = record.after?.[key];

                  return (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{b ? percent(b.accuracy) : "—"}</td>
                      <td>{a ? percent(a.accuracy) : "—"}</td>
                      <td>{b && a ? `${b.brier.toFixed(2)} → ${a.brier.toFixed(2)}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="fine">
            Training helped the pick-one questions and the scores. The yes/no head did not learn: it
            stayed at 40%, and its probabilities got worse. Jev was asked the same pick-one
            questions; only {answered.length} of {jev.length} answers came back (the rest hit rate
            limits), and it got {right} of those {answered.length} right.
          </p>
        </>
      )}
    </Fold>
  );
}
