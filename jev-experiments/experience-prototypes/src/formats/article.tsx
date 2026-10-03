/**
 * The article format, for a clean single finding (after Distill's "Why Momentum Really Works"):
 * one live figure as the hero, then method, findings, limits and data in the body, and a citation.
 * It sits under the compact scene header; a page with a headline strip lets the strip carry the
 * verdict, so the article doesn't repeat it.
 */
import type { ReactNode } from "react";
import "./formats.css";

export function Article({
  verdict,
  byline,
  hero,
  caption,
  children,
  cite,
  notes,
  full,
}: {
  /** Omit when the page's headline strip already states the verdict. */
  verdict?: ReactNode;
  byline: ReactNode;
  hero: ReactNode;
  caption: ReactNode;
  children: ReactNode;
  cite: ReactNode;
  notes?: ReactNode[];
  /** The full scene, folded away so the hero stays one figure. */
  full?: { label: string; content: ReactNode };
}) {
  return (
    <article className="fmt-article">
      {verdict && <p className="fmt-verdict">{verdict}</p>}
      <p className="fmt-byline">{byline}</p>
      <figure className="fmt-hero">
        {hero}
        <figcaption>{caption}</figcaption>
      </figure>
      {children}
      {cite}
      {notes && notes.length > 0 && (
        <footer className="fmt-notes">
          <ol>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ol>
        </footer>
      )}
      {full && (
        <details className="fmt-full-scene">
          <summary>{full.label}</summary>
          {full.content}
        </details>
      )}
    </article>
  );
}
