import { experimentNotes, listedNotes } from "./manifest";
import { ScoreNote } from "./score-note";
import { CrowdNote } from "./crowd-note";
import { RoutingNote } from "./routing-note";
import { MusicNote } from "./music-note";
import "./notes.css";
export { experimentNotes } from "./manifest";

function NoteGlyph({ number }: { number: string }) {
  return (
    <span className={`note-glyph note-glyph-${number}`} aria-hidden="true">
      {number === "01" ? (
        <>
          <i />
          <i />
          <i />
          <b />
        </>
      ) : number === "02" ? (
        <>
          <i />
          <i />
          <i />
          <b>↗</b>
        </>
      ) : (
        <>
          <i />
          <i />
          <i />
          <i />
          <b>1</b>
        </>
      )}
    </span>
  );
}

export function NotesIndex() {
  return (
    <section
      className="experiment-notes notes-index"
      aria-labelledby="notes-heading"
    >
      <header className="notes-intro">
        <p className="note-kicker">Jev experiments / field notes</p>
        <h1 id="notes-heading">Look a little closer.</h1>
        <p>
          What a decision means, where it takes effect, and what the experiment
          actually showed. Read the code. Change a case.
        </p>
      </header>
      <ol className="notes-list">
        {listedNotes.map((note) => (
          <li key={note.slug}>
            <span className="note-number">{note.number}</span>
            <div>
              <p className="note-kicker">
                {note.category} <span>· {note.mode}</span>
              </p>
              <h2>
                <a href={`#/notes/${note.slug}`}>
                  {note.title}
                  <span aria-hidden="true"> ↗</span>
                </a>
              </h2>
              <p>{note.description}</p>
              <time dateTime={note.date}>22 September 2026</time>
            </div>
            <NoteGlyph number={note.number} />
          </li>
        ))}
      </ol>
      <p className="notes-colophon">
        The figures follow the explorable-writing tradition of{" "}
        <a href="https://worrydream.com/ExplorableExplanations/">Bret Victor</a>{" "}
        and{" "}
        <a href="https://www.redblobgames.com/pathfinding/a-star/introduction.html">
          Amit Patel
        </a>
        : put a changeable example next to the rule that explains it. The
        observations here come from this lab.
      </p>
    </section>
  );
}

export function ExperimentNote({ slug }: { slug: string }) {
  if (slug === experimentNotes[0].slug) return <ScoreNote />;
  if (slug === experimentNotes[1].slug) return <CrowdNote />;
  if (slug === experimentNotes[2].slug) return <RoutingNote />;
  if (slug === experimentNotes[3].slug) return <MusicNote note={experimentNotes[3]} />;
  return (
    <section className="experiment-notes notes-missing">
      <h1>That note is not here.</h1>
      <a href="#/notes">Browse the notes →</a>
    </section>
  );
}
