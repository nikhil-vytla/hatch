import { useRef, useState } from "react";
import {
  applyCandidate,
  BarScore,
  makeCandidates,
  noteName,
  starterScore,
} from "../../../music-arranger-v2/engine";
import source from "../../../music-arranger-v2/engine.ts?raw";
import { SourceCode } from "../components/source-code/source-code";
import { repoSource } from "../components/source-code/source";
import { MusicExplanation } from "../experiments/music/music-explanation";
import "../experiments/music/music-mechanism.css";
import { Article } from "./article";
import type { Note } from "./manifest";

function BoundaryFigure() {
  const clock = useRef(new BarScore(starterScore()));
  const [beat, setBeat] = useState(0);
  const [, redraw] = useState(0);
  const active = clock.current.current,
    queued = clock.current.pending;
  const names = (score: typeof active) =>
    score.events
      .filter((event) => event.phrase === 0 && event.track === "melody")
      .map((event) => (event.midi === null ? "rest" : noteName(event.midi)))
      .join(" · ");
  return (
    <figure className="note-figure ma-boundary-figure">
      <figcaption>
        <span>A draft waits for the bar</span>
        <span>Local scheduler figure · no audio</span>
      </figcaption>
      <div className="ma-mechanism">
        <p>
          Queue a different opening, then step to beat 4. This figure calls the
          same <code>BarScore.atBeat</code> method as audio playback.
        </p>
        <div className="ma-mechanism-actions">
          <button
            type="button"
            disabled={!!queued}
            onClick={() => {
              clock.current.queue(
                applyCandidate(
                  active,
                  0,
                  makeCandidates(active, 0)[
                    active.phrases[0].contour === "rising" ? 1 : 0
                  ],
                  "user",
                ),
              );
              redraw((n) => n + 1);
            }}
          >
            Queue a different opening
          </button>
          <button
            type="button"
            onClick={() => {
              const next = (beat + 1) % 8;
              clock.current.atBeat(next);
              setBeat(next);
            }}
          >
            Step one beat
          </button>
          <button
            type="button"
            onClick={() => {
              clock.current = new BarScore(starterScore());
              setBeat(0);
              redraw((n) => n + 1);
            }}
          >
            Reset figure
          </button>
        </div>
        <ol className="ma-mechanism-bars" aria-label="Two-bar scheduler ticks">
          {Array.from({ length: 8 }, (_, index) => (
            <li key={index} data-active={beat === index}>
              <span>Beat {index}</span>
              <strong>{index % 4 === 0 ? "Bar boundary" : "Within bar"}</strong>
            </li>
          ))}
        </ol>
        <dl className="ma-boundary-scores">
          <div>
            <dt>Active score v{active.version}</dt>
            <dd>{names(active)}</dd>
          </div>
          <div>
            <dt>
              {queued ? `Pending draft v${queued.version}` : "No pending draft"}
            </dt>
            <dd>
              {queued
                ? names(queued)
                : "The next queued draft will wait for a boundary."}
            </dd>
          </div>
        </dl>
        <p role="status">
          Beat {beat}.{" "}
          {queued
            ? "The active notes are unchanged while the draft waits."
            : `The scheduler uses score v${active.version}.`}
        </p>
      </div>
    </figure>
  );
}

export function MusicNote({ note }: { note: Note }) {
  return (
    <Article note={note}>
      <div className="note-prose">
        <p>
          A musical edit can be ready before it belongs in the sound. This
          player keeps a draft beside the score already scheduled. The small
          example below makes that separation visible without starting audio or
          asking a model.
        </p>
      </div>
      <BoundaryFigure />
      <SourceCode
        className="note-code"
        source={{
          text: source,
          path: "jev-experiments/music-arranger-v2/engine.ts",
        }}
        title="The boundary that accepts the draft"
        markers={{
          start: "export class BarScore",
          end: "export class Generation",
        }}
      />
      <div className="note-prose">
        <MusicExplanation />
        <p>
          The useful constraint turned out to be smaller than "change at a
          phrase boundary." A phrase spans eight beats, while this scheduler
          checks every four. That distinction matters when editing a sustained
          passage: notes already triggered keep their existing envelope, and
          only future scheduled events use the replacement. The figure tests
          score adoption; it does not simulate held audio voices.
        </p>
        <p>
          <a href="#experiment/music">Open the score</a>, play it, and expand
          "How this phrase changes." The view follows the actual draft,
          currently playing score, selected phrase and retained request. A
          proposed answer becomes an edit only when accepted; an answer to an
          invalidated request cannot become the current proposal.
        </p>
      </div>
      <SourceCode
        className="note-code"
        source={{
          text: source,
          path: "jev-experiments/music-arranger-v2/engine.ts",
        }}
        title="A lock rejects a phrase replacement"
        markers={{
          start: "export function applyCandidate(",
          end: "export function starterScore(",
        }}
      />
      <aside className="note-references">
        <h2>Source and evidence</h2>
        <p>
          <a href={repoSource("jev-experiments/music-arranger-v2/README.md")}>
            Composition and recording protocol
          </a>{" "}
          ·{" "}
          <a
            href={repoSource(
              "jev-experiments/music-arranger-v2/music-v2.jsonl",
            )}
          >
            Retained model requests and answers
          </a>{" "}
          ·{" "}
          <a
            href={repoSource("jev-experiments/music-arranger-v2/audio.test.ts")}
          >
            Audio scheduling tests
          </a>{" "}
          ·{" "}
          <a
            href={repoSource(
              "jev-experiments/release-implementation-2026-09-22/music-mechanism/README.md",
            )}
          >
            Mechanism implementation checks
          </a>
          .
        </p>
        <p>
          Sound uses <a href="https://tonejs.github.io/">Tone.js</a>. The
          composition rules, score, candidate generator and this figure are
          authored here. The recordings test typed selection from symbolic
          notes; they do not establish listener preference or musical quality.
        </p>
      </aside>
    </Article>
  );
}
