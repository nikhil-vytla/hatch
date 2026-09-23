import { useEffect, useState } from "react";
import type { ArenaIndex } from "../../../packages/arena/src/data/schema";
import { BenchmarkCard, MiniCard } from "./card";
import { loadIndex, readView, type View } from "./data";
import "./arena.css";

export function ArenaPage() {
  const [index, setIndex] = useState<ArenaIndex | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(() => readView() ?? { card: "" });
  useEffect(() => { loadIndex().then(setIndex, (e) => setError(e.message)); }, []);
  useEffect(() => { const on = () => setView(readView() ?? { card: "" }); window.addEventListener("hashchange", on); window.addEventListener("popstate", on); return () => { window.removeEventListener("hashchange", on); window.removeEventListener("popstate", on); }; }, []);
  const card = index?.cards.find((c) => c.id === view.card);
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
