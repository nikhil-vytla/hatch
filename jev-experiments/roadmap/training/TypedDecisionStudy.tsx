import { useState } from "react";
import publication from "./publication.json";
import protocol from "./PROTOCOL.md?raw";
import macGuide from "../mac/README.md?url&no-inline";
import emailExample from "../mac/examples/meeting.eml?url&no-inline";
import decisionExample from "../mac/examples/decision.json?url&no-inline";
import "./study.css";

type Metrics = {
  total: number;
  supported: number;
  nllMean: number;
  accuracyMean: number;
  brierMean: number;
  eceMean: number;
  ordinalMaeMean?: number;
  coverageMean: number;
};
type Condition = {
  macroNllMean: number;
  overall: Metrics;
  datasets: Record<string, Metrics>;
};
type StudyModel = {
  id: string;
  label: string;
  revision: string | null;
  training: {
    status: string;
    seeds: number[];
    trainableParameters: number | null;
    selected: { seed: number; learningRate: number; epoch: number } | null;
  };
  validation: Condition | null;
  test: Condition | null;
  transfer: Condition | null;
  export: { status: string; passed?: boolean };
  frozenBaselines: Record<string, Record<string, { macroNll: number }>> | null;
  robustness: {
    optionOrder: Record<string, { argmaxAgreement: number; compared: number }>;
    batchIndependence: { passed: boolean; maxProbabilityDelta: number };
    mlxTiming: {
      warmMedianMs: number;
      warmP95Ms: number;
      repetitions: number;
      inputId: string;
    };
  } | null;
  limitations: string[];
};
const models = publication.models as unknown as StudyModel[];
const evidence = import.meta.glob<string>(
  [
    "./results-*.json",
    "./export-*.json",
    "./robustness-*.json",
    "./frozen-baselines*.json",
    "./release-status.json",
    "./metric-correction.json",
    "./sources.json",
    "./corpus-manifest.json",
    "./PROVENANCE.md",
    "./REVIEW-DISPOSITION.md",
    "./default-selection.json",
  ],
  { query: "?url&no-inline", import: "default", eager: true },
);
const generalEvidence = new Set([
  "./release-status.json",
  "./metric-correction.json",
  "./sources.json",
  "./corpus-manifest.json",
  "./PROVENANCE.md",
  "./REVIEW-DISPOSITION.md",
  "./default-selection.json",
]);
const decisionEvidence = import.meta.glob<string>(
  "./export-decisions-*.jsonl",
  { query: "?url", import: "default", eager: true },
);
const labels: Record<string, string> = {
  banking77: "BANKING77 · 8-candidate derivative",
  boolq: "BoolQ · boolean",
  stsb: "STS-B · ordinal derivative",
  clinc: "CLINC · 8-candidate derivative",
  multirc: "MultiRC · answer validation",
  summeval: "SummEval · fluency rating",
  typed_decisions: "Typed Decisions · all 400 test cases",
};
const fmt = (n: number | undefined | null, percent = false) =>
  n == null ? "—" : percent ? `${(n * 100).toFixed(1)}%` : n.toFixed(3);
function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TypedDecisionStudy() {
  const [id, setId] = useState(models[0].id),
    [condition, setCondition] = useState<"test" | "transfer">("test"),
    [saved, setSaved] = useState("");
  const selected = models.find((m) => m.id === id)!,
    measured = selected[condition];
  const order = Object.values(selected.robustness?.optionOrder ?? {}).map(
    (x) => x.argmaxAgreement,
  );
  const baselines = [
    { label: "Adapted · 3-seed mean", value: measured?.macroNllMean },
    {
      label: "Frozen readout",
      value: selected.frozenBaselines?.frozenReadout?.[condition]?.macroNll,
    },
    {
      label: "Input embeddings",
      value:
        selected.frozenBaselines?.meanInputEmbedding?.[condition]?.macroNll,
    },
    {
      label: "Lexical baseline",
      value: publication.baselines.lexical?.[condition]?.macroNll,
    },
    {
      label: "State-blind prior",
      value: publication.baselines.prior?.[condition]?.macroNll,
    },
  ];
  const save = (name: string, text: string, type?: string) => {
    download(name, text, type);
    setSaved(`Downloaded ${name}.`);
  };
  return (
    <section className="typed-study" aria-labelledby="typed-study-title">
      <div className="study-heading">
        <div>
          <span className="eyebrow">LOCAL TYPED DECISIONS / EXPERIMENTAL</span>
          <h2 id="typed-study-title">
            One question format.
            <br />
            Three small models.
          </h2>
          <p>
            Adapt a readout, keep the backbone frozen, and measure where it
            transfers. Training uses BANKING77, BoolQ and STS-B. The earlier
            workflow specialist is a separate study below.
          </p>
        </div>
        <div className="study-counts">
          <span>
            <strong>{publication.corpus.train}</strong>adaptation examples
          </span>
          <span>
            <strong>{publication.corpus.validation}</strong>validation examples
          </span>
          <span>
            <strong>3</strong>seeds per selected recipe
          </span>
        </div>
      </div>
      <div className="study-disclosure">
        {publication.defaultModel
          ? `Validation-selected default: ${publication.defaultModel}.`
          : "No installed default has been selected."}{" "}
        {publication.release.researchEvidenceComplete
          ? "The study has complete training and export evidence."
          : "Training and export evidence is still being completed."}{" "}
        These results do not establish general-purpose capability.
      </div>
      <details className="study-evidence">
        <summary>Run a typed decision locally on a Mac</summary>
        <p>
          From a{" "}
          <a href="https://github.com/nikhil-vytla/hatch">
            repository checkout
          </a>{" "}
          containing this release, install the toolkit with:
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          bash jev-experiments/roadmap/mac/install.sh
        </pre>
        <p>
          The guide covers checksum-verified model installation, diagnostics and
          the first result. Python 3.13 and Apple Silicon macOS are the tested
          prerequisites. Inference runs locally after model installation. The
          email example reads only the file you supply; its 7/12 authored smoke
          result is experimental and its probabilities are not calibrated for
          email.
        </p>
        <ul>
          <li>
            <a href={macGuide} download="jev-mac-guide.md">
              Mac installation and usage guide
            </a>
          </li>
          <li>
            <a href={decisionExample} download="jev-decision.json">
              Example typed decision
            </a>
          </li>
          <li>
            <a href={emailExample} download="jev-meeting.eml">
              Example email file
            </a>
          </li>
        </ul>
      </details>
      <div className="study-models" role="group" aria-label="Study model">
        {models.map((m) => (
          <button
            key={m.id}
            aria-pressed={m.id === id}
            onClick={() => setId(m.id)}
          >
            <span>{m.label}</span>
            <small>
              {m.training.seeds.length
                ? `${m.training.seeds.length} trained seeds · Core ML ${m.export.status.replaceAll("_", " ")}`
                : "Training pending"}
            </small>
            <strong>{fmt(m.validation?.macroNllMean)}</strong>
            <small>3-seed validation NLL ↓</small>
          </button>
        ))}
      </div>
      {selected.robustness && (
        <div className="study-robustness">
          <div>
            <span>Same choice after option reversal</span>
            <strong>
              {fmt(Math.min(...order), true)}–{fmt(Math.max(...order), true)}
            </strong>
            <small>Range across three seeds, 384 decisions each</small>
          </div>
          <div>
            <span>Independent vs. batched output</span>
            <strong>
              {selected.robustness.batchIndependence.passed
                ? "Within tolerance"
                : "Tolerance exceeded"}
            </strong>
            <small>
              Largest probability delta{" "}
              {selected.robustness.batchIndependence.maxProbabilityDelta.toExponential(
                2,
              )}
            </small>
          </div>
          <p>
            Option order can change the answer substantially. Native MLX warm
            median: {selected.robustness.mlxTiming.warmMedianMs.toFixed(1)} ms
            for one short BANKING77 validation decision (
            {selected.robustness.mlxTiming.repetitions} repetitions). This is
            not latency across the full workload. Native timing includes
            tokenization and the readout; Core ML evidence separately times
            pre-tokenized float32 graph execution padded to 768 tokens. MLX uses
            the actual input length, so these are different workloads.
          </p>
        </div>
      )}
      <div className="study-controls">
        <h3>{selected.label}</h3>
        <label>
          Evaluation{" "}
          <select
            aria-label="Study evaluation split"
            value={condition}
            onChange={(e) =>
              setCondition(e.target.value as "test" | "transfer")
            }
          >
            <option value="test">Held-out tasks</option>
            <option value="transfer">Transfer datasets</option>
          </select>
        </label>
      </div>
      {measured ? (
        <>
          <div className="study-baselines" aria-label="Baseline comparison">
            <p>Mean dataset NLL ↓</p>
            {baselines.map((b) => (
              <div key={b.label}>
                <span>{b.label}</span>
                <strong>{fmt(b.value)}</strong>
              </div>
            ))}
          </div>
          <div
            className="study-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Decision study metrics"
          >
            <table>
              <thead>
                <tr>
                  <th>Dataset / task</th>
                  <th>Covered</th>
                  <th>Agreement ↑</th>
                  <th>NLL ↓</th>
                  <th>Brier ↓</th>
                  <th>Argmax ECE ↓</th>
                  <th>Ordinal error ↓</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(measured.datasets).map(([key, m]) => (
                  <tr key={key}>
                    <th>{labels[key] ?? key}</th>
                    <td>
                      {m.supported}/{m.total}
                    </td>
                    <td>{fmt(m.accuracyMean, true)}</td>
                    <td>{fmt(m.nllMean)}</td>
                    <td>{fmt(m.brierMean)}</td>
                    <td>{fmt(m.eceMean)}</td>
                    <td>{fmt(m.ordinalMaeMean)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="study-fine">
            Metrics are means across the three selected-recipe seeds.
            “Agreement” compares the most likely option with a reference
            maximum, accepting tied reference maxima; Typed Decisions uses a
            synthetic teacher. Coverage is explicit, and unsupported inputs are
            excluded from metric denominators. Candidate tasks and mapped
            ordinal ratings are derivatives, not original full-label benchmark
            scores.
          </p>
        </>
      ) : (
        <p className="study-disclosure">
          No completed {condition === "test" ? "held-out" : "transfer"} run is
          attached for this model.
        </p>
      )}
      <details className="study-evidence">
        <summary>Selection, baselines and source evidence</summary>
        <p>
          Recipes and checkpoints use validation data only. Negative log
          likelihood (NLL) scores the probability assigned to the reference;
          lower is better. Brier measures probability error. ECE compares
          top-label confidence with membership in the reference's argmax set, in
          ten equal-width bins. It does not measure calibration to the full soft
          reference distribution. Ordinal error uses the expected rating. The
          same validation set selects temperature and the eventual installed
          default.
        </p>
        <p>
          {selected.training.selected
            ? `Predefined export seed ${selected.training.selected.seed}: learning rate ${selected.training.selected.learningRate}, epoch ${selected.training.selected.epoch}; ${selected.training.trainableParameters?.toLocaleString()} trainable readout parameters.`
            : "Recipe selection is pending."}{" "}
          Core ML status: {selected.export.status.replaceAll("_", " ")}. The
          evidence compares every evaluation decision for that seed's export.
          Training metrics above average three seeds. Default selection uses
          seed 17 validation results and validation export agreement.
        </p>
        <p>
          State-blind priors, lexical scores, embedding baselines and frozen
          readouts have separate results in the downloadable evidence. Benchmark
          exposure in backbone pretraining is not ruled out; Laya's upstream
          documentation includes BoolQ in its training mix.
        </p>
        <ul>
          {selected.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          Model sources:{" "}
          <a href="https://github.com/NandhaKishorM/laya">
            Laya · Nandakishor M / Convai Innovations
          </a>
          ,{" "}
          <a href="https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct">
            SmolLM2 · Hugging Face
          </a>
          ,{" "}
          <a href="https://huggingface.co/Qwen/Qwen3-0.6B">Qwen3 · Qwen team</a>
          . The frozen protocol includes dataset sources, transformations and
          attribution.
        </p>
        <div className="study-downloads">
          {Object.entries(decisionEvidence)
            .filter(([path]) => path.includes(`-${id}-`))
            .map(([path, url]) => (
              <a
                className="study-file-link"
                key={path}
                href={url}
                download={path.slice(2)}
              >
                Download complete{" "}
                {path.includes("CPU_ONLY") ? "CPU" : "automatic hardware"}{" "}
                comparisons
              </a>
            ))}
          <button
            onClick={() =>
              save("jev-typed-study-protocol.md", protocol, "text/markdown")
            }
          >
            Download protocol
          </button>
          <button
            onClick={() =>
              save("jev-typed-study.json", JSON.stringify(publication, null, 2))
            }
          >
            Download all summary metrics
          </button>
          {Object.entries(evidence)
            .filter(
              ([path]) => path.includes(`-${id}`) || generalEvidence.has(path),
            )
            .map(([path, url]) => (
              <a
                className="study-file-link"
                key={path}
                href={url}
                download={path.slice(2)}
              >
                {path.slice(2)}
              </a>
            ))}
        </div>
        <p aria-live="polite" className="study-fine">
          {saved}
        </p>
      </details>
    </section>
  );
}
