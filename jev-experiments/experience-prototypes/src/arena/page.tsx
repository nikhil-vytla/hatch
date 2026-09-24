import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import type { ArenaIndex, Card } from "../../../packages/arena/src/data/schema";
import { getApiKey } from "../api";
import { CaseView } from "./case";
import { Bars, Calibration, PerSeed, Scatter } from "./charts";
import { defaults, formatValue, loadIndex, readView, viewHash, type View } from "./data";
import { caption, colorVars, compareBy, LENS_LABEL, useCardModel, type CardModel } from "./model";
import { Picker } from "./picker";
import { Table } from "./table";
import { Watch } from "./watch";
import "./arena.css";

const FAMILY: Record<Card["family"], string> = {
  game: "Game",
  "judgement-set": "Judgement set",
  robustness: "Robustness",
};

const REFERENCE: Record<Card["reference"], string> = {
  "world-outcome": "measured in the game",
  "soft-teacher": "agreement with a soft reference",
  "authored-labels": "agreement with authored expectations",
  "self-consistency": "consistency with itself",
};

/** A small bar sketch of a card's default lineup on its primary metric. */
function Sketch({ card }: { card: Card }) {
  const metric = card.metrics.find((m) => m.id === card.primary) ?? card.metrics[0];
  const [, max] = metric.domain ?? [0, 1];

  const rows = defaults(card, card.protocolGroups.at(-1)?.hash)
    .flatMap((id) => {
      const e = card.results[id]?.[metric.id];
      const c = card.contestants.find((x) => x.id === id);

      return e && c ? [{ id, e, c }] : [];
    })
    .sort((a, b) => compareBy(metric, a.e.value, b.e.value))
    .slice(0, 5);

  return (
    <svg className="sketch" viewBox="0 0 160 92" aria-hidden="true">
      <rect className="sketch-frame" x="0.5" y="0.5" width="159" height="91" />
      {rows.map((r, i) => (
        <rect
          key={r.id}
          className="sketch-bar"
          style={colorVars(r.c)}
          x="12"
          y={12 + i * 15}
          width={Math.max(3, (r.e.value / (max || 1)) * 136)}
          height="9"
        />
      ))}
    </svg>
  );
}

function Overview({ index }: { index: ArenaIndex }) {
  const generated = new Date(index.generatedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="journal">
      <header className="masthead">
        <p className="kicker">Arena · {generated}</p>
        <h1>Same question, different minds</h1>
        <p className="lede">
          Each entry puts one situation to several decision-makers and records what happened. The
          figures are live: add or remove contestants, change the measure, or replay the games.
          Recorded results need no key.
        </p>
      </header>
      <ol className="toc">
        {index.cards.map((card, i) => (
          <li key={card.id}>
            <a href={viewHash({ card: card.id })}>
              <Sketch card={card} />
              <span>
                <span className="kicker">
                  Fig. {i + 1} · {FAMILY[card.family]}
                </span>
                <h2>{card.title}</h2>
                <span className="toc-insight">{card.insight ?? card.question}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function KeyNumbers({ model: m }: { model: CardModel }) {
  if (!m.tiles.length) return null;

  return (
    <section className="margin-block">
      <h2 className="kicker">Best in this figure</h2>
      <ul className="keys">
        {m.tiles.map(({ metric, winners, estimate }) => (
          <li key={metric.id}>
            <span className="muted">{metric.label}</span>
            <b>{formatValue(metric, estimate)}</b>
            <span>
              {winners
                .slice(0, 3)
                .map((id) => m.nameOf(id, true))
                .join(", ")}
              {winners.length > 3 ? ` +${winners.length - 3}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {m.models.length > 0 && m.models.length < m.shown.length && (
        <p className="muted small">
          Among models only. Code players are references and appear in every view.
        </p>
      )}
    </section>
  );
}

function LensBody({ model: m }: { model: CardModel }) {
  switch (m.lens) {
    case "bars":
      return <Bars model={m} />;
    case "scatter":
      return <Scatter model={m} />;
    case "per-item":
      return <PerSeed model={m} />;
    case "table":
      return <Table model={m} />;
    case "reliability":
      return <Calibration model={m} />;
    case "case":
      return <CaseView model={m} />;
    case "board":
      return <Watch model={m} />;
  }
}

function CardArticle({ card, view }: { card: Card; view: View }) {
  const m = useCardModel(card, view, Boolean(getApiKey()));
  const heading = useRef<HTMLHeadingElement>(null);
  const measureApplies = m.lens === "bars" || m.lens === "per-item";

  const slices =
    card.slices && ["bars", "scatter", "table", "reliability", "case"].includes(m.lens);

  const [x, y] = card.tradeoff ?? [card.metrics[0].id, card.metrics[1]?.id];

  useEffect(() => {
    document.title = `${card.title} · Arena · Jev experiments`;
    heading.current?.focus({ preventScroll: true });
  }, [card.id, card.title]);

  const copy = async () => {
    const url = `${location.origin}${location.pathname}${viewHash({ ...view, card: card.id, c: m.ids, lens: m.lens, m: m.metric.id })}`;

    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", {
        description: "It opens this figure with the same contestants and view.",
      });
    } catch {
      toast("Could not copy the link", { description: url });
    }
  };

  return (
    <article className="journal entry">
      <nav className="crumbs">
        <a href="#/arena">All entries</a>
      </nav>
      <div className="columns">
        <div className="main-column">
          <p className="kicker">
            {FAMILY[card.family]} · {REFERENCE[card.reference]}
          </p>
          <h1 ref={heading} tabIndex={-1}>
            {card.title}
          </h1>
          <p className="lede">{card.question}</p>
          <p className="finding" aria-live="polite">
            {m.finding}
          </p>
          <figure className="figure">
            <div className="figure-controls">
              <Picker model={m} />
              <div className="figure-toolbar">
                <Tabs.Root
                  value={m.lens}
                  onValueChange={(lens) => m.set({ lens })}
                  activationMode="automatic"
                >
                  <Tabs.List className="tabs" aria-label="View">
                    {card.lenses.map((l) => (
                      <Tabs.Trigger key={l} value={l} className="tab">
                        {LENS_LABEL[l]}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>
                </Tabs.Root>
                <label className="measure">
                  <span>{measureApplies ? "Measure" : "Axes"}</span>
                  {measureApplies ? (
                    <select value={m.metric.id} onChange={(e) => m.set({ m: e.target.value })}>
                      {card.metrics.map((mm) => (
                        <option key={mm.id} value={mm.id}>
                          {mm.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <output>
                      {m.lens === "scatter"
                        ? `${card.metrics.find((mm) => mm.id === x)?.label} × ${card.metrics.find((mm) => mm.id === y)?.label}`
                        : "All measures"}
                    </output>
                  )}
                </label>
                {slices && (
                  <>
                    <label className="measure">
                      <span>{card.facetLabels?.workflow ?? "Workflow"}</span>
                      <select
                        value={view.wf ?? ""}
                        onChange={(e) => m.set({ wf: e.target.value || undefined, qt: undefined })}
                      >
                        <option value="">All</option>
                        {Object.keys(card.slices?.workflow ?? {}).map((w) => (
                          <option key={w} value={w}>
                            {w.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    {card.slices?.type && m.lens !== "case" && (
                      <label className="measure">
                        <span>Question type</span>
                        <select
                          value={view.qt ?? ""}
                          onChange={(e) =>
                            m.set({ qt: e.target.value || undefined, wf: undefined })
                          }
                        >
                          <option value="">All</option>
                          {Object.keys(card.slices.type).map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="lens" role="tabpanel" aria-label={LENS_LABEL[m.lens]}>
              <LensBody model={m} />
            </div>
            <figcaption>{caption(m)}</figcaption>
          </figure>
        </div>
        <aside className="margin">
          <KeyNumbers model={m} />
          {card.insight && (
            <section className="margin-block">
              <h2 className="kicker">Our reading</h2>
              <p>{card.insight}</p>
            </section>
          )}
          <section className="margin-block">
            <h2 className="kicker">How we know</h2>
            <p>{card.provenance}</p>
          </section>
          <button type="button" className="text-button" onClick={() => void copy()}>
            Copy a link to this view
          </button>
        </aside>
      </div>
    </article>
  );
}

function Skeleton({ entry }: { entry: boolean }) {
  return (
    <div className="journal skeleton" aria-busy="true" aria-label="Loading the arena">
      <div className="sk sk-kicker" />
      <div className="sk sk-title" />
      <div className="sk sk-lede" />
      {entry ? (
        <div className="sk sk-figure" />
      ) : (
        [0, 1, 2].map((i) => <div key={i} className="sk sk-row" />)
      )}
    </div>
  );
}

export function ArenaPage() {
  const [index, setIndex] = useState<ArenaIndex | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(() => readView() ?? { card: "" });

  useEffect(() => {
    loadIndex().then(setIndex, () =>
      setError("The arena data could not be loaded. Locally, rebuild it with bun run build."),
    );
  }, []);

  useEffect(() => {
    const onChange = () => setView(readView() ?? { card: "" });

    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);

    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const card = index?.cards.find((c) => c.id === view.card);

  useEffect(() => {
    if (!view.card) document.title = "Arena · Jev experiments";
    else if (index && !card) document.title = "No such entry · Arena · Jev experiments";
  }, [view.card, index, card]);

  return (
    <main id="main-content" tabIndex={-1} className="arena">
      {error && <p className="notice">{error}</p>}
      {!index && !error && <Skeleton entry={Boolean(view.card)} />}
      {index && !view.card && <Overview index={index} />}
      {index && view.card && !card && (
        <p className="notice">
          There is no entry called “{view.card}”. <a href="#/arena">See all entries</a>.
        </p>
      )}
      {card && <CardArticle key={card.id} card={card} view={view} />}
      <Toaster position="bottom-center" toastOptions={{ className: "toast" }} />
    </main>
  );
}
