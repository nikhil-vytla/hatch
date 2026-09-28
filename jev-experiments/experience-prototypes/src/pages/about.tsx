import { ArrowUpRight } from "lucide-react";
import { BuilderCredits } from "../../../roadmap/credits";
import "./play.css";

export function AboutPage() {
  return (
    <main className="about-page" id="main-content" tabIndex={-1}>
      <header>
        <p className="play-kicker">About this lab</p>
        <h1>Small decisions,<br /><em>visible consequences.</em></h1>
        <p>What happens when a model chooses a material rule, a musical phrase, or the next place a resident walks?</p>
      </header>
      <div className="about-reading">
        <p>Jev Experiments is an independent collection of tools, playable scenes and research notes. It explores <a href="https://docs.typesafe.ai/introduction">TypeSafe AI's Jev</a>, which returns typed choices, probabilities and scores. The code around those decisions makes them useful, and is part of the experiment.</p>
        <p>A model call does not paint each grain or play each note. Local code handles the simulation, direct input and valid actions. The experiment notes show where a model's answer takes effect, alongside the source and evidence.</p>
        <p>The local models are separate experimental adaptations. Their results include weak transfer and sensitivity to option order. Read the <a href="#experiment/local-models">local decision study</a> for the methods, model identities and limitations.</p>
        <h2>How to read an experiment</h2>
        <dl className="about-modes">
          <div><dt>Local</dt><dd>Code or an explicitly identified local model runs the action.</dd></div>
          <div><dt>Recorded</dt><dd>A retained request and response reproduce a past model run.</dd></div>
          <div><dt>Live</dt><dd>Your supplied key runs a new request through the named provider.</dd></div>
          <div><dt>Simulated</dt><dd>An authored assumption drives the result. It is not a measurement.</dd></div>
        </dl>
        <h2>Made with, learned from</h2>
        <p>The site pairs a working instrument with a readable notebook. Its interaction references include <a href="https://www.redblobgames.com/">Amit Patel's Red Blob Games</a>, <a href="https://worrydream.com/ExplorableExplanations/">Bret Victor's explorable explanations</a> and <a href="https://brainfunctioncollapse.com/">Wojciech Dobry's experiments</a>. Credits below distinguish the original models, adapted methods and interface references.</p>
        <p>Type is set in DM Sans, Georgia and IBM Plex Mono. The figures use the experiments' own code and data; selected scene illustrations are drawn in SVG. Motion follows the system's reduced-motion preference.</p>
        <BuilderCredits />
        <div className="about-reading-links">
          <a href="#/notes">Read the notes <ArrowUpRight size={16} /></a>
          <a href="/capabilities.html">Inspect Jev's role <ArrowUpRight size={16} /></a>
          <a href="#experiment/benchmark-atlas">Research directions <ArrowUpRight size={16} /></a>
        </div>
      </div>
    </main>
  );
}
