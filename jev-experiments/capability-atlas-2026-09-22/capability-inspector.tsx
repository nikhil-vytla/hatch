import React, { useEffect, useState } from "react";
import atlas from "./atlas.json";
import "./capability-inspector.css";

type SnapshotStatus = "checking" | "matches" | "differs" | "unavailable";
declare const __JEV_CAPABILITY_BUILD_ID__: string;

export function CapabilityInspector({ id }: { id: string }) {
  const [validation, setValidation] = useState<{ id: string; status: SnapshotStatus }>({ id, status: "checking" });
  const status = validation.id === id ? validation.status : "checking";
  useEffect(() => {
    const controller = new AbortController();
    const setStatus = (status: SnapshotStatus) => setValidation({ id, status });
    fetch("/capability-build.json", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Audit metadata unavailable");
        const body = await response.json();
        if (!controller.signal.aborted) setStatus(body.buildId === __JEV_CAPABILITY_BUILD_ID__ && body.auditDate === atlas.audited_at && body.records?.[id] === true ? "matches" : "differs");
      })
      .catch(() => { if (!controller.signal.aborted) setStatus("unavailable"); });
    return () => controller.abort();
  }, [id]);
  const record = atlas.records.find((entry) => entry.id === id);
  if (!record) return null;
  return (
    <details className="jev-role" key={id}>
      <summary>
        <span>Jev's role</span>
        {status === "matches" && <span className="jev-role-preview">{record.questions[0]?.primitives}</span>}
      </summary>
      <div className="jev-role-body">
        {status !== "matches" ? (
          <p>{status === "checking" ? "Checking the implementation snapshot…" : status === "differs" ? "This build differs from the September 22 audit." : "The implementation snapshot is unavailable for this build."}</p>
        ) : <>
        <p className="jev-role-modes">{record.execution_modes.join(" · ")}</p>
        <div className="jev-role-flow">
          <section>
            <h3>What it sees</h3>
            <p>{record.input}</p>
          </section>
          <section>
            <h3>What it decides</h3>
            {record.questions.map((question, index) => (
              <p key={index}>
                {question.primitives} <small>{question.scope}{question.count_note ? ` · ${question.count_note}` : ""}</small>
              </p>
            ))}
            <p className="jev-role-note">{record.instructions_and_criteria}</p>
          </section>
          <section>
            <h3>What code does next</h3>
            <p>{record.output_effect}</p>
            <p className="jev-role-note">{record.distribution_use}</p>
          </section>
        </div>
        <p className="jev-role-evidence">{record.recorded_evidence}</p>
        <p className="jev-role-next">Next study: {record.depth_opportunity}</p>
        </>}
        <a href={`/capabilities.html#${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">
          Explore the capability map and call sites ↗
        </a>
        <small className="jev-role-date">Implementation audit · September 22, 2026</small>
      </div>
    </details>
  );
}
