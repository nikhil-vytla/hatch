import { useState } from "react";
import type { CSSProperties } from "react";
import contractSource from "../../../roadmap/runtime/contract.ts?raw";
import scoreSource from "./score-mechanism.ts?raw";
import { download } from "../api";
import { scoreLevels, summarizeScore } from "./score-mechanism";
import { SourceCode } from "../components/source-code/source-code";
import { repoSource } from "../components/source-code/source";
import { experimentNotes } from "./manifest";
import { Article } from "./article";

function ScoreFigure() {
  const [middle, setMiddle] = useState(10);
  const [highShare, setHighShare] = useState(50);
  const [exported, setExported] = useState(false);
  const result = summarizeScore(middle, highShare);
  const reset = (m: number, h: number) => {
    setMiddle(m);
    setHighShare(h);
    setExported(false);
  };
  const modalNames = result.modes
    .map((value) => `${value} · ${scoreLevels[value].label}`)
    .join(" / ");
  return (
    <figure className="note-figure score-figure">
      <figcaption>
        <span>01 / Shape the answer</span>
        <span>Authored distribution · local arithmetic</span>
      </figcaption>
      <div className="score-workspace">
        <div className="score-distribution">
          <div
            className="score-bars"
            role="img"
            aria-label={result.distribution
              .map(
                (p) =>
                  `Level ${p.value}: ${(p.probability * 100).toFixed(1)} percent`,
              )
              .join(". ")}
          >
            {result.distribution.map((p) => (
              <div className="score-column" key={p.value}>
                <span className="score-bar-value">
                  {(p.probability * 100).toFixed(1)}
                  <small>%</small>
                </span>
                <div className="score-bar-track">
                  <span
                    style={{ height: `${p.probability * 100}%` }}
                    data-modal={result.modes.includes(p.value)}
                  />
                </div>
                <span className="score-level">{p.value}</span>
                <span>{scoreLevels[p.value].label}</span>
              </div>
            ))}
          </div>
          <div className="score-axis" aria-hidden="true">
            <span
              style={
                {
                  "--score-position": `${result.expected * 50}%`,
                } as CSSProperties
              }
            >
              ◆
            </span>
            <b>0</b>
            <b>1</b>
            <b>2</b>
          </div>
          <p className="score-axis-label">◆ Expected value on the 0–2 scale</p>
        </div>
        <div className="score-controls">
          <label htmlFor="note-middle">
            Probability at level 1{" "}
            <output htmlFor="note-middle">{middle}%</output>
          </label>
          <input
            id="note-middle"
            type="range"
            min={0}
            max={100}
            value={middle}
            onChange={(e) => {
              setMiddle(Number(e.target.value));
              setExported(false);
            }}
          />
          <label htmlFor="note-high-share">
            Remaining probability sent to level 2{" "}
            <output htmlFor="note-high-share">{highShare}%</output>
          </label>
          <input
            id="note-high-share"
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={highShare}
            disabled={middle === 100}
            onChange={(e) => {
              setHighShare(Number(e.target.value));
              setExported(false);
            }}
          />
          <div className="score-presets" aria-label="Example distributions">
            <button type="button" onClick={() => reset(10, 50)}>
              Split extremes
            </button>
            <button type="button" onClick={() => reset(100, 50)}>
              Certain middle
            </button>
            <button type="button" onClick={() => reset(20, 87.5)}>
              Mostly high
            </button>
          </div>
          <dl className="score-readout" aria-live="polite" aria-atomic="true">
            <div>
              <dt>Expected value</dt>
              <dd>{result.expected.toFixed(2)}</dd>
            </div>
            <div>
              <dt>
                {result.modes.length > 1 ? "Modal levels · tie" : "Modal level"}
              </dt>
              <dd>{modalNames}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="score-figure-footer">
        <p>
          {result.modes.length > 1
            ? "The average sits between answers. The highest probability is shared."
            : `Level ${result.modes[0]} is the most probable answer; the average uses all three levels.`}
        </p>
        <button
          type="button"
          onClick={() => {
            download("authored-score-distribution.json", {
              kind: "authored-distribution",
              modelCalled: false,
              levels: scoreLevels,
              controls: { middlePercent: middle, highSharePercent: highShare },
              ...result,
            });
            setExported(true);
          }}
        >
          Export distribution
        </button>
        <span role="status">{exported ? "Distribution downloaded." : ""}</span>
      </div>
    </figure>
  );
}

export function ScoreNote() {
  return (
    <Article note={experimentNotes[0]}>
      <div className="note-prose">
        <p>
          A severity score of 1 can hide two quite different answers: certainty
          about the middle, or disagreement between the ends. Select{" "}
          <strong>Certain middle</strong>, then <strong>Split extremes</strong>.
          The average stays put. Almost everything behind it changes.
        </p>
      </div>
      <ScoreFigure />
      <div className="note-prose">
        <h2>Keep the shape.</h2>
        <p>
          Jev’s native{" "}
          <a href="https://docs.typesafe.ai/primitives/score">Score</a> returns
          a probability-weighted position on ordered levels. Taking the largest
          probability answers another question: which individual level is most
          likely? The figure computes both. A tie stays visible rather than
          quietly picking the first level.
        </p>
        <p>
          The labels matter too. Each level describes a concrete condition; its
          number is a position.{" "}
          <a href="https://docs.typesafe.ai/primitives/advanced">
            Structured level descriptions
          </a>{" "}
          can carry a definition and examples. Adding those fields changes the
          model’s question. Moving these sliders only changes an authored
          answer.
        </p>
        <p>
          The runtime now names these quantities separately:{" "}
          <code>expected</code> preserves the ordinal mean, while{" "}
          <code>selected</code> holds a modal value. The provider’s{" "}
          <code>confidence</code> remains its own field. This figure has no
          provider confidence because no model answered it.
        </p>
      </div>
      <SourceCode
        className="note-code"
        source={{
          text: contractSource,
          path: "jev-experiments/roadmap/runtime/contract.ts",
        }}
        title="The runtime's distribution summary"
        markers={{
          start: "export function decisionSummary(",
          end: "/** Returns explicit issues",
        }}
      />
      <div className="note-prose">
        <h2>A matching winner is an incomplete check.</h2>
        <p>
          This distinction matters when exporting a local model. Two runtimes
          can choose the same level while putting different probability
          elsewhere, changing an expected score or a later threshold. The{" "}
          <a href={repoSource("jev-experiments/roadmap/training/README.md")}>
            typed-readout study
          </a>{" "}
          therefore retains complete MLX and Core ML probability comparisons,
          alongside agreement on the winning option.
        </p>
        <p>
          That is an export check, not proof that the decisions are good. In the
          same study, reversing candidate order changed many answers. The
          selected Laya readout remains experimental. The useful next test is
          whether the whole decision stays stable for the inputs an application
          will actually use.
        </p>
      </div>
      <details className="note-more-code">
        <summary>See the code running this figure</summary>
        <SourceCode
          className="note-code"
          source={{
            text: scoreSource,
            path: "jev-experiments/experience-prototypes/src/notes/score-mechanism.ts",
          }}
          title="Authored controls → runtime summary"
          markers={{ start: "export function summarizeScore(" }}
        />
      </details>
      <aside className="note-references">
        <h2>Read alongside</h2>
        <p>
          <a href={repoSource("jev-experiments/roadmap/training/PROTOCOL.md")}>
            Frozen study protocol
          </a>{" "}
          ·{" "}
          <a
            href={repoSource("jev-experiments/roadmap/training/PROVENANCE.md")}
          >
            Data and model provenance
          </a>
          . Laya was created by{" "}
          <a href="https://github.com/NandhaKishorM/laya">
            Nandakishor M / Convai Innovations
          </a>
          . The local causal-readout work adapts the shared-prefix scoring
          method in{" "}
          <a href="https://github.com/ekzhang/openjev-sglang">
            Eric Zhang’s openjev-sglang
          </a>
          .
        </p>
      </aside>
    </Article>
  );
}
