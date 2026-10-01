import type { ReactNode } from "react";
import { retiredScene } from "../catalog";
import type { Note } from "./manifest";

/** "2026-09-22" → "22 September 2026", read as a calendar date (no time zone shift). */
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

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
          <time dateTime={note.date}>{longDate(note.date)}</time>
        </p>
      </header>
      {children}
      <footer className="note-end">
        <p>
          Written {longDate(note.date)}. Figures read committed evidence or the
          current imported source; recording dates are shown separately.
        </p>
        <a href={`#experiment/${note.scene}`}>
          {retiredScene(note.scene) ? "Why the experiment was retired →" : "Open the experiment →"}
        </a>
        <a href="#/notes">More notes →</a>
      </footer>
    </article>
  );
}
