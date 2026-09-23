import { Activity, useEffect, useState, useRef, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { ArrowUpRight, ArrowRight, KeyRound, Settings2, X } from "lucide-react";
import { lookup } from "./catalog";
import { Button, Field } from "./shared";
import { getApiKey, setApiKey } from "./api";
import { BuilderCredits } from "../../roadmap/credits";
import { PlayPage } from "./pages/play";
import "./style.css";
import "./pages/reading-workspace.css";

const ExperimentPage = lazy(() => import("./pages/experiment").then(m => ({ default: m.ExperimentPage })));
const AboutPage = lazy(() => import("./pages/about").then(m => ({ default: m.AboutPage })));
const ArenaPage = lazy(() => import("./arena/arena-page").then(m => ({ default: m.ArenaPage })));
const NotesIndex = lazy(() => import("./notes").then(m => ({ default: m.NotesIndex })));
const ExperimentNote = lazy(() => import("./notes").then(m => ({ default: m.ExperimentNote })));

function Header({ route }: { route: string }) {
  const settings = useRef<HTMLDetailsElement>(null);
  const settingsTrigger = useRef<HTMLElement>(null);
  const keyDialog = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState(
      localStorage.getItem("jev-theme") ?? "system",
    ),
    [open, setOpen] = useState(false),
    [key, setKey] = useState(""),
    [connected, setConnected] = useState(!!getApiKey());
  const close = () => {
    setKey("");
    setOpen(false);
    settingsTrigger.current?.focus();
  };
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (settings.current?.open && !settings.current.contains(event.target as Node)) {
        settings.current.open = false;
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key !== "Tab") return;
      const targets = keyDialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href]',
      );
      if (!targets?.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [open]);
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
        <a href="#/" className="brand">
          <span className="brandmark">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <strong>jev</strong>
          <span className="brand-edition">experiments & notes</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#/" aria-current={!route || route === "#" || route === "#/" || route === "#collection" || route.startsWith("#experiment/") ? "page" : undefined}>Play</a>
          <a href="#/arena" aria-current={route.startsWith("#/arena") ? "page" : undefined}>Arena</a>
          <a href="#/notes" aria-current={route.startsWith("#/notes") ? "page" : undefined}>Notes</a>
          <a href="#/about" aria-current={route === "#/about" ? "page" : undefined}>About</a>
          <details className="header-settings" ref={settings} onKeyDown={(event) => {
            if (event.key === "Escape" && event.currentTarget.open) {
              event.preventDefault();
              event.currentTarget.open = false;
              settingsTrigger.current?.focus();
            }
          }}>
            <summary ref={settingsTrigger} aria-label="Settings"><Settings2 size={17} aria-hidden="true"/><span>Settings</span></summary>
            <div className="header-settings-panel">
              <label className="theme-select">
                <span>Theme</span>
                <select aria-label="Color theme" value={theme} onChange={(event) => setTheme(event.target.value)}>
                  <option value="system">Auto</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <button className={"key-button " + (connected ? "connected" : "")}
                aria-label={connected ? "API key added" : "Connect live"}
                onClick={() => { if (settings.current) settings.current.open = false; setOpen(true); }}>
                <KeyRound size={14} aria-hidden="true"/>
                <span>{connected ? "API key added" : "Connect live"}</span>
              </button>
            </div>
          </details>
        </nav>
      </header>
      {open && (
        <div className="modal-backdrop" onClick={close}>
          <section
            ref={keyDialog}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="token-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="close-button" aria-label="Close" onClick={close}>
              <X size={18} />
            </button>
            <span className="eyebrow">LIVE EXPERIMENTS</span>
            <h2 id="token-title">Try it with your key.</h2>
            <p>
              Enter your Vercel AI Gateway API key to run these experiments with
              your own inputs. Usage is billed to your gateway account. Recorded
              examples are free to explore.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!key.trim()) return;
                setApiKey(key);
                setConnected(true);
                close();
              }}
            >
              <Field label="Vercel AI Gateway API key">
                <input
                  type="password"
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                  placeholder={
                    connected ? "Enter a replacement key" : "Paste your API key"
                  }
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              <p className="key-privacy">
                Your key stays in this page’s memory and is cleared on reload or
                disconnect. Requests pass through this app to Vercel AI Gateway;
                the app does not save your key.{" "}
                <a
                  href="https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get an API key <ArrowUpRight size={13} />
                </a>
              </p>
              <div className="key-actions">
                <Button type="submit" disabled={!key.trim()}>
                  {connected ? "Replace API key" : "Use my API key"}{" "}
                  <ArrowRight size={15} />
                </Button>
                {connected && (
                  <Button
                    type="button"
                    secondary
                    onClick={() => {
                      setApiKey("");
                      setConnected(false);
                      close();
                    }}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
function App() {
  const pathRoute = () =>
    location.hash ||
    ({
      "/materials": "#experiment/materials",
      "/routing": "#experiment/routing",
    }[location.pathname.replace(/\/$/, "")] ??
      "");
  const sceneId = (value: string) => value.startsWith("#experiment/") ? value.split("/")[1] : null;
  const [navigation, setNavigation] = useState(() => {
    const route = pathRoute();
    return { route, scene: sceneId(route) };
  });
  const { route, scene } = navigation;
  const currentNavigation = useRef(navigation);
  currentNavigation.current = navigation;
  const scenePosition = useRef<{ y: number; focus: HTMLElement | null } | null>(null);
  const restorePosition = useRef(false);
  useEffect(() => {
    const fn = () => {
      const next = pathRoute();
      const previous = currentNavigation.current;
      const nextScene = sceneId(next);
      if (sceneId(previous.route) && next.startsWith("#/notes")) {
        const focused = document.activeElement;
        scenePosition.current = {
          y: window.scrollY,
          focus: focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement ? focused : null,
        };
      }
      restorePosition.current = previous.route.startsWith("#/notes") && nextScene === previous.scene && nextScene !== null;
      setNavigation({ route: next, scene: nextScene ?? (next.startsWith("#/notes") ? previous.scene : null) });
      if (!next.startsWith("#/notes") && !restorePosition.current) scenePosition.current = null;
      if (location.hash !== "#collection") window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  const id = sceneId(route);
  useEffect(() => {
    if (!restorePosition.current || !scenePosition.current) {
      if (!route.startsWith("#/notes")) return;
      const frame = requestAnimationFrame(() => document.getElementById("main-content")?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
    restorePosition.current = false;
    const position = scenePosition.current;
    const frame = requestAnimationFrame(() => {
      const target = position.focus?.isConnected && position.focus.getClientRects().length
        ? position.focus
        : document.getElementById("main-content");
      target?.focus({ preventScroll: true });
      if (document.activeElement !== target) document.getElementById("main-content")?.focus({ preventScroll: true });
      window.scrollTo(0, position.y);
    });
    return () => cancelAnimationFrame(frame);
  }, [route]);
  useEffect(() => {
    const label = route.startsWith("#/notes/")
      ? route.split("/")[2].replaceAll("-", " ")
      : route.startsWith("#/notes") ? "Notes"
      : route === "#/about" || route === "#about" ? "About"
      : route.startsWith("#/arena") ? "Arena"
      : id ? lookup(id).title : "Play";
    document.title = `${label.charAt(0).toUpperCase()}${label.slice(1)} · Jev experiments`;
  }, [route, id]);
  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        const main = document.getElementById("main-content");
        main?.focus();
        main?.scrollIntoView();
      }}>Skip to content</a>
      <Header route={route} />
      {(scene || route.startsWith("#/notes")) && (
        <main id="main-content" tabIndex={-1}>
          {scene && <Activity mode={id === scene ? "visible" : "hidden"}>
            <Suspense fallback={<div className="loading-stage">Opening the experiment…</div>}>
              <ExperimentPage key={scene} id={scene} />
            </Suspense>
          </Activity>}
          {route.startsWith("#/notes") && <>
            {scene && <nav className="reading-workspace" aria-label="Current experiment">
              <a href={`#experiment/${scene}`}>← Back to {lookup(scene).title}</a>
            </nav>}
            <Suspense fallback={<div className="loading-stage">Opening the notes…</div>}>
              {route === "#/notes" || route === "#/notes/" ? <NotesIndex /> : <ExperimentNote key={route} slug={route.split("/")[2]} />}
            </Suspense>
          </>}
        </main>
      )}
      {route === "#/about" || route === "#about" ? (
        <Suspense fallback={<main className="loading-stage">Opening About…</main>}><AboutPage /></Suspense>
      ) : route.startsWith("#/arena") ? (
        <Suspense fallback={<main className="loading-stage">Opening the arena…</main>}><ArenaPage /></Suspense>
      ) : id || route.startsWith("#/notes") ? null : <PlayPage />}
      <footer className="site-footer">
        <a className="brand" href="#/">
          <strong>jev</strong>
          <span>experiments & notes</span>
        </a>
        <div className="footer-notes">
          <p>An independent lab for typed decisions.</p>
          <p>Not affiliated with or endorsed by TypeSafe AI</p>
          <BuilderCredits />
        </div>
        <a href="https://docs.typesafe.ai/introduction">TypeSafe ↗</a>
      </footer>
    </MotionConfig>
  );
}
const container = document.getElementById("root")!;
const root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<App />);
