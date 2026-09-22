import { useState } from "react";
import { SourceCode } from "../../experience-prototypes/src/components/source-code/source-code";
import engineSource from "./engine.ts?raw";
import { ruleRequest, type Rule, type Scene } from "./engine";
import {
  inspectWindow,
  materialName,
  materialSourceMarkers,
  type CellWindow,
  type StepTrace,
  type RuleAttempt,
} from "./mechanism";

const source = {
  text: engineSource,
  path: "jev-experiments/roadmap/materials/engine.ts",
};
const colors = [
  "transparent",
  "#c59a4a",
  "#79abb3",
  "#78836f",
  "#ad7957",
  "#e47d4c",
  "#bbd5d0",
  "#a487bd",
];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function Neighborhood({
  window,
  name,
  title,
}: {
  window: CellWindow;
  name: string;
  title: string;
}) {
  const description = window.cells
    .map(
      (cell, index) =>
        `${index === 4 ? "Selected" : `${(index % 3) - 1}, ${Math.floor(index / 3) - 1}`}: ${materialName(cell, name)}`,
    )
    .join(". ");
  return (
    <figure className="mat-neighborhood">
      <figcaption>
        {title} · tick {window.tick}
      </figcaption>
      <div role="img" aria-label={description}>
        {window.cells.map((cell, index) => (
          <span
            key={index}
            className={`${index === 4 ? "selected" : ""} ${cell === 0 || cell === null ? "is-empty" : ""}`}
            style={{ background: cell === null ? "transparent" : colors[cell] }}
            title={materialName(cell, name)}
            aria-hidden="true"
          >
            {cell === null
              ? "×"
              : cell === 0
                ? "·"
                : cell === 7
                  ? "◆"
                  : materialName(cell, name)}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function MaterialMechanism({
  scene,
  cursor,
  trace,
  attempt,
  proposal,
  busy,
  onRule,
  onStep,
  onPair,
  onClose,
  onInterpret,
  onCancel,
  onApply,
}: {
  scene: Scene;
  cursor: { x: number; y: number };
  trace: StepTrace | null;
  attempt: RuleAttempt | null;
  proposal: Rule | null;
  busy: boolean;
  onRule: (patch: Partial<Rule>) => void;
  onStep: () => void;
  onPair: () => void;
  onClose: () => void;
  onInterpret: () => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const [part, setPart] =
    useState<keyof typeof materialSourceMarkers>("contact");
  const [question, setQuestion] = useState("support");
  const rule = scene.rule;
  const current = inspectWindow(scene, cursor);
  const request = attempt?.request ?? ruleRequest(rule.instruction);
  const response = object(attempt?.response);
  const answer = object(object(response.answers)[question]);
  const probabilities = Object.entries(object(answer.probabilities)).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" &&
      Number.isFinite(entry[1]) &&
      entry[1] >= 0 &&
      entry[1] <= 1,
  );
  const titles = {
    contact: "Contact is checked before movement",
    movement: "A powder can swap places with water",
    jev: "Four choices become a bounded rule",
  };
  return (
    <section
      id="mat-mechanism"
      className="mat-mechanism"
      aria-labelledby="mat-mechanism-title"
    >
      <header>
        <div>
          <span className="mat-eyebrow">Inside this scene · local rules</span>
          <h3 id="mat-mechanism-title">A grain meets water.</h3>
        </div>
        <button onClick={onClose}>Back to painting</button>
      </header>
      <p>
        Sand can sink through water. Purple dust has another possibility: a
        contact rule can turn it into wood before it moves. Both behaviors come
        from this engine.
      </p>
      <div
        className="mat-mechanism-parts"
        role="group"
        aria-label="Material mechanism"
      >
        {(["contact", "movement", "jev"] as const).map((id) => (
          <button
            key={id}
            aria-pressed={part === id}
            onClick={() => setPart(id)}
          >
            {
              {
                contact: "Contact rule",
                movement: "Movement",
                jev: "Jev's choices",
              }[id]
            }
          </button>
        ))}
      </div>
      <div className="mat-mechanism-columns">
        <div className="mat-mechanism-reading">
          {part !== "jev" ? (
            <>
              <h4>
                {part === "contact"
                  ? "Change the purple material."
                  : "Look at one tick."}
              </h4>
              {part === "contact" ? (
                <>
                  <div className="mat-rule-sentence">
                    <label>
                      Movement
                      <select
                        value={rule.motion}
                        onChange={(event) =>
                          onRule({
                            motion: event.target.value as Rule["motion"],
                          })
                        }
                      >
                        <option value="solid">Stay</option>
                        <option value="powder">Fall and pile</option>
                        <option value="liquid">Fall and spread</option>
                        <option value="gas">Rise and spread</option>
                      </select>
                    </label>
                    <label>
                      When it touches
                      <select
                        value={rule.contact}
                        onChange={(event) =>
                          onRule({
                            contact: event.target.value as Rule["contact"],
                          })
                        }
                      >
                        {["none", "water", "fire", "sand", "wood"].map((id) => (
                          <option key={id} value={id}>
                            {id === "none" ? "No contact reaction" : id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      It becomes
                      <select
                        value={rule.becomes}
                        disabled={rule.contact === "none"}
                        onChange={(event) =>
                          onRule({
                            becomes: event.target.value as Rule["becomes"],
                          })
                        }
                      >
                        {[
                          "sand",
                          "water",
                          "stone",
                          "wood",
                          "fire",
                          "steam",
                        ].map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p>
                    The check reads four side neighbors. It changes the purple
                    cell and skips its movement for that tick. The matching
                    neighbor is not consumed by this rule.
                  </p>
                </>
              ) : (
                <p>
                  Powders try below, then the two lower diagonals. They can swap
                  with empty space or water. Liquids and gases also try
                  sideways. The scan alternates direction each tick; this is a
                  designed cellular rule, not a density calculation.
                </p>
              )}
              <div className="mat-mechanism-actions">
                <button onClick={onPair}>Place a test pair</button>
                <button onClick={onStep}>Step one tick</button>
              </div>
              <p className="mat-mechanism-small">
                The test pair preserves your current scene as a branch, then
                places purple dust beside{" "}
                {rule.contact === "none" ? "water" : rule.contact} in a small
                stone cup.
              </p>
              <div className="mat-step-window">
                {trace && (
                  <Neighborhood
                    window={trace.before}
                    name={rule.name}
                    title="Before"
                  />
                )}
                <Neighborhood
                  window={trace?.after ?? current}
                  name={rule.name}
                  title={trace ? "After" : "Selected neighborhood"}
                />
              </div>
              <p className="mat-mechanism-small">
                Cell {current.x + 1}, {current.y + 1}. These are the same grid
                positions before and after the step, not a tracked particle.
              </p>
              <p className="mat-mechanism-small">
                Current rule:{" "}
                {rule.source === "jev"
                  ? "applied Jev controls"
                  : "manual controls"}
                . Purple cells remaining:{" "}
                {scene.cells.filter((cell) => cell === 7).length}.
              </p>
            </>
          ) : (
            <>
              <h4>Words choose controls.</h4>
              <p>
                Jev can propose one movement and one contact transformation.
                Code checks all four answers, then you choose whether to apply
                the proposal. The canvas runs locally.
              </p>
              <label className="mat-mechanism-instruction">
                Material instruction
                <textarea
                  maxLength={600}
                  rows={3}
                  value={rule.instruction}
                  onChange={(event) =>
                    onRule({ instruction: event.target.value })
                  }
                />
              </label>
              <div className="mat-mechanism-actions">
                <button
                  disabled={busy || !rule.instruction.trim()}
                  onClick={onInterpret}
                >
                  {busy ? "Interpreting…" : "Propose typed controls"}
                </button>
                {busy && <button onClick={onCancel}>Cancel</button>}
                {proposal && <button onClick={onApply}>Apply proposal</button>}
              </div>
              <p className="mat-mechanism-small">
                Uses your connected key. Instruction accuracy has not been
                measured.
              </p>
              <p className="mat-rule-attempt" role="status">
                {attempt
                  ? `${{ pending: "Awaiting Jev", proposed: "Proposed, not applied", applied: "Applied", discarded: "Discarded after a scene change", superseded: "Applied rule has since been edited", failed: "Interpretation failed" }[attempt.status]} · request revision ${attempt.revision}${attempt.appliedAt === undefined ? "" : ` · applied at tick ${attempt.appliedAt}`}`
                  : rule.source === "jev"
                    ? "The current scene contains an applied Jev rule."
                    : "Question preview. No Jev response for this instruction."}
              </p>
              {attempt?.error && <p>{attempt.error}</p>}
              <label>
                Question
                <select
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                >
                  {Object.keys(request.questions).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                {
                  request.questions[question as keyof typeof request.questions]
                    .instructions
                }
              </p>
              <dl className="mat-question-options">
                {Object.entries(
                  request.questions[question as keyof typeof request.questions]
                    .criteria,
                ).map(([key, text]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{text}</dd>
                  </div>
                ))}
              </dl>
              {typeof answer.value === "string" && (
                <div className="mat-returned-rule">
                  <strong>Returned: {answer.value}</strong>
                  {probabilities.map(([key, probability]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <meter
                        min={0}
                        max={1}
                        value={probability}
                        aria-label={`${key} probability`}
                      />
                      <span>{Math.round(probability * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}
              {typeof response.model === "string" && (
                <p className="mat-mechanism-small">
                  {response.model_source === "provider-reported"
                    ? "Provider-reported model"
                    : response.model_source === "configured-unverified"
                      ? "Configured model, unverified"
                      : "Model, identity source not retained"}
                  : {response.model}
                </p>
              )}
              <details>
                <summary>
                  {attempt
                    ? "Exact request and retained response"
                    : "Complete question preview"}
                </summary>
                <pre tabIndex={0}>
                  {JSON.stringify(attempt ?? request, null, 2)}
                </pre>
              </details>
              {!attempt && rule.source === "jev" && (
                <details>
                  <summary>Applied rule evidence from this scene</summary>
                  <pre tabIndex={0}>
                    {JSON.stringify(rule.evidence ?? null, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>
        <SourceCode
          source={source}
          markers={materialSourceMarkers[part]}
          title={titles[part]}
          className="mat-mechanism-source"
        />
      </div>
    </section>
  );
}
