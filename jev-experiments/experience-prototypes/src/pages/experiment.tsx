import { Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { liveScene, lookup, retiredScene, type Scene } from "../scenes";
import { sceneViews, type ViewProps } from "../scene-views";
import { Pane, Notice } from "../shared";
import { Provenance, SourceCredit } from "../provenance";
import { HeadlineStrip } from "../headline-strip";
import { experimentNotes } from "../notes/manifest";
import { RecordDate } from "../receipt";
import { EvidenceDrawer } from "../formats/evidence-drawer";
import { gameEvidence } from "../formats/game-evidence";
import "./experiment.css";

const cache = new Map<string, any>();
async function load(url: string) {
  if (!cache.has(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("No recorded run is attached yet.");
    cache.set(url, await response.json());
  }
  return cache.get(url);
}

/** The URL of a published record. */
const recordUrl = (record: string) => `/data/${record}.json`;

function View({ scene, ...props }: ViewProps & { scene: Scene }) {
  return sceneViews[scene.id](props);
}
/** An old link to a scene taken out of the catalog: say why, where to go, and keep its record. */
function RetiredScene({ id }: { id: string }) {
  const r = retiredScene(id);

  if (!r) return null;

  return (
    <section className="experiment-page retired-scene">
      <Pane title={r.title} sub={`Retired ${r.retiredOn ?? "29 Sep 2026"}`}>
        <p>{r.reason}</p>
        <p>
          {r.instead && (
            <>
              <a href={r.instead.href}>{r.instead.label} →</a>
              {" · "}
            </>
          )}
          {r.record && (
            <>
              <a href={`/data/${r.record}.json`} download>
                Download the recorded run
              </a>
              {" · "}
            </>
          )}
          <a href="#/">All experiments</a>
        </p>
      </Pane>
    </section>
  );
}

/** A link to a scene that never existed: say so, instead of quietly showing the first scene. */
function UnknownScene({ id }: { id: string }) {
  return (
    <section className="experiment-page retired-scene">
      <Pane title="No experiment here">
        <p>
          There is no experiment called “{id}”. It may have been renamed, or the link has a typo.
        </p>
        <p>
          <a href="#/">All experiments</a>
        </p>
      </Pane>
    </section>
  );
}

export function ExperimentPage({ id }: { id: string }) {
  if (retiredScene(id)) return <RetiredScene id={id} />;

  return liveScene(id) ? <LiveExperimentPage id={id} /> : <UnknownScene id={id} />;
}

function LiveExperimentPage({ id }: { id: string }) {
  const exp = lookup(id),
    [recordSlot, setRecordSlot] = useState<{ id: string; value: any } | null>(null),
    [composition, setComposition] = useState<any>(null),
    [error, setError] = useState(""),
    [aboutOpen, setAboutOpen] = useState(false);
  // Game pages keep play first and open their evidence in a drawer instead of the inline fold.
  const drawer = exp.format === "game";
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
    // Scenes without a published record bring their own data.
    if (exp.record === null) {
      setRecord({ result: {} });
      return () => {
        alive = false;
      };
    }
    load(exp.loads ?? recordUrl(exp.record))
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
    const companion = exp.companion;
    if (!companion || composition) return;
    let alive = true;
    load(recordUrl(companion))
      .then((r) => alive && setComposition(r.result))
      .catch(() => {});
    return () => { alive = false; };
  }, [id, composition]);
  const about = (
    <>
      {note && <p><a href={`#/notes/${note.slug}`}>Read the note: {note.title} →</a></p>}
      {record && !exp.ownProvenance && <Provenance result={record.result ?? {}} />}
    </>
  );
  const downloadLink = (
    <a href={recordUrl(exp.companion ?? exp.record ?? "")} download>
      Download evidence ↓
    </a>
  );
  return (
    <section className="detail published-experiment">
      <div className="breadcrumbs">
        <a href="#/">
          <ArrowLeft size={13} /> All experiments
        </a>
        <span>/</span>
        <span>{exp.category}</span>
      </div>
      <header className="scene-head">
        <div>
          <h1>{exp.title}</h1>
          <p className="scene-head-line">{exp.description}</p>
          <p className="scene-head-question">{exp.question}</p>
          {record && <SourceCredit result={record.result ?? {}} />}
        </div>
        {drawer ? (
          <button type="button" aria-haspopup="dialog" aria-expanded={aboutOpen} onClick={() => setAboutOpen(true)}>About & evidence</button>
        ) : (
          <button type="button" aria-expanded={aboutOpen} aria-controls="experiment-background" onClick={() => setAboutOpen(open => !open)}>About & evidence</button>
        )}
      </header>
      {drawer ? (
        <EvidenceDrawer
          open={aboutOpen}
          onClose={() => setAboutOpen(false)}
          title={exp.title}
          tabs={gameEvidence(id, note || record?.result?.provenance ? about : null, record?.manifest ? <p>{downloadLink}</p> : null)}
        />
      ) : (
        <section id="experiment-background" className="scene-head-evidence" hidden={!aboutOpen} aria-label="About this experiment">
          {about}
        </section>
      )}
      {exp.strip !== "after" && <HeadlineStrip id={id} title={exp.title} />}
      {error && <Notice error>{error}</Notice>}
      {record ? (
        <Suspense
          fallback={
            <div className="loading-stage">
              <span className="loader" /> Opening the experiment…
            </div>
          }
        >
          <RecordDate.Provider value={String(record.manifest?.created ?? record.manifest?.prepared_at ?? "") || null}>
            <View
              key={id}
              scene={exp}
              result={record.result ?? {}}
              composition={composition}
            />
          </RecordDate.Provider>
        </Suspense>
      ) : (
        <div className="loading-stage">
          <span className="loader" /> Opening the experiment…
        </div>
      )}
      {exp.strip === "after" && record && <HeadlineStrip id={id} title={exp.title} />}
      {/* Report pages give their data and date in their own Data and Cite sections. */}
      {record?.manifest && exp.format !== "report" && (
        <p className="record-footer">
          {/* Older records name their date prepared_at; say only what's there. */}
          {(() => {
            const day = String(record.manifest?.created ?? record.manifest?.prepared_at ?? "").slice(0, 10);

            return day ? `Recorded ${day} · ` : "Recorded run · ";
          })()}
          {record.manifest?.experiment ?? exp.id} ·{" "}
          {downloadLink}
        </p>
      )}
    </section>
  );
}
