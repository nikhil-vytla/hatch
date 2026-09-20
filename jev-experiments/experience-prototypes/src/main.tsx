import React, { useEffect, useState, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig, motion } from "motion/react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Search,
  Sun,
  Moon,
  Monitor,
  KeyRound,
  X,
  Play,
  FlaskConical,
  PanelLeft,
  Columns3,
  BookOpen,
  Check,
  ChevronDown,
} from "lucide-react";
import { experiments, categories, lookup, type Experiment } from "./catalog";
import { MotionArt } from "./motion-art";
import { Pane, Button, Field, Notice, State, Stat } from "./shared";
import {
  Paste,
  SemanticTable,
  UndoExperiment,
  Changes,
} from "./new-experiments";
import { GeneratedUI } from "./generated-ui";
import { Worlds, Pixels, Music } from "./creative";
import { Games, GameGrid } from "./games";
import { Benchmarks, Learning } from "./benchmarks";
import { AgentExperiment, Beverage } from "./agent-experiments";
import { Logos, Decisions, Vision, Adapters } from "./misc";
import { Journeys } from "./journeys";
import { token } from "./api";
import "./style.css";
const cache = new Map<string, any>();
async function load(name: string) {
  if (!cache.has(name)) {
    const response = await fetch(`/data/${name}.json`);
    if (!response.ok) throw new Error("No recorded run is attached yet.");
    cache.set(name, await response.json());
  }
  return cache.get(name);
}
function Header() {
  const [theme, setTheme] = useState(
      localStorage.getItem("jev-theme") ?? "system",
    ),
    [open, setOpen] = useState(false),
    [key, setKey] = useState(token());
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme:dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      localStorage.setItem("jev-theme", theme);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <>
      <header className="site-header">
        <a href="#" className="brand">
          <span className="brandmark">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <strong>jev</strong>
          <span className="brand-edition">a living laboratory</span>
        </a>
        <nav>
          <a href="#">Experiments</a>
          <a href="#about">Field notes</a>
          <div className="theme-picker" aria-label="Color theme">
            {[
              ["light", Sun],
              ["dark", Moon],
              ["system", Monitor],
            ].map(([t, I]: any) => (
              <button
                key={t}
                title={t + " theme"}
                aria-label={t + " theme"}
                aria-pressed={theme === t}
                className={theme === t ? "active" : ""}
                onClick={() => setTheme(t)}
              >
                <I size={15} />
              </button>
            ))}
          </div>
          <button
            className={"key-button " + (key ? "connected" : "")}
            onClick={() => setOpen(true)}
          >
            <KeyRound size={14} />
            <span>{key ? "Live connected" : "Connect live"}</span>
          </button>
        </nav>
      </header>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="token-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close-button"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">LIVE EXPERIMENTS</span>
            <h2 id="token-title">Bring your curiosity.</h2>
            <p>
              Recorded runs are open to everyone. Enter the private lab token to
              send your own inputs to Jev. Your token stays in this tab’s
              session.
            </p>
            <Field label="Lab access token">
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <Button
              onClick={() => {
                sessionStorage.setItem("jev-live-token", key);
                setOpen(false);
              }}
            >
              Connect to the lab <ArrowRight size={15} />
            </Button>
          </section>
        </div>
      )}
    </>
  );
}
function MiniPreview({ kind }: { kind: string }) {
  if (kind === "worlds") return <MotionArt small scene="garden" />;
  if (kind === "pixels")
    return (
      <div className="mini-pixels">
        {Array.from({ length: 144 }, (_, i) => (
          <i
            key={i}
            style={{
              background: [
                28, 29, 30, 31, 39, 40, 41, 42, 43, 44, 51, 52, 53, 54, 55, 56,
                63, 64, 65, 66, 67, 68, 76, 77, 78, 79, 89, 101, 113,
              ].includes(i)
                ? i > 80
                  ? "#87a186"
                  : "#d48a6c"
                : i % 19 === 0
                  ? "#e6d3a7"
                  : "#233e38",
            }}
          />
        ))}
      </div>
    );
  if (kind === "music")
    return (
      <div className="mini-music">
        {Array.from({ length: 28 }, (_, i) => (
          <i
            key={i}
            style={{
              height: 18 + ((i * 17) % 53),
              animationDelay: (i % 7) * -0.24 + "s",
            }}
          />
        ))}
        <div className="mini-music-line" />
      </div>
    );
  if (kind === "ui")
    return (
      <div className="mini-ui">
        <div />
        <span />
        <span />
        <label />
        <label />
        <span className="mini-save">
          Save changes <ArrowRight size={10} />
        </span>
        <i className="mini-cursor">
          <ArrowUpRight size={14} />
        </i>
      </div>
    );
  if (kind === "paste")
    return (
      <div className="mini-paste">
        <div className="mini-source">
          <span />
          <span />
          <span />
          <span />
        </div>
        <ArrowRight size={19} />
        <div className="mini-destination">
          <span />
          <span />
          <span />
        </div>
        <i className="transfer-dot" />
      </div>
    );
  if (kind === "games")
    return (
      <div className="mini-game">
        {Array.from({ length: 25 }, (_, i) => (
          <i
            key={i}
            className={
              [
                0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 21, 22, 23, 24,
              ].includes(i)
                ? "wall"
                : i === 18
                  ? "goal"
                  : ""
            }
          >
            {i === 7 ? (
              <span className="mini-agent" />
            ) : i === 12 ? (
              <KeyRound size={12} />
            ) : null}
          </i>
        ))}
      </div>
    );
  if (kind === "logos")
    return (
      <svg className="mini-mark" viewBox="0 0 160 120">
        <g fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M80 98C17 61 47 9 113 15C139 71 109 105 80 98ZM80 98 103 34" />
        </g>
      </svg>
    );
  if (["reward", "teach", "replica", "optimize", "latency"].includes(kind))
    return (
      <svg className="mini-chart" viewBox="0 0 220 120">
        <path
          d="M20 100H200M20 65H200M20 30H200"
          stroke="currentColor"
          opacity=".12"
        />
        <path
          d="M20 95C55 96 51 60 85 61S144 43 200 22"
          fill="none"
          stroke="var(--coral)"
          strokeWidth="3"
        />
        <path
          d="M20 96C49 69 68 26 91 39S150 57 200 48"
          fill="none"
          stroke="var(--sage)"
          strokeWidth="3"
        />
      </svg>
    );
  if (["judge", "classify", "robustness", "language"].includes(kind))
    return (
      <div className="mini-answers">
        <div>
          <strong>A</strong>
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>
            B <Check size={12} />
          </strong>
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  return (
    <div className="mini-nodes">
      <i />
      <span />
      <i />
      <span />
      <i />
    </div>
  );
}
function Home() {
  const [category, setCategory] = useState("All"),
    [query, setQuery] = useState("");
  const matches = experiments.filter(
    (e) =>
      (category === "All" || e.category === category) &&
      `${e.title} ${e.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className="home">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <i className="live-dot" /> FIELD NOTES / 002
          </span>
          <h1>
            Small decisions.
            <br />
            <em>Wonderful possibilities.</em>
          </h1>
          <p>
            A playground for what happens when intelligence is abundant. Make
            something, follow a decision, and see what changes.
          </p>
          <div className="hero-actions">
            <a className="button" href="#experiment/ui">
              Make an interface <ArrowUpRight size={16} />
            </a>
            <a className="text-link" href="#experiment/paste">
              Try a smarter paste <ArrowRight size={15} />
            </a>
          </div>
          <span className="hero-footnote">
            LIVE EXPERIMENTS · RECORDED EVIDENCE · OPEN QUESTIONS
          </span>
        </div>
        <a className="hero-window" href="#experiment/worlds">
          <MotionArt scene="garden" />
          <div className="hero-window-caption">
            <div>
              <span>NOW PLAYING</span>
              <strong>A quiet world, coming to life</strong>
            </div>
            <span className="round-arrow">
              <ArrowUpRight size={22} />
            </span>
          </div>
        </a>
      </section>
      <div className="editorial-strip">
        <span>
          <strong>29</strong> directions to explore
        </span>
        <span>
          <i className="live-dot" /> Motion, music, and meaningful decisions
        </span>
        <a href="#experiment/judge">
          Read the evidence yourself <ArrowUpRight size={14} />
        </a>
      </div>
      <section className="collection">
        <div className="collection-heading">
          <div>
            <span className="eyebrow">THE COLLECTION</span>
            <h2>Pick a thread. See where it goes.</h2>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an experiment"
            />
          </label>
        </div>
        <div className="category-tabs">
          {categories.map((c) => (
            <button
              className={category === c ? "active" : ""}
              key={c}
              onClick={() => setCategory(c)}
            >
              {c}
              {c === "All" && <small>{experiments.length}</small>}
            </button>
          ))}
        </div>
        <div className="experiment-grid">
          {matches.map((e, i) => (
            <motion.a
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: (i % 3) * 0.04, duration: 0.3 }}
              className={`experiment-card ${e.accent}`}
              href={`#experiment/${e.id}`}
              key={e.id}
            >
              <div className="card-preview">
                <MiniPreview kind={e.kind} />
                <span className="card-open">
                  <ArrowUpRight size={17} />
                </span>
              </div>
              <div className="card-body">
                <div className="card-meta">
                  <span>{e.category}</span>
                  <span>
                    {String(experiments.indexOf(e) + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3>{e.title}</h3>
                <p>{e.description}</p>
              </div>
            </motion.a>
          ))}
        </div>
      </section>
      <section className="about" id="about">
        <span className="eyebrow">A LABORATORY, NOT A LEADERBOARD</span>
        <h2>
          Good questions deserve
          <br />
          experiments you can touch.
        </h2>
        <p>
          Jev makes fast, typed judgments. Here, those judgments become
          interfaces, music, images, and small pieces of useful software. Each
          experiment exposes what the model did, what the surrounding code
          supplied, and what the result actually establishes.
        </p>
        <div className="about-links">
          <a
            href="https://docs.typesafe.ai/introduction"
            target="_blank"
            rel="noreferrer"
          >
            Meet Jev ↗
          </a>
          <a href="/research/EXPERIENCE_PROTOTYPES.md">Read the research ↗</a>
          <a href="/companion.zip" download>
            Get the paste companion ↓
          </a>
        </div>
      </section>
    </main>
  );
}
function View({
  exp,
  result,
  composition,
}: {
  exp: Experiment;
  result: any;
  composition: any;
}) {
  switch (exp.id) {
    case "paste":
      return <Paste record={result} />;
    case "semantic-table":
      return <SemanticTable record={result} />;
    case "undo":
      return <UndoExperiment record={result} />;
    case "changes":
      return <Changes record={result} />;
    case "ui":
      return <GeneratedUI record={composition} />;
    case "worlds":
      return <Worlds result={result} />;
    case "pixels":
      return <Pixels result={result} />;
    case "music":
      return <Music result={result} />;
    case "games":
      return <Games result={result} />;
    case "logos":
      return <Logos result={result} />;
    case "decisions":
      return <Decisions result={result} />;
    case "vision":
      return <Vision result={result} />;
    case "adapters":
      return <Adapters result={result} />;
    case "beverage":
      return <Beverage result={result} />;
    case "journeys":
      return <Journeys record={result} />;
    case "judge":
    case "classify":
    case "robustness":
    case "language":
      return <Benchmarks id={exp.id} result={result} />;
    case "reward":
    case "teach":
    case "replica":
    case "optimize":
    case "latency":
      return <Learning id={exp.id} result={result} />;
    default:
      return <AgentExperiment id={exp.id} result={result} />;
  }
}
const variantNames = ["studio", "comparison", "notebook"];
function Detail({ id }: { id: string }) {
  const exp = lookup(id),
    [record, setRecord] = useState<any>(null),
    [composition, setComposition] = useState<any>(null),
    [error, setError] = useState(""),
    [variant, setVariant] = useState(
      new URL(location.href).searchParams.get("variant") ?? "studio",
    );
  useEffect(() => {
    let alive = true;
    setRecord(null);
    setError("");
    load(exp.data)
      .then((r) => {
        if (alive) setRecord(r);
      })
      .catch((e) => {
        if (alive) {
          setError(e.message);
          setRecord({ result: {} });
        }
      });
    if (id === "ui")
      load("composed-ui")
        .then((r) => alive && setComposition(r.result))
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  const change = (v: string) => {
    setVariant(v);
    const u = new URL(location.href);
    u.searchParams.set("variant", v);
    history.replaceState(null, "", u);
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest("input,textarea,select,[contenteditable],.react-flow")
      )
        return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = variantNames.indexOf(variant);
        change(variantNames[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [variant]);
  return (
    <main className={"detail variant-" + variant}>
      <div className="breadcrumbs">
        <a href="#">
          <ArrowLeft size={13} /> All experiments
        </a>
        <span>/</span>
        <span>{exp.category}</span>
      </div>
      <section className="detail-heading">
        <div>
          <span className="eyebrow">
            EXPERIMENT {String(experiments.indexOf(exp) + 1).padStart(2, "0")} /{" "}
            {exp.category.toUpperCase()}
          </span>
          <h1>{exp.title}</h1>
          <p>{exp.description}</p>
        </div>
        <div className="experiment-question">
          <FlaskConical size={17} />
          <p>{exp.question}</p>
        </div>
      </section>
      <div className="notebook-intro">
        <span className="eyebrow">THE OPEN QUESTION</span>
        <h2>{exp.question}</h2>
        <p>
          Work through the example, change one thing, and inspect the resulting
          state. Recorded outcomes remain separate from your exploratory runs.
        </p>
      </div>
      {error && <Notice error>{error}</Notice>}
      {record ? (
        <View
          key={id}
          exp={exp}
          result={record.result ?? {}}
          composition={composition}
        />
      ) : (
        <div className="loading-stage">
          <span className="loader" /> Opening the experiment…
        </div>
      )}
      <div className="comparison-notes">
        <Pane title="Compare what changed">
          <p>
            Use the revision history, candidate alternatives, and state
            inspector beside the artifact. A change in a model score is
            different from an independently better result.
          </p>
          <div className="comparison-legend">
            <span>Input</span>
            <ArrowRight size={15} />
            <span>Decision</span>
            <ArrowRight size={15} />
            <span>Visible outcome</span>
          </div>
        </Pane>
      </div>
      {record?.manifest && (
        <p className="record-footer">
          Recorded {String(record.manifest.created ?? "").slice(0, 10)} ·{" "}
          {record.manifest.experiment ?? exp.id} ·{" "}
          <a
            href={`/data/${id === "ui" ? "composed-ui" : exp.data}.json`}
            download
          >
            Download evidence ↓
          </a>
        </p>
      )}
      <div className="prototype-switcher">
        <button
          aria-label="Previous layout"
          onClick={() =>
            change(variantNames[(variantNames.indexOf(variant) + 2) % 3])
          }
        >
          <ArrowLeft size={15} />
        </button>
        <span>LAYOUT STUDY</span>
        {variantNames.map((v, i) => {
          const Icon = [PanelLeft, Columns3, BookOpen][i];
          return (
            <button
              className={v === variant ? "active" : ""}
              key={v}
              onClick={() => change(v)}
            >
              <Icon size={14} />
              {v}
            </button>
          );
        })}
        <button
          aria-label="Next layout"
          onClick={() =>
            change(variantNames[(variantNames.indexOf(variant) + 1) % 3])
          }
        >
          <ArrowRight size={15} />
        </button>
      </div>
    </main>
  );
}
function App() {
  const [route, setRoute] = useState(location.hash);
  useEffect(() => {
    const fn = () => {
      setRoute(location.hash);
      if (location.hash !== "#about") window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  const id = route.startsWith("#experiment/") ? route.split("/")[1] : null;
  return (
    <MotionConfig reducedMotion="user">
      <Header />
      {id ? <Detail key={id} id={id} /> : <Home />}
      <footer className="site-footer">
        <a className="brand" href="#">
          <strong>jev</strong>
          <span>field notes / 002</span>
        </a>
        <p>Original experiments. Real decisions. Plenty left to discover.</p>
        <a href="https://docs.typesafe.ai/introduction">TypeSafe ↗</a>
      </footer>
    </MotionConfig>
  );
}
const container = document.getElementById("root")!;
const root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<App />);
