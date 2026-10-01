import { useState } from "react";
import { ArrowDown, ArrowUpRight, Search } from "lucide-react";
import { experiments, categories, lookup } from "../catalog";
import { experimentNotes } from "../notes/manifest";
import { MiniExperimentPreview } from "../live-world-preview";
import { starterScore } from "../../../music-arranger-v2/engine";
import { FoolJev } from "../fool-jev";
import "./play.css";


/** What the prose studies found, verdict first. Every number is from a recorded run. */
const findings = [
  {
    n: "5 of 5",
    title: "Doubt flips it",
    body: "\u201cI'm pretty sure the answer is no.\u201d flipped every puzzle above, even Sydney, where no was already right. \u201c\u2026is yes.\u201d flipped none.",
  },
  {
    n: "0 of 140",
    title: "Rewording doesn't",
    body: "Seven ways of asking the same question changed none of 140 answers.",
  },
  {
    n: "7% \u2192 68%",
    title: "Decoys work",
    body: "An option nobody should pick swung an apartment choice.",
    href: "#experiment/decoy",
  },
  {
    n: "1,250 / 1,251",
    title: "Sure means right",
    body: "Answers Jev gave at 90% or more were right every time but once.",
  },
];

const scenes = [
  { id: "music", action: "Play a phrase. Keep the part you like.", label: "Sound & composition" },
  { id: "tetris", action: "Take over. Rewind. Try another landing.", label: "Play & compare" },
  { id: "crowd", action: "Change a notice. Follow one resident.", label: "A world of decisions" },
  { id: "visual-search", action: "Find an artwork. Make a collection.", label: "Search & collect" },
] as const;

// A plan for future work is available from About, not advertised as a playground.
const catalog = experiments;
const openingMelody = starterScore().events.filter(
  (event) => event.phrase === 0 && event.track === "melody" && event.midi !== null,
);

function MusicFigure() {
  return (
    <svg className="play-music-figure" viewBox="0 0 380 208" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((line) => (
        <path key={line} d={`M42 ${50 + line * 23}H338`} />
      ))}
      {openingMelody.map((note) => (
        <rect key={note.id} x={44 + note.beat * 36} y={145 - (note.midi! - 60) * 5}
          width={Math.max(4, note.duration * 36 - 4)} height={9} rx={2} />
      ))}
      <text x="44" y="183">Starter melody, first phrase</text>
    </svg>
  );
}

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

        <section className="home-findings" aria-labelledby="findings-heading">
          <h2 id="findings-heading">What 2,626 questions found</h2>
          <ol>
            {findings.map((f) => (
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
        </section>
      </div>

      <section className="play-selected" aria-labelledby="selected-heading">
        <div className="play-section-heading">
          <h2 id="selected-heading">A few other ways in</h2>
          <a href="#collection">Browse the collection <ArrowDown size={15} /></a>
        </div>
        <div className="play-scenes">
          {scenes.map((scene) => (
            <a className={`play-scene play-scene-${scene.id}`} href={`#experiment/${scene.id}`} key={scene.id}>
              <div className="play-scene-image">
                {scene.id === "music" ? <MusicFigure /> : <MiniExperimentPreview kind={scene.id} />}
              </div>
              <p className="play-kicker">{scene.label}</p>
              <h3>{lookup(scene.id).title}<ArrowUpRight size={18} /></h3>
              <p>{scene.action}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="play-notes" aria-labelledby="recent-notes-heading">
        <div className="play-section-heading">
          <div>
            <p className="play-kicker">From the notebook</p>
            <h2 id="recent-notes-heading">What happened, and why.</h2>
          </div>
          <a href="#/notes">All notes <ArrowUpRight size={15} /></a>
        </div>
        <ol>
          {experimentNotes.map((note) => (
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
              <span className="play-catalog-category">{experiment.category}</span>
              <h3>{experiment.title}</h3>
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
        <a className="play-atlas-link" href="/capabilities.html">See how each experiment uses Jev <ArrowUpRight size={16} /></a>
      </section>
    </main>
  );
}
