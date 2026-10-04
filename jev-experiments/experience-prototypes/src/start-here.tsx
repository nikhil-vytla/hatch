/**
 * Three ways in, one per audience: researchers check our work, everyone plays, engineers build.
 * The home page shows them as card rows; About lists the same paths as links.
 */
import type React from "react";
import { ArrowUpRight } from "lucide-react";
import { lookup } from "./catalog";
import { cardLineFor } from "./headline-strip";
import { DIAGRAMS, diagramText, SceneDiagram } from "./scene-diagrams";

const REPO = "https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments";

type Card = {
  href: string;
  title: string;
  /** What you'll do there, in a few words. */
  action: string;
  /** The catalog scene whose diagram and result line the card shows, if it is one. */
  scene?: string;
  external?: boolean;
};

export type StartPath = { id: string; title: string; who: string; cards: Card[] };

const scene = (id: string, action: string): Card => ({ href: `#experiment/${id}`, title: lookup(id).title, action, scene: id });

export const START_PATHS: StartPath[] = [
  {
    id: "check",
    title: "Check our work",
    who: "For researchers: the question, the method, the uncertainty and the data.",
    cards: [
      scene("prose", "Read how 78 rewordings and one doubt sentence move Jev."),
      scene("decoy", "See an option nobody should pick swing a choice."),
      scene("answer-key", "Change who wrote the key and watch the ranking move."),
      scene("open-decisions", "Compare small open models asked the way SGLang asks."),
    ],
  },
  {
    id: "play",
    title: "Just play",
    who: "Recorded runs, ready in your browser. No key needed.",
    cards: [
      scene("ocean", "Heat the water and see which fish make it."),
      scene("screen-sentry", "Hide a trap in a page and try to hijack the helper."),
      scene("who-said-that", "Watch real meetings sort into speakers and conversations."),
      scene("eyes", "Play Snake from pixels against playing from the facts."),
      { href: "#/decide", title: "Decide", action: "Vote blind on a judgement call, then see how models chose." },
    ],
  },
  {
    id: "build",
    title: "Build with it",
    who: "For engineers: the exact requests, the costs and tools you can run.",
    cards: [
      { href: "#/arena/one-box", title: "One box", action: "Type and watch one text box become the right card, with timing per keystroke." },
      scene("handoff", "Set how sure Jev must be before software acts."),
      { href: `${REPO}/tools/decide-cli`, title: "The jev-lab CLI", action: "Run our studies against Jev or any decision endpoint, with a spend cap.", external: true },
      { href: `${REPO}/extensions/screen-sentry`, title: "Screen sentry extension", action: "Load the Chrome extension that flags injected text on any page.", external: true },
    ],
  },
];

function Diagram({ id }: { id: string }) {
  const d = DIAGRAMS[id];

  if (!d) return null;

  return (
    <span className="card-diagram">
      <SceneDiagram id={id} />
      <span className="sr-only">{diagramText(d)}</span>
    </span>
  );
}

function Result({ id }: { id: string }) {
  const c = cardLineFor(id);

  return c ? <p className={c.fromHeadline ? "card-result" : "card-result card-result-count"}>{c.line}</p> : null;
}

/** The home page rows. */
export function StartHere() {
  return (
    <section className="start-here" aria-labelledby="start-heading">
      <h2 id="start-heading" className="sr-only">
        Start here
      </h2>
      {START_PATHS.map((p) => (
        <div className="start-row" key={p.id} aria-labelledby={`start-${p.id}`}>
          <div className="play-section-heading">
            <div>
              <h2 id={`start-${p.id}`}>{p.title}</h2>
              <p className="start-who">{p.who}</p>
            </div>
          </div>
          <div className="start-cards" style={{ "--cards": p.cards.length } as React.CSSProperties}>
            {p.cards.map((c) => (
              <a
                className="play-scene start-card"
                href={c.href}
                key={c.href}
                {...(c.external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {c.scene && <Diagram id={c.scene} />}
                <h3>
                  {c.title}
                  <ArrowUpRight size={18} aria-hidden="true" />
                </h3>
                <p className="play-scene-action">{c.action}</p>
                {c.scene && <Result id={c.scene} />}
              </a>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** About: the same three paths, as short lists. */
export function StartHereList() {
  return (
    <div className="start-list">
      {START_PATHS.map((p) => (
        <div key={p.id}>
          <h3>{p.title}</h3>
          <p>{p.who}</p>
          <ul>
            {p.cards.map((c) => (
              <li key={c.href}>
                <a href={c.href} {...(c.external ? { target: "_blank", rel: "noreferrer" } : {})}>
                  {c.title}
                </a>{" "}
                <span className="start-list-action">{c.action}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
