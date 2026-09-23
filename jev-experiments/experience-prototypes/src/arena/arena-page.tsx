import { useEffect, useState } from "react";
import type { ArenaIndex } from "../../../packages/arena/src/data/schema";
import { BenchmarkCard, MiniCard } from "./card";
import { loadIndex, readView, type View } from "./data";
import { InstrumentCard, InstrumentOverview } from "./prototype-identity/instrument";
import { StorybookCard, StorybookOverview } from "./prototype-identity/storybook";
import { JournalCard, JournalOverview } from "./prototype-identity/journal";
import { Switcher, VARIANTS } from "./prototype-identity/shared";
import "./arena.css";
import "./prototype-identity/identity.css";

export function ArenaPage() {
  const [index, setIndex] = useState<ArenaIndex | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(() => readView() ?? { card: "" });
  useEffect(() => { loadIndex().then(setIndex, (e) => setError(e.message)); }, []);
  useEffect(() => { const on = () => setView(readView() ?? { card: "" }); window.addEventListener("hashchange", on); window.addEventListener("popstate", on); return () => { window.removeEventListener("hashchange", on); window.removeEventListener("popstate", on); }; }, []);
  const card = index?.cards.find((c) => c.id === view.card);
  // PROTOTYPE: identity variants, selected with ?v=A|B|C and flipped with the floating bar.
  const variant = VARIANTS.some((v) => v.key === view.v) ? view.v! : null;
  useEffect(() => { document.body.classList.remove("proto-A", "proto-B", "proto-C"); if (variant) document.body.classList.add(`proto-${variant}`); return () => document.body.classList.remove("proto-A", "proto-B", "proto-C"); }, [variant]);
  if (variant && index) {
    const Overview = { A: InstrumentOverview, B: StorybookOverview, C: JournalOverview }[variant as "A" | "B" | "C"];
    const CardView = { A: InstrumentCard, B: StorybookCard, C: JournalCard }[variant as "A" | "B" | "C"];
    return (
      <main id="main-content" tabIndex={-1} className="arena-page">
        {card ? <CardView key={`${variant}-${card.id}`} card={card} view={view} /> : <Overview index={index} view={view} />}
        <Switcher view={view} />
      </main>
    );
  }
  return (
    <main id="main-content" tabIndex={-1} className="arena-page">
      {!card && (
        <header className="arena-intro">
          <p className="arena-kicker">Arena · working draft</p>
          <h1>Same question, different minds.</h1>
          <p>Each card is one task. Add or remove contestants, switch between views of the same results, and open a game to watch the recorded runs side by side. Recorded results need no key.</p>
        </header>
      )}
      {error && <p className="arena-notice">{error}</p>}
      {!index && !error && <p className="arena-muted">Loading the arena…</p>}
      {index && !view.card && <div className="arena-grid">{index.cards.map((c) => <MiniCard key={c.id} card={c} />)}</div>}
      {index && view.card && !card && <p className="arena-notice">There is no card called “{view.card}”. <a href="#/arena">See all cards</a>.</p>}
      {card && <>
        <nav className="arena-crumbs"><a href="#/arena">← All cards</a></nav>
        <BenchmarkCard key={card.id} card={card} view={view} />
      </>}
    </main>
  );
}
