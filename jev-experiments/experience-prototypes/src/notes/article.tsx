import type { ReactNode } from "react";
import type { Note } from "./manifest";

export function Article({
  note,
  children,
}: {
  note: Note;
  children: ReactNode;
}) {
  return (
    <article
      className="experiment-notes experiment-note"
      aria-labelledby="note-title"
    >
      <a className="note-back" href="#/notes">
        ← All notes
      </a>
      <header className="note-header">
        <p className="note-kicker">
          {note.number} / {note.category}
        </p>
        <h1 id="note-title">{note.title}</h1>
        <p className="note-deck">{note.description}</p>
        <p className="note-byline">
          Jev experiments <span>·</span>{" "}
          <time dateTime={note.date}>22 September 2026</time>
        </p>
      </header>
      {children}
      <footer className="note-end">
        <p>
          Written 22 September 2026. Figures read committed evidence or the
          current imported source; recording dates are shown separately.
        </p>
        <a href={`#experiment/${note.scene}`}>Open the experiment →</a>
        <a href="#/notes">More notes →</a>
      </footer>
    </article>
  );
}
