/** A citation crediting "Jev experiments" with the recording date. No individual authors. */
import { useState } from "react";
import "./formats.css";

export function Cite({ title, scene, recorded }: { title: string; scene: string; recorded: string }) {
  const [copied, setCopied] = useState(false);
  const year = recorded.slice(0, 4);
  const day = recorded.slice(0, 10);
  // A title ending in its own mark ("…answer key?") takes no extra full stop.
  const titled = /[.?!]$/.test(title) ? title : `${title}.`;
  const text = `Jev experiments (${year}). "${titled}" https://jev-experiments.vercel.app/#experiment/${scene}.${day ? ` Recorded ${day}.` : ""}`;

  return (
    <aside className="fmt-cite" aria-label="Cite this">
      <h2>Cite this</h2>
      <pre>{text}</pre>
      <button type="button" className="fmt-button" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy citation"}
      </button>
    </aside>
  );
}
