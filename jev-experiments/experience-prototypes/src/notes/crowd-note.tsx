import { useState } from "react";
import crowdRun from "../../../live-worlds/crowd/demo.json";
import crowdSource from "../../../live-worlds/crowd/engine.ts?raw";
import { SourceCode } from "../components/source-code/source-code";
import { repoSource } from "../components/source-code/source";
import { experimentNotes } from "./manifest";
import { Article } from "./article";

const crowdState = crowdRun.result.request.state;
const crowdAnswers: Record<
  string,
  { value: string; confidence: number; probabilities: Record<string, number> }
> = crowdRun.result.response.answers;
const crowdQuestions: Record<
  string,
  { type: string; instructions: string; criteria: Record<string, string> }
> = crowdRun.result.request.questions;
const placeName = (id: string) =>
  crowdState.places.find((p) => p.id === id)?.name ??
  (id === "stay" ? "Keep current plan" : id);

function ResidentFigure() {
  const [id, setId] = useState("r0");
  const resident = crowdState.residents.find((r) => r.id === id)!;
  const answer = crowdAnswers[`destination_${id}`];
  const question = crowdQuestions[`destination_${id}`];
  return (
    <figure className="note-figure resident-figure">
      <figcaption>
        <span>02 / Read one decision</span>
        <span>Recorded Jev run · 20 September 2026</span>
      </figcaption>
      <blockquote>{crowdState.notice}</blockquote>
      <div className="resident-reading">
        <div>
          <label htmlFor="note-resident">Resident</label>
          <select
            id="note-resident"
            value={id}
            onChange={(e) => setId(e.target.value)}
          >
            {crowdState.residents.map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="resident-story">{resident.story}</p>
          <p className="resident-preferences">
            {resident.preferences.join(" · ")}
          </p>
          <p className="resident-route">
            <span>{placeName(resident.currentDestination)}</span>
            <b aria-hidden="true">→</b>
            <strong>{placeName(answer.value)}</strong>
          </p>
          <dl className="resident-needs">
            {Object.entries(resident.needs).map(([need, value]) => (
              <div key={need}>
                <dt>{need}</dt>
                <dd>{value.toFixed(2)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="resident-answer" aria-live="polite">
          <p className="note-kicker">Returned destination probabilities</p>
          {Object.entries(answer.probabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([destination, probability]) => (
              <div className="resident-probability" key={destination}>
                <span>{placeName(destination)}</span>
                <strong>{Math.round(probability * 100)}%</strong>
                <i
                  style={{ width: `${probability * 100}%` }}
                  aria-hidden="true"
                />
              </div>
            ))}
          <p className="note-meta">
            Provider confidence: {answer.confidence.toFixed(2)} · Model:{" "}
            {crowdRun.result.response.model}
          </p>
        </div>
      </div>
      <details className="resident-input">
        <summary>Read the exact destination question</summary>
        <p>{question.instructions}</p>
        <pre tabIndex={0} aria-label="Destination option descriptions">
          <code>{JSON.stringify(question.criteria, null, 2)}</code>
        </pre>
        <p>
          The request also included all twelve residents, open places, queues,
          the weather and the current event.{" "}
          <a href={repoSource("jev-experiments/live-worlds/crowd/demo.jsonl")}>
            Full recorded request and response ↗
          </a>
        </p>
      </details>
      <p className="note-figure-caption">
        One batch: {Object.keys(crowdAnswers).length} answers,{" "}
        {crowdRun.result.response.latency_ms} ms gateway latency. All{" "}
        {crowdRun.result.outcome.accepted} destination decisions were accepted
        at the recorded checkpoint. Playback applies the saved answers
        immediately.
      </p>
      <details className="note-source-meta">
        <summary>Recorded request fingerprint</summary>
        <code>{crowdRun.manifest.request_sha256}</code>
        <small>
          SHA-256 from the recording manifest, separate from the current engine
          source below.
        </small>
      </details>
    </figure>
  );
}

export function CrowdNote() {
  return (
    <Article note={experimentNotes[1]}>
      <div className="note-prose">
        <p>
          Mina was heading to the café. A notice offered quiet reading, and Jev
          recommended the reading room. That is the model’s part of this scene:
          choose a destination from the world it was shown. Movement, seats and
          the passage of time still belong to the simulation.
        </p>
      </div>
      <ResidentFigure />
      <div className="note-prose">
        <h2>A decision has a moment.</h2>
        <p>
          The request carries a snapshot. In this recording it contains the
          notice, current weather, open places, queues, needs and short
          fictional biographies. Each resident gets two independent Choice
          questions: where to go, and how to interpret the invitation. The
          simulation’s future event schedule stays out of the request.
        </p>
        <p>
          While an answer is in flight, a reader can edit the notice or take
          control of a resident. A plausible old answer then becomes the wrong
          answer to apply. The engine checks the branch, reset epoch, semantic
          revision and expiry before accepting it. Resident intent and
          destination legality are checked separately.
        </p>
      </div>
      <SourceCode
        className="note-code"
        source={{
          text: crowdSource,
          path: "jev-experiments/live-worlds/crowd/engine.ts",
        }}
        title="An answer must still belong to this world"
        markers={{
          start: "export function ticketCurrent(",
          end: "export type Reply",
        }}
      />
      <div className="note-prose">
        <h2>Give the model credit for its own work.</h2>
        <p>
          The world can also choose a destination from hunger, rest and company
          needs. That fallback may be useful, but a lively square with it
          enabled does not establish how well Jev planned. The matched replay
          lanes separate the model’s saved plan from later fallback decisions.
        </p>
        <p>
          This run is one authored notice and twelve fictional residents. Its{" "}
          {crowdRun.result.outcome.accepted} accepted decisions establish
          compatibility with the checkpoint’s rules, not accuracy about people.
          A paraphrase comparison needs fresh answers to both notices and
          visible route differences from the same starting world. The saved run
          alone cannot answer that question.
        </p>
        <p>
          <a href="#experiment/crowd">Open the crowd</a>, select a resident and
          inspect the decision. Read the returned probabilities beside the
          actual observation. A route without its input can look much more
          capable than the system that produced it.
        </p>
      </div>
      <aside className="note-references">
        <h2>Evidence and method</h2>
        <p>
          <a href={repoSource("jev-experiments/live-worlds/crowd/README.md")}>
            Recorded run and engine notes
          </a>{" "}
          ·{" "}
          <a href={repoSource("jev-experiments/live-worlds/crowd/demo.jsonl")}>
            Canonical recording
          </a>{" "}
          ·{" "}
          <a href="https://docs.typesafe.ai/primitives/choice">
            TypeSafe Choice documentation
          </a>
          . The characters, world rules and observations are authored in this
          repository.
        </p>
      </aside>
    </Article>
  );
}
