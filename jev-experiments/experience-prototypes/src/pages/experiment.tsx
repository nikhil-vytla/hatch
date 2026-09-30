import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { experiments, lookup, retiredScene, type Experiment } from "../catalog";
import { CapabilityInspector } from "../../../capability-atlas-2026-09-22/capability-inspector";
import { Pane, Notice } from "../shared";
import { Provenance } from "../provenance";
import { experimentNotes } from "../notes/manifest";
import "./experiment.css";

const sceneEntries = new Set(["materials", "tetris", "crowd", "music", "routing", "visual-search"]);

const Paste = lazy(() => import("../new-experiments").then(m => ({ default: m.Paste })));
const LayoutStudy = lazy(() => import("../layout-study").then(m => ({ default: m.LayoutStudy })));
const JudgmentsScene = lazy(() => import("../judgments-scene").then(m => ({ default: m.JudgmentsScene })));
const GeneratedUI = lazy(() => import("../generated-ui").then(m => ({ default: m.GeneratedUI })));
const Games = lazy(() => import("../games").then(m => ({ default: m.Games })));
const Learning = lazy(() => import("../benchmarks").then(m => ({ default: m.Learning })));
const IntentRecognition = lazy(() => import("../intent-recognition").then(m => ({ default: m.IntentRecognition })));
const Handoff = lazy(() => import("../handoff").then(m => ({ default: m.Handoff })));
const Decoy = lazy(() => import("../decoy").then(m => ({ default: m.Decoy })));
const AnswerKey = lazy(() => import("../answer-key").then(m => ({ default: m.AnswerKey })));
const RewardBench = lazy(() => import("../rewardbench").then(m => ({ default: m.RewardBench })));
const LocalModels = lazy(() => import("../local-models").then(m => ({ default: m.LocalModels })));
const AgentExperiment = lazy(() => import("../agent-experiments").then(m => ({ default: m.AgentExperiment })));
const Music = lazy(() => import("../music-arranger").then(m => ({ default: m.Music })));
const JudgeBench = lazy(() => import("../judgment-reliability").then(m => ({ default: m.JudgeBench })));
const Beverage = lazy(() => import("../cafe-jev").then(m => ({ default: m.Beverage })));
const VisualSearch = lazy(() => import("../visual-search").then(m => ({ default: m.VisualSearch })));
const Wardrobe = lazy(() => import("../wardrobe").then(m => ({ default: m.Wardrobe })));
const IconStudio = lazy(() => import("../icon-studio").then(m => ({ default: m.IconStudio })));
const TetrisExperience = lazy(() => import("../tetris-experience").then(m => ({ default: m.TetrisExperience })));
const GhostBrush = lazy(() => import("../ghost-brush").then(m => ({ default: m.GhostBrush })));
const LiveCrowd = lazy(() => import("../live-crowd").then(m => ({ default: m.LiveCrowd })));
const DrawingFraming = lazy(() => import("../outcome-framing").then(m => ({ default: m.DrawingFraming })));
const ArcadeScene = lazy(() => import("../arcade-scene").then(m => ({ default: m.ArcadeScene })));
const ModelRoutingLab = lazy(() => import("../../../roadmap/routing/ModelRoutingLab").then(m => ({ default: m.ModelRoutingLab })));
const MaterialsSandbox = lazy(() => import("../../../roadmap/materials/MaterialsSandbox").then(m => ({ default: m.MaterialsSandbox })));

const cache = new Map<string, any>();
async function load(name: string) {
  if (!cache.has(name)) {
    // RewardBench's full document holds every case's answer texts; its page loads a light
    // index and fetches one case at a time. The full document stays at /data for download.
    const response = await fetch(name === "rewardbench2" ? "/rewardbench2/index.json" : `/data/${name}.json`);
    if (!response.ok) throw new Error("No recorded run is attached yet.");
    cache.set(name, await response.json());
  }
  return cache.get(name);
}

function View({
  exp,
  result,
  composition,
}: {
  exp: Experiment;
  result: any;
  composition: any;
}) {
  switch (exp.id) {
    case "snake":
      return <ArcadeScene result={result} />;
    case "local-models":
      return <LocalModels result={result} />;
    case "answer-key":
      return <AnswerKey result={result} />;
    case "paste":
      return <Paste record={result} />;
    case "semantic-table":
      return <JudgmentsScene record={result} />;
    case "ui":
      return (
        <>
          <GeneratedUI record={composition} />
          <LayoutStudy result={result} />
        </>
      );
    case "music":
      return <Music result={result} />;
    case "games":
      return <Games result={result} />;
    case "beverage":
      return <Beverage result={result} />;
    case "judge":
      return <JudgeBench result={result} />;
    case "tetris":
      return <TetrisExperience result={result} />;
    case "drawing-framing":
      return <DrawingFraming result={result} />;
    case "visual-search":
      return <VisualSearch result={result} />;
    case "wardrobe":
      return <Wardrobe result={result} />;
    case "icon-studio":
      return <IconStudio result={result} />;
    case "ghost-brush":
      return <GhostBrush />;
    case "crowd":
      return <LiveCrowd />;
    case "routing":
      return <ModelRoutingLab />;
    case "materials":
      return <MaterialsSandbox />;
    case "classify":
      return <IntentRecognition result={result} />;
    case "handoff":
      return <Handoff result={result} />;
    case "decoy":
      return <Decoy />;
    case "rewardbench2":
      return <RewardBench result={result} />;
      return <Learning id={exp.id} result={result} />;
    case "verify":
    case "search":
      return <AgentExperiment id={exp.id} result={result} />;
    default:
      return (
        <Pane title="Experiment unavailable">
          <Notice>
            This experiment does not have a view yet.{" "}
            <a href="#/">Return to experiments</a>.
          </Notice>
        </Pane>
      );
  }
}
/** An old link to a scene taken out of the catalog: say why, where to go, and keep its record. */
function RetiredScene({ id }: { id: string }) {
  const r = retiredScene(id);

  if (!r) return null;

  return (
    <section className="experiment-page retired-scene">
      <Pane title={r.title} sub="Retired 29 Sep 2026">
        <p>{r.reason}</p>
        <p>
          {r.instead && (
            <>
              <a href={r.instead.href}>{r.instead.label} →</a>
              {" · "}
            </>
          )}
          <a href={`/data/${r.record}.json`} download>
            Download the recorded run
          </a>
          {" · "}
          <a href="#/">All experiments</a>
        </p>
      </Pane>
    </section>
  );
}

export function ExperimentPage({ id }: { id: string }) {
  return retiredScene(id) ? <RetiredScene id={id} /> : <LiveExperimentPage id={id} />;
}

function LiveExperimentPage({ id }: { id: string }) {
  const exp = lookup(id),
    [recordSlot, setRecordSlot] = useState<{ id: string; value: any } | null>(null),
    [composition, setComposition] = useState<any>(null),
    [error, setError] = useState(""),
    [aboutOpen, setAboutOpen] = useState(false);
  const sceneEntry = sceneEntries.has(id);
  const record = recordSlot?.id === id ? recordSlot.value : null;
  const loadedRecord = useRef(recordSlot);
  loadedRecord.current = recordSlot;
  const note = experimentNotes.find(item => item.scene === id);
  useEffect(() => {
    // Activity recreates effects when returning from a note. Reusing the same
    // record keeps the existing scene mounted instead of resetting its state.
    if (loadedRecord.current?.id === id && loadedRecord.current.value) return;
    let alive = true;
    const setRecord = (value: any) => setRecordSlot({ id, value });
    setRecord(null);
    setError("");
    setAboutOpen(false);
    if (id === "materials" || id === "routing" || id === "decoy") {
      setRecord({ result: {} });
      return () => {
        alive = false;
      };
    }
    load(exp.data)
      .then((r) => {
        if (alive) setRecord(r);
      })
      .catch((e) => {
        if (alive) {
          setError(e.message);
          setRecord({ result: {} });
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => {
    // The second UI recording may still be loading when the scene is hidden.
    // Its lifecycle must not depend on whether the main recording has arrived.
    if (id !== "ui" || composition) return;
    let alive = true;
    load("composed-ui")
      .then((r) => alive && setComposition(r.result))
      .catch(() => {});
    return () => { alive = false; };
  }, [id, composition]);
  return (
    <section className={`detail published-experiment${sceneEntry ? " scene-entry" : ""}`}>
      <div className="breadcrumbs">
        <a href="#/">
          <ArrowLeft size={13} /> All experiments
        </a>
        <span>/</span>
        <span>{exp.category}</span>
      </div>
      {sceneEntry ? <>
        <header className="scene-entry-heading">
          <h1>{exp.title}</h1>
          <button type="button" aria-expanded={aboutOpen} aria-controls="experiment-background" onClick={() => setAboutOpen(open => !open)}>About & evidence</button>
        </header>
        <section id="experiment-background" className="scene-entry-background" hidden={!aboutOpen} aria-label="About this experiment">
          <p>{exp.description}</p>
          <p className="scene-entry-question">{exp.question}</p>
          {note && <p><a href={`#/notes/${note.slug}`}>Read the note: {note.title} →</a></p>}
          <CapabilityInspector key={id} id={id} />
          {record && <Provenance result={record.result ?? {}} />}
        </section>
      </> : <><section className="detail-heading">
        <div>
          <span className="eyebrow">
            EXPERIMENT {String(experiments.indexOf(exp) + 1).padStart(2, "0")} /{" "}
            {exp.category.toUpperCase()}
          </span>
          <h1>{exp.title}</h1>
          <p>{exp.description}</p>
        </div>
        <div className="experiment-question">
          <FlaskConical size={17} />
          <p>{exp.question}</p>
        </div>
      </section>
      <CapabilityInspector key={id} id={id} />
      {record && exp.id !== "local-models" && (
        <Provenance result={record.result ?? {}} />
      )}
      </>}
      {error && <Notice error>{error}</Notice>}
      {record ? (
        <Suspense
          fallback={
            <div className="loading-stage">
              <span className="loader" /> Opening the experiment…
            </div>
          }
        >
          <View
            key={id}
            exp={exp}
            result={record.result ?? {}}
            composition={composition}
          />
        </Suspense>
      ) : (
        <div className="loading-stage">
          <span className="loader" /> Opening the experiment…
        </div>
      )}
      {record?.manifest && exp.id !== "local-models" && (
        <p className="record-footer">
          {/* Older records name their date prepared_at; say only what's there. */}
          {(() => {
            const day = String(record.manifest?.created ?? record.manifest?.prepared_at ?? "").slice(0, 10);

            return day ? `Recorded ${day} · ` : "Recorded run · ";
          })()}
          {record.manifest?.experiment ?? exp.id} ·{" "}
          <a
            href={`/data/${id === "ui" ? "composed-ui" : exp.data}.json`}
            download
          >
            Download evidence ↓
          </a>
        </p>
      )}
    </section>
  );
}
