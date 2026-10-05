import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { scenes, categories, type Diagram } from "../scenes";
import { listedNotes } from "../notes/manifest";
import { FoolJev } from "../fool-jev";
import { cardLineFor, homeHeadline, ShareCardButton } from "../headline-strip";
import { diagramText, SceneDiagram } from "../scene-diagrams";
import { StartHere } from "../start-here";
import "./play.css";


/** What the prose studies and Fool Jev found, verdict first, computed at build time from their records. */
const home = homeHeadline();

/** How the scene asks Jev, drawn small, with the same thing in words for screen readers. */
function CardDiagram({ d }: { d: Diagram }) {
  return (
    <span className="card-diagram">
      <SceneDiagram d={d} />
      <span className="sr-only">{diagramText(d)}</span>
    </span>
  );
}

/** One real result: the scene's headline line, or how many recorded answers it holds. */
function CardResult({ id }: { id: string }) {
  const c = cardLineFor(id);

  return c ? <p className={c.fromHeadline ? "card-result" : "card-result card-result-count"}>{c.line}</p> : null;
}

// A plan for future work is available from About, not advertised as a playground.
const catalog = scenes;
export function PlayPage() {
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const matches = catalog.filter((experiment) =>
    (category === "All" || experiment.category === category) &&
    `${experiment.title} ${experiment.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <main className="play-page" id="main-content" tabIndex={-1}>
      <div className="toybox home-band">
        <section className="home-hero" aria-labelledby="play-title">
          <div>
            <h1 id="play-title">
              Jev's hard to fool. <mark>Not impossible.</mark>
            </h1>
            <p className="home-sub">
              We asked it 2,626 questions, up to 78 ways each. Rewording almost never changed its answer. One kind of
              sentence did. Your turn.
            </p>
          </div>
          <FoolJev />
        </section>

        {home && <section className="home-findings" aria-labelledby="findings-heading">
          <div className="home-findings-head">
            <h2 id="findings-heading">What 2,626 questions found</h2>
            <a href="#experiment/prose">Read the study</a>
            <ShareCardButton id="home" title="Fool Jev" share={home.share} />
          </div>
          <ol>
            {home.findings.map((f) => (
              <li key={f.title}>
                <span className="n">{f.n}</span>
                <h3>{f.title}</h3>
                <p>
                  {f.body}
                  {f.href && (
                    <>
                      {" "}
                      <a href={f.href}>Try it</a>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        </section>}
      </div>

      <StartHere />

      <section className="play-notes" aria-labelledby="recent-notes-heading">
        <div className="play-section-heading">
          <div>
            <p className="play-kicker">From the notebook</p>
            <h2 id="recent-notes-heading">What happened, and why.</h2>
          </div>
          <a href="#/notes">All notes <ArrowUpRight size={15} /></a>
        </div>
        <ol>
          {listedNotes.map((note) => (
            <li key={note.slug}>
              <span className="play-note-number" aria-hidden="true">{note.number}</span>
              <a href={`#/notes/${note.slug}`}>
                <span className="play-kicker">{note.category}</span>
                <h3>{note.title}<ArrowUpRight size={18} /></h3>
                <p>{note.description}</p>
              </a>
              <span className="play-note-mode">{note.mode}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="play-catalog" id="collection" aria-labelledby="catalog-heading">
        <div className="play-section-heading">
          <div>
            <p className="play-kicker">Experiments & studies</p>
            <h2 id="catalog-heading">The collection</h2>
          </div>
          <label className="play-search">
            <Search size={17} aria-hidden="true" />
            <input aria-label="Find an experiment" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an experiment" type="search" />
          </label>
        </div>
        <div className="play-filters" role="group" aria-label="Experiment category">
          {categories.map((name) => (
            <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>
          ))}
        </div>
        <p className="play-result-count" aria-live="polite">{matches.length} {matches.length === 1 ? "entry" : "entries"}</p>
        <div className="play-catalog-list">
          {matches.map((experiment) => (
            <a key={experiment.id} href={`#experiment/${experiment.id}`}>
              <CardDiagram d={experiment.diagram} />
              <span className="play-catalog-category">{experiment.category}</span>
              <h3>{experiment.title}</h3>
              <CardResult id={experiment.id} />
              <p>{experiment.description}</p>
              <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          ))}
        </div>
        {matches.length === 0 && (
          <div className="play-no-results">
            <p>No experiments match those filters.</p>
            <button onClick={() => { setQuery(""); setCategory("All"); }}>Clear filters</button>
          </div>
        )}
      </section>
    </main>
  );
}
