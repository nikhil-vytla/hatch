/**
 * Intent recognition, with the two BANKING77 studies that used to be separate scenes: does the
 * answer survive meaning-preserving changes (stability), and does searching for a better prompt
 * help (prompt search). The accuracy tab now shows the simple baseline the question asks about.
 */
import { useEffect, useMemo, useState } from "react";
import { Benchmarks, Learning } from "./benchmarks";
import { percent, fetchJson } from "./api";
import { Notice, Pane, Pills, Stat } from "./shared";

const TABS = ["Accuracy", "Stability", "Prompt search"] as const;

type Tab = (typeof TABS)[number];

const cache = new Map<string, Promise<any>>();

function useRecord(name: string, enabled: boolean) {
  const [record, setRecord] = useState<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || record) return;

    if (!cache.has(name))
      cache.set(
        name,
        fetchJson(`/data/${name}.json`),
      );

    let live = true;

    cache
      .get(name)
      ?.then((r) => live && setRecord(r))
      .catch(() => live && setFailed(true));

    return () => {
      live = false;
    };
  }, [name, enabled, record]);

  return { record, failed };
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(1)} pts`;

/** Jev against the TF-IDF classifier on each dataset, with the paired difference. */
function Baseline({ result }: { result: any }) {
  const rows = Object.entries(result.experiments ?? {}) as [string, any][];

  return (
    <Pane title="Does Jev beat a simple classifier?" sub="Same test cases">
      <div className="model-table-wrap">
        <table className="model-table">
          <thead>
            <tr>
              <th scope="col">Dataset</th>
              <th scope="col">Jev</th>
              <th scope="col">TF-IDF classifier</th>
              <th scope="col">Jev minus classifier (95% interval)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, e]) => {
              const d = e.paired_difference;

              return (
                <tr key={name}>
                  <th scope="row">
                    {name === "banking77" ? "BANKING77" : name === "clinc150" ? "CLINC150" : name}{" "}
                    <small>{e.jev?.attempted} cases</small>
                  </th>
                  <td>{percent(e.jev?.accuracy_all_attempted ?? 0)}</td>
                  <td>{percent(e.tfidf_logistic?.accuracy_all_attempted ?? 0)}</td>
                  <td>
                    {d ? (
                      <>
                        <b>{signed(d.mean_difference)}</b> ({signed(d.interval_95[0])} to{" "}
                        {signed(d.interval_95[1])})
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fine">
        It depends on the dataset. On BANKING77, whose 77 banking intents a classifier trained on
        its own examples learns well, the classifier wins. On CLINC150, which includes requests that
        fit none of its intents, Jev wins by a wide margin. Both intervals exclude zero.
      </p>
    </Pane>
  );
}

/** How often each change to the request flips Jev's answer relative to the original. */
function Stability({ result }: { result: any }) {
  const table = useMemo(() => {
    const rows: any[] = result.rows ?? [];
    const original = new Map(
      rows.filter((r) => r.variant === "original").map((r) => [r.case, r.prediction]),
    );
    const by = new Map<string, { n: number; right: number; flipped: number }>();

    for (const r of rows) {
      const v = by.get(r.variant) ?? { n: 0, right: 0, flipped: 0 };

      v.n++;
      v.right += Number(r.prediction === r.target);
      v.flipped += Number(r.variant !== "original" && r.prediction !== original.get(r.case));
      by.set(r.variant, v);
    }

    const order = ["original", "repeat", "reverse_options", "distractor", "quoted_injection"];

    return [...by.entries()].sort(
      ([a], [b]) => ((order.indexOf(a) + 99) % 99) - ((order.indexOf(b) + 99) % 99),
    );
  }, [result]);

  const label: Record<string, string> = {
    original: "Original request",
    repeat: "Asked again",
    reverse_options: "Options reordered",
    distractor: "Irrelevant sentence added",
    quoted_injection: "Quoted instruction to change the answer",
  };

  return (
    <Pane title="Which changes alter the answer?" sub="40 BANKING77 requests, 5 ways each">
      <div className="model-table-wrap">
        <table className="model-table">
          <thead>
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Accuracy</th>
              <th scope="col">Answer changed from the original</th>
            </tr>
          </thead>
          <tbody>
            {table.map(([variant, v]) => (
              <tr key={variant}>
                <th scope="row">{label[variant] ?? variant}</th>
                <td>{percent(v.right / v.n)}</td>
                <td>{variant === "original" ? "—" : `${v.flipped} of ${v.n}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">
        Asked again, Jev never changed an answer. Reordering the options, adding an irrelevant
        sentence or quoting an instruction changed 2–3 answers in 40. With 40 requests per change,
        differences of a few points are within noise. The injection is an adversarial change, not a
        meaning-preserving one.
      </p>
    </Pane>
  );
}

export function IntentRecognition({ result }: { result: any }) {
  const [tab, setTab] = useState<Tab>("Accuracy");
  const robustness = useRecord("robustness", tab === "Stability");
  const optimize = useRecord("optimize", tab === "Prompt search");

  return (
    <div className="intent-recognition">
      <Pills values={[...TABS]} value={tab} onChange={(v) => setTab(v as Tab)} />
      {tab === "Accuracy" && (
        <>
          <Baseline result={result} />
          <Benchmarks id="classify" result={result} />
        </>
      )}
      {tab === "Stability" &&
        (robustness.record ? (
          <>
            <Stability result={robustness.record.result} />
            <Benchmarks id="robustness" result={robustness.record.result} recordedAt={robustness.record.manifest?.created} />
          </>
        ) : (
          <Notice>
            {robustness.failed
              ? "The stability run could not be loaded."
              : "Loading the stability run…"}
          </Notice>
        ))}
      {tab === "Prompt search" &&
        (optimize.record ? (
          <>
            <Pane
              title="Does searching for a better prompt help?"
              sub="50 held-out BANKING77 cases"
            >
              <Stat
                label="Finding"
                value="No"
                note="Every search method scored within 2 points of the unchanged prompt on the held-out cases; with 50 cases, that is noise."
              />
            </Pane>
            <Learning id="optimize" result={optimize.record.result} />
          </>
        ) : (
          <Notice>
            {optimize.failed
              ? "The prompt search could not be loaded."
              : "Loading the prompt search…"}
          </Notice>
        ))}
    </div>
  );
}
