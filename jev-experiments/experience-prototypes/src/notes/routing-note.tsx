import { useState } from "react";
import routingReport from "../../../roadmap/routing/comparison/report.json";
import routingSource from "../../../roadmap/routing/policy.ts?raw";
import { SourceCode } from "../components/source-code/source-code";
import { repoSource } from "../components/source-code/source";
import { experimentNotes } from "./manifest";
import { Article } from "./article";

const conditionNames: Record<string, string> = {
  "fixed-gpt-4.1-mini": "Fixed GPT-4.1 mini",
  "fixed-gpt-4.1": "Fixed GPT-4.1",
  heuristic: "Heuristic",
  "host-agent": "Host agent",
  "hosted-jev": "Hosted Jev",
  "local-laya": "Local Laya",
};

function RoutingFigure() {
  const [taskId, setTaskId] = useState(routingReport.rows[0].taskId);
  const taskIds = [...new Set(routingReport.rows.map((row) => row.taskId))];
  const conditions = routingReport.summaries.filter(
    (row) => !row.condition.startsWith("fixed-"),
  );
  return (
    <figure className="note-figure routing-note-figure">
      <figcaption>
        <span>03 / Trace the comparison</span>
        <span>Recorded answers · replayed selection · 21 September 2026</span>
      </figcaption>
      <label htmlFor="note-routing-task">Held-out task</label>
      <select
        id="note-routing-task"
        value={taskId}
        onChange={(e) => setTaskId(e.target.value)}
      >
        {taskIds.map((id) => (
          <option key={id} value={id}>
            {id.replace(/^test-/, "").replaceAll("-", " ")}
          </option>
        ))}
      </select>
      <div className="routing-note-paths" aria-live="polite">
        {conditions.map(({ condition }) => {
          const row = routingReport.rows.find(
            (candidate) =>
              candidate.condition === condition && candidate.taskId === taskId,
          )!;
          return (
            <div className="routing-note-path" key={condition}>
              <span>{conditionNames[condition]}</span>
              <span aria-hidden="true">→</span>
              <strong>{row.routeId}</strong>
              <span>{row.success ? "Task passed" : "Task failed"}</span>
            </div>
          );
        })}
      </div>
      <div
        className="note-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Held-out comparison totals"
      >
        <table>
          <caption>
            All four held-out tasks, including classifier and selection overhead
          </caption>
          <thead>
            <tr>
              <th scope="col">Condition</th>
              <th scope="col">Passed</th>
              <th scope="col">Total time</th>
              <th scope="col">Known cost*</th>
            </tr>
          </thead>
          <tbody>
            {routingReport.summaries.map((row) => (
              <tr key={row.condition}>
                <th scope="row">{conditionNames[row.condition]}</th>
                <td>
                  {row.success}/{row.tasks}
                </td>
                <td>
                  {row.totalLatencyMs === null
                    ? "Unknown"
                    : `${(row.totalLatencyMs / 1000).toFixed(3)} s`}
                </td>
                <td>
                  {row.totalCostUsd === null
                    ? "Unknown"
                    : `$${row.totalCostUsd.toFixed(6)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note-figure-caption">
        *Configured token-price arithmetic, not invoice cost. Local hardware and
        energy are excluded. Host-agent overhead and hosted Jev pricing were
        unavailable; their incomplete totals stay unknown. Verification was
        disabled.
      </p>
    </figure>
  );
}

export function RoutingNote() {
  return (
    <Article note={experimentNotes[2]}>
      <div className="note-prose">
        <p>
          Could a small classifier send work to a better destination? The first
          bounded study compared a heuristic, the host agent, hosted Jev and
          local Laya under one routing policy. They produced different task
          labels. They still selected the same model on every held-out task.
        </p>
      </div>
      <RoutingFigure />
      <div className="note-prose">
        <h2>The labels had nowhere to go.</h2>
        <p>
          The protocol had four calibration tasks and four held-out tasks. Four
          calibration rows could support a rough aggregate success estimate;
          they could not support separate estimates for every category and
          difficulty. The registry therefore gave each category the same easy
          and hard scores.
        </p>
        <p>
          The current selection function interpolates between those endpoints.
          When they are equal, changing the difficulty cannot change the quality
          estimate. Giving every category the same pair also removes the effect
          of the category label. Better classification had no path through this
          calibration to a better route.
        </p>
      </div>
      <SourceCode
        className="note-code"
        source={{
          text: routingSource,
          path: "jev-experiments/roadmap/routing/policy.ts",
        }}
        title="Where task traits can affect the quality estimate"
        markers={{
          start: "export function qualityForTask(",
          end: "// UTF-8 bytes",
        }}
      />
      <div className="note-prose">
        <h2>What the result can tell us</h2>
        <p>
          The chosen GPT-4.1 mini answers passed two of the four held-out
          graders. Fixed GPT-4.1 passed three. One miss counted overlapping jobs
          incorrectly; another returned a cycle array when the task required a
          boolean. The study retained those answers instead of rerolling them.
        </p>
        <p>
          Each destination answer was generated once, then reused across
          selection conditions. The table adds recorded classification and
          replay-selection overhead where known. It does not describe six fresh
          end-to-end executions. The original Haiku attempts hit an account
          access restriction, which says nothing about that model’s task
          ability.
        </p>
        <p>
          This is useful integration evidence and an uninformative test of
          classifier benefit. A next study needs a larger frozen calibration set
          where task traits can change estimated destination quality, followed
          by separate held-out tasks. Until then, neither a faster label nor a
          lower configured price supports a savings claim.
        </p>
        <p>
          The Model Routing Lab scene that let you change these preferences has
          been retired: its sliders moved configured, not measured, values.{" "}
          <a href="#experiment/routing">Why, and its recorded run →</a> The
          principle stands: a preference is allowed to trade off; a permission
          or spending limit is not.
        </p>
      </div>
      <aside className="note-references">
        <h2>Evidence and prior work</h2>
        <p>
          <a
            href={repoSource(
              "jev-experiments/roadmap/routing/comparison/PROTOCOL.md",
            )}
          >
            Frozen protocol and dated amendments
          </a>{" "}
          ·{" "}
          <a
            href={repoSource(
              "jev-experiments/roadmap/routing/comparison/report.json",
            )}
          >
            Machine-readable result
          </a>{" "}
          ·{" "}
          <a
            href={repoSource(
              "jev-experiments/roadmap/routing/comparison/calibrated-registry.json",
            )}
          >
            Calibrated registry
          </a>
          . The routing project credits{" "}
          <a href="https://github.com/fstandhartinger/auto-model-router">
            fstandhartinger’s auto-model-router
          </a>{" "}
          and <a href="https://whichmodel.app.mintapis.com/">Whichmodel</a> as
          precedents; these task results come from this lab.
        </p>
      </aside>
    </Article>
  );
}
