// The desktop app's window: the workspace's columns of panels over one
// session. Panels read the session model; people rearrange them by
// dragging, which records an edit in the workspace history.
import { closestCorners, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  type ApprovalMode,
  type Decision,
  type Digest,
  type ModelListResult,
  type ProposalDecision,
  type ProposalState,
  type SessionInfo,
} from "@strive/protocol";
import { formatUsd as exactUsd, MODE_NAMES } from "@strive/view";
import {
  DEFAULT_WORKSPACE,
  decide,
  fold,
  type History,
  history as newHistory,
  type Op,
  type Panel,
  ProposalSchema,
  parseJson,
  placed,
  record,
  type SidePanel,
  setReverted,
  showPanel,
  type Workspace,
} from "@strive/workspace";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import type { Bridge, Opened } from "../shared/bridge";
import { type Item, label, summarize, type Tool } from "./conversation";
import { ChangesPane } from "./ChangesPane";
import { focusEntry, onFocus, takeFocus } from "./focus";
import { LearnedPane } from "./LearnedPane";
import { errorText, Journal, latestRun } from "./learning";
import { Palette } from "./Palette";
import { Diff } from "./DiffView";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./MarkdownView";
import { SessionModel } from "./model";
import { ModelPicker } from "./ModelPicker";

type Props = { bridge: Bridge; opened: Opened; onSwitch: (id?: string) => Promise<void> };

/** Whether the sessions sidebar shows, kept across launches. */
const SIDEBAR_KEY = "strive.sidebar";

/** Which pane shows beside the conversation, if any, kept across launches. */
const PANE_KEY = "strive.pane";

type Pane = "changes" | "learned";

function savedPane(): Pane | undefined {
  const saved = localStorage.getItem(PANE_KEY);

  return saved === "changes" || saved === "learned" ? saved : undefined;
}

/** The proposal the Learned pane shows, kept while the window switches sessions. */
const SELECTED_KEY = "strive.learned.selected";

/** Entries in the learning session after which the proposals may read differently. */
const PROPOSAL_EVENTS = new Set([
  "proposalMade",
  "gateFinished",
  "proposalDecided",
  "proposalApplied",
  "proposalRolledBack",
  "predictionChecked",
]);

export function App({ bridge, opened, onSwitch }: Props) {
  const [model] = useState(() => new SessionModel(opened.session.id, opened.home));
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<History>(() => newHistory(DEFAULT_WORKSPACE));
  // Until the saved layout is in, an edit would be made to (and saved over it
  // from) the default one.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    for (const e of opened.entries) model.apply(e);
    rerender();

    bridge.onEvent((event) => {
      if (event.params.sessionId !== opened.session.id) return;

      if (event.method === "session/entry") model.apply(event.params.entry);
      else if (event.method === "session/delta") model.live = event.params.text;

      rerender();
    });

    bridge.onClosed(() => setClosed(true));
    bridge
      .loadWorkspace()
      .then((saved) => saved && setLayout(saved))
      .finally(() => setLoaded(true));
  }, [bridge, model, opened]);

  const act = (p: Promise<unknown>) => p.catch((e: Error) => setError(errorText(e)));
  const id = opened.session.id;

  const edit = (next: History) => {
    if (!loaded) return;
    setLayout(next);
    act(bridge.saveWorkspace(next));
  };

  const workspace = fold(layout).workspace;
  const inline = placed(workspace, "transcript");

  /** A person's edit to the layout, recorded like a drag. */
  const change = (label: string, ops: Op[]) => {
    const r = record(layout, "person", label, ops);

    if (r.ok) edit(r.history);
    else setError(`The layout didn't change: ${r.error}`);
  };

  const panelActions = SIDE_PANELS.map((kind) =>
    placed(workspace, kind)
      ? {
          id: `hide-${kind}`,
          label: `Hide ${TITLES[kind].toLowerCase()}`,
          run: () => change(`hide ${kind}`, [{ op: "remove", panel: kind }]),
        }
      : {
          id: `show-${kind}`,
          label: `Show ${TITLES[kind].toLowerCase()}`,
          run: () => change(`show ${kind}`, showPanel(workspace, kind)),
        },
  );

  const [docked, setDocked] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== "hidden");
  const narrow = useNarrow();
  // A narrow window has no room for the sessions beside the conversation: they open over it, until put away.
  const [drawer, setDrawer] = useState(false);
  const sidebar = narrow ? drawer : docked;

  const toggleSidebar = () => {
    if (narrow) {
      setDrawer((open) => !open);

      return;
    }

    setDocked((open) => {
      localStorage.setItem(SIDEBAR_KEY, open ? "hidden" : "shown");

      return !open;
    });
  };

  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);

  const switchTo = (to?: string) => {
    setDrawer(false);
    act(onSwitch(to));
  };

  const [pane, setPane] = useState<Pane | undefined>(savedPane);
  const [palette, setPalette] = useState(false);
  const changes = pane === "changes";
  const learned = pane === "learned";

  const toggle = (which: Pane) =>
    setPane((open) => {
      const next = open === which ? undefined : which;
      localStorage.setItem(PANE_KEY, next ?? "");

      return next;
    });

  const toggleChanges = () => toggle("changes");
  const toggleLearned = () => toggle("learned");

  // The project's learning: its proposals, and its journal for the state of a run.
  const [proposals, setProposals] = useState<ProposalState[]>();
  const [journal] = useState(() => new Journal());
  const [, journalChanged] = useReducer((n: number) => n + 1, 0);
  const [projectSessions, setProjectSessions] = useState<SessionInfo[]>([]);

  const [selected, setSelected] = useState<number | undefined>(() => {
    const saved = Number(sessionStorage.getItem(SELECTED_KEY));

    return Number.isInteger(saved) && saved > 0 ? saved : undefined;
  });

  const select = (proposal?: number) => {
    sessionStorage.setItem(SELECTED_KEY, proposal === undefined ? "" : String(proposal));
    setSelected(proposal);
  };

  const cwd = opened.session.cwd;

  const [outsideReview, setOutsideReview] = useState<string[]>([]);

  const loadProposals = useCallback(
    () =>
      bridge.request("proposal/list", { cwd }).then((r) => {
        setProposals(r.proposals);
        setOutsideReview(r.changedOutsideReview);
      }),
    [bridge, cwd],
  );

  const readLearning = useCallback(
    () =>
      bridge.learning().then((r) => {
        if (r) journal.add(r.entries);
        journalChanged();
      }),
    [bridge, journal],
  );

  useEffect(() => {
    bridge.onLearning((entry) => {
      journal.add([entry]);
      journalChanged();

      if (PROPOSAL_EVENTS.has(entry.event.type)) void loadProposals().catch(() => undefined);
    });
    void loadProposals().catch((e: Error) => setError(`Couldn't list what the learner proposed: ${errorText(e)}`));
    void readLearning().catch(() => undefined);
  }, [bridge, journal, loadProposals, readLearning]);

  // Opened, the pane looks again: a learning session made elsewhere (`strive learn`) is found and followed from then on.
  useEffect(() => {
    if (!learned) return;

    bridge.sessions().then(setProjectSessions, () => undefined);
    void loadProposals().catch((e: Error) => setError(`Couldn't list what the learner proposed: ${errorText(e)}`));
    void readLearning().catch(() => undefined);
    // Back from an editor, the pane sees a learned file changed there.
    const again = () => void loadProposals().catch(() => undefined);
    window.addEventListener("focus", again);

    return () => window.removeEventListener("focus", again);
  }, [learned, bridge, loadProposals, readLearning]);

  const run = latestRun(journal.entries);

  const learning = {
    before: useCallback((proposal: number) => bridge.proposalBefore(proposal), [bridge]),
    cited: useCallback((session: string, seqs: number[]) => bridge.cited(session, seqs), [bridge]),
    decide: async (proposal: number, decision: ProposalDecision) => {
      await bridge.request("proposal/decide", { cwd, proposal, decision });
      await loadProposals();
    },
    rollback: async (proposal: number) => {
      await bridge.request("proposal/rollback", { cwd, proposal });
      await loadProposals();
    },
    learn: async () => {
      await bridge.request("learning/run", { cwd });
      await readLearning();
    },
  };

  const ready = proposals?.filter((p) => p.status === "ready").length ?? 0;

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;

      if (e.key === "n") {
        e.preventDefault();
        void onSwitch().catch((err: Error) => setError(err.message));
      } else if (e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "d") {
        e.preventDefault();
        toggleChanges();
      } else if (e.key === "l") {
        e.preventDefault();
        toggleLearned();
      } else if (e.key === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };

    window.addEventListener("keydown", keys);

    return () => window.removeEventListener("keydown", keys);
  });

  const [models, setModels] = useState<ModelListResult>();
  const [keyed, setKeyed] = useState<ReadonlySet<string>>();

  // Which models there are and which providers have keys: asked again on request, since keys change outside the app.
  const loadFacts = useCallback(() => {
    bridge.request("model/list", {}).then(setModels, () => undefined);
    bridge.request("auth/status", {}).then(
      (r) => setKeyed(new Set(r.providers.filter((p) => p.source !== "none").map((p) => p.provider))),
      () => undefined,
    );
  }, [bridge]);

  useEffect(() => {
    loadFacts();
    // A key added with `strive auth` in a terminal shows when the person comes back.
    window.addEventListener("focus", loadFacts);

    return () => window.removeEventListener("focus", loadFacts);
  }, [loadFacts]);

  const loadChanges = useCallback(
    (checkpoint: number) => bridge.request("session/changes", { id, checkpoint }),
    [bridge, id],
  );

  const session: SessionActions = {
    prompt: (text) => act(bridge.request("session/prompt", { id, text })),
    interrupt: () => act(bridge.request("session/interrupt", { id })),
    decide: (effect, decision) => act(bridge.request("approval/respond", { id, effect, decision })),
    rewind: (checkpoint) => act(bridge.request("session/rewind", { id, checkpoint })),
    setMode: (mode) => act(bridge.request("session/approvals", { id, mode })),
    blob: (digest) => bridge.blob(digest),
    workspace: opened.session.cwd,
    setModel: (model) => act(bridge.request("session/model", { id, model })),
    newSession: () => switchTo(),
    models,
    keyed,
    recheck: loadFacts,
  };

  return (
    <div
      className={`app ${opened.platform === "darwin" ? "mac" : ""} ${sidebar && !narrow ? "with-sidebar" : ""} ${narrow ? "narrow" : ""}`}
    >
      {sidebar && (
        <Sidebar
          bridge={bridge}
          opened={opened}
          model={model}
          onSwitch={switchTo}
          onToggle={toggleSidebar}
          drawer={narrow}
        />
      )}
      {sidebar && narrow && (
        <button type="button" className="scrim" aria-label="close sessions" onClick={() => setDrawer(false)} />
      )}
      <div className="main-area">
        <Titlebar
          model={model}
          opened={opened}
          sidebar={sidebar && !narrow}
          onToggle={toggleSidebar}
          changes={changes}
          onChanges={toggleChanges}
          learned={learned}
          onLearned={toggleLearned}
          ready={ready}
          learning={run?.running === true}
          onPalette={() => setPalette(true)}
        />
        {closed && (
          <div className="banner danger">
            Lost the connection to the daemon. Restart it with strive, then reopen this window.
          </div>
        )}
        {error && (
          <button type="button" className="banner danger" onClick={() => setError(undefined)}>
            {error}
          </button>
        )}
        {loaded && <Proposals model={model} layout={layout} onChange={edit} />}
        <Palette
          open={palette}
          onOpenChange={setPalette}
          actions={[
            { id: "new", label: "New session", keys: "⌘N", run: () => switchTo() },
            { id: "sidebar", label: sidebar ? "Hide sessions" : "Show sessions", keys: "⌘B", run: toggleSidebar },
            { id: "changes", label: changes ? "Hide changes" : "Show changes", keys: "⌘D", run: toggleChanges },
            { id: "learned", label: learned ? "Hide learned" : "Show learned", keys: "⌘L", run: toggleLearned },
            ...(run?.running
              ? []
              : [
                  {
                    id: "learn",
                    label: "Learn from recent sessions",
                    run: () => {
                      if (!learned) toggleLearned();
                      act(learning.learn());
                    },
                  },
                ]),
            ...(model.working
              ? [{ id: "interrupt", label: "Interrupt the agent", keys: "Esc", run: session.interrupt }]
              : []),
          ]}
          panels={panelActions}
          modes={{ current: model.mode, set: session.setMode }}
          checkpoints={model.checkpoints}
          onRewind={session.rewind}
          sessions={bridge.sessions}
          currentSession={opened.session.id}
          onSwitch={(to) => switchTo(to)}
        />
        <div className={`work ${pane ? "with-changes" : ""}`}>
          <Columns
            workspace={workspace}
            onMove={(panel, column, before) => change(`move ${panel}`, [{ op: "move", panel, column, before }])}
            onHide={(panel) => change(`hide ${panel}`, [{ op: "remove", panel }])}
            render={(panel) => (
              <PanelView panel={panel} model={model} opened={opened} session={session} inline={inline} />
            )}
          />
          {changes && (
            <ChangesPane
              checkpoints={model.checkpoints.map((c) => c.n)}
              version={model.filesVersion}
              load={loadChanges}
              onClose={toggleChanges}
            />
          )}
          {learned && (
            <LearnedPane
              proposals={proposals}
              outsideReview={outsideReview}
              run={run}
              sessions={projectSessions}
              currentSession={id}
              selected={selected}
              onSelect={select}
              before={learning.before}
              decide={learning.decide}
              rollback={learning.rollback}
              learn={learning.learn}
              cited={learning.cited}
              onShow={(to, seq) => {
                if (seq !== undefined) focusEntry(to, seq);

                if (to !== id) switchTo(to);
              }}
              onClose={toggleLearned}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Below this width the sessions sidebar opens over the conversation instead of beside it. */
const NARROW = "(max-width: 899px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);

  useEffect(() => {
    const query = matchMedia(NARROW);
    const changed = () => setNarrow(query.matches);
    query.addEventListener("change", changed);

    return () => query.removeEventListener("change", changed);
  }, []);

  return narrow;
}

/** A time ago as a list shows it: now, 5m, 3h, 2d. */
function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60_000);

  if (m < 1) return "now";

  if (m < 60) return `${m}m`;

  const h = Math.floor(m / 60);

  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

type SidebarProps = {
  bridge: Bridge;
  opened: Opened;
  model: SessionModel;
  onSwitch: (id?: string) => void;
  onToggle: () => void;
  /** Opened over the conversation, in a narrow window. */
  drawer: boolean;
};

/** This project's sessions: the one shown, and the others to switch to. */
function Sidebar({ bridge, opened, model, onSwitch, onToggle, drawer }: SidebarProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const prompts = model.conversation.items.filter((i) => i.kind === "user").length;
  const [now, setNow] = useState(Date.now());

  // Again when this session gets its first prompt (its title), and now and then for the others.
  useEffect(() => {
    const load = () => {
      setNow(Date.now());
      bridge.sessions().then(setSessions, () => undefined);
    };

    load();
    const every = setInterval(load, 15_000);

    return () => clearInterval(every);
  }, [bridge, prompts]);

  const waiting = model.conversation.waiting().length > 0;

  return (
    <aside className={`sidebar ${drawer ? "drawer" : ""}`} aria-label="sessions sidebar">
      <div className="sidebar-top">
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          title="Hide sessions (⌘B)"
          aria-label="hide sessions"
        >
          <Icon name="sidebar" />
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          onClick={() => onSwitch()}
          title="New session (⌘N)"
          aria-label="new session"
        >
          <Icon name="plus" />
        </button>
      </div>
      <div className="project" title={opened.session.cwd}>
        <Icon name="folder" /> <span>{basename(opened.session.cwd)}</span>
      </div>
      <nav className="sessions" aria-label="sessions">
        {sessions.map((s) => {
          const current = s.id === opened.session.id;
          const state = current ? (waiting ? "waiting" : model.working ? "working" : "") : "";

          return (
            <button
              type="button"
              key={s.id}
              className={`session ${current ? "current" : ""}`}
              aria-current={current ? "page" : undefined}
              onClick={() => current || onSwitch(s.id)}
            >
              <span className={`dot ${state || "idle"}`} />
              <span className="name">{s.title ?? "New session"}</span>
              <span className="when">{ago(s.lastActiveMs ?? s.createdAtMs, now)}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

type SessionActions = {
  prompt: (text: string) => void;
  interrupt: () => void;
  decide: (effect: number, decision: Decision) => void;
  rewind: (checkpoint: number) => void;
  setMode: (mode: ApprovalMode) => void;
  blob: (digest: Digest) => Promise<string>;
  /** The session's directory, which paths are shown from. */
  workspace: string;
  setModel: (model: string) => void;
  newSession: () => void;
  /** The daemon's priced models, once loaded. */
  models?: ModelListResult;
  /** Providers the daemon has a key for. */
  keyed?: ReadonlySet<string>;
  /** Asks for the models and keys again. */
  recheck: () => void;
};

/** Dollars as people read them: cents from a dollar up or for whole cents, four places otherwise. */
function formatUsd(micros: number): string {
  return micros >= 1_000_000 || micros % 10_000 === 0 ? `$${(micros / 1_000_000).toFixed(2)}` : exactUsd(micros);
}

/** A path under the user's home written with `~`. */
function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

type TitlebarProps = {
  model: SessionModel;
  opened: Opened;
  sidebar: boolean;
  onToggle: () => void;
  changes: boolean;
  onChanges: () => void;
  learned: boolean;
  onLearned: () => void;
  /** Proposals waiting for a person's decision. */
  ready: number;
  /** Whether a learning run is going on. */
  learning: boolean;
  onPalette: () => void;
};

function Titlebar(props: TitlebarProps) {
  const { model, opened, sidebar, onToggle, changes, onChanges, learned, onLearned, ready, learning, onPalette } =
    props;

  const first = model.conversation.items.find((i) => i.kind === "user");
  const title = first?.kind === "user" ? first.text : "New session";

  return (
    <header className="titlebar">
      {!sidebar && (
        <button
          type="button"
          className="icon-button"
          onClick={onToggle}
          title="Show sessions (⌘B)"
          aria-label="show sessions"
        >
          <Icon name="sidebar" />
        </button>
      )}
      <span className="title" title={title}>
        {title}
      </span>
      {!sidebar && (
        <span className="where" title={opened.session.cwd}>
          <Icon name="folder" /> {basename(opened.session.cwd)}
        </span>
      )}
      <span className="spacer" />
      <button type="button" className="icon-button" onClick={onPalette} title="Commands (⌘K)" aria-label="commands">
        <Icon name="command" />
      </button>
      <button
        type="button"
        className={`icon-button ${changes ? "on" : ""}`}
        onClick={onChanges}
        title="Changes (⌘D)"
        aria-label="changes"
        aria-pressed={changes}
      >
        <Icon name="diff" />
      </button>
      <button
        type="button"
        className={`icon-button learned-button ${learned ? "on" : ""}`}
        onClick={onLearned}
        title={
          learning ? "Learned (⌘L): learning now" : ready > 0 ? `Learned (⌘L): ${ready} to review` : "Learned (⌘L)"
        }
        aria-label="learned"
        aria-pressed={learned}
      >
        <Icon name="bulb" />
        {(learning || ready > 0) && <span className={`count-dot ${learning ? "working" : ""}`} />}
      </button>
    </header>
  );
}

/** The agent's layout proposals not yet decided, and an undo for the last one applied. */
function Proposals({
  model,
  layout,
  onChange,
}: {
  model: SessionModel;
  layout: History;
  onChange: (h: History) => void;
}) {
  const open = model.proposals.filter((p) => !layout.decided.includes(p.key));
  const applied = layout.edits.findLast((e) => e.author === "agent" && !e.reverted);

  return (
    <>
      {open.map((p) => {
        const parsed = parseJson(ProposalSchema, p.json);
        const recorded = parsed.ok ? record(layout, "agent", parsed.value.label, parsed.value.ops) : parsed;

        return (
          <div key={p.key} className="proposal" data-proposal={p.key}>
            <Icon name="layout" />
            <span className="grow">
              The agent proposes: <strong>{p.label}</strong>
              {!recorded.ok && <span className="danger"> It doesn't apply: {recorded.error}</span>}
            </span>
            <button type="button" onClick={() => onChange(decide(layout, p.key))}>
              {recorded.ok ? "Reject" : "Dismiss"}
            </button>
            {recorded.ok && (
              <button type="button" className="primary" onClick={() => onChange(decide(recorded.history, p.key))}>
                Accept
              </button>
            )}
          </div>
        );
      })}
      {applied && open.length === 0 && (
        <div className="proposal applied">
          <Icon name="layout" />
          <span className="grow">Layout: {applied.label}</span>
          <button type="button" onClick={() => onChange(setReverted(layout, applied.id, true))}>
            Undo
          </button>
        </div>
      )}
    </>
  );
}

type ColumnsProps = {
  workspace: Workspace;
  onMove: (panel: string, column: string, before?: string) => void;
  onHide: (panel: string) => void;
  render: (panel: Panel) => ReactNode;
};

function Columns({ workspace, onMove, onHide, render }: ColumnsProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const panels = new Map(workspace.panels.map((p) => [p.id, p]));
  // The conversation alone has nowhere to go: no handle to drag it by.
  const arranged = workspace.columns.some((c) => c.panels.some((p) => p !== "transcript"));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;

    const target = String(over.id);
    const column = workspace.columns.find((c) => c.id === target || c.panels.includes(target));

    if (!column) return;

    if (column.id === target) {
      onMove(String(active.id), column.id); // on the column itself: to its end

      return;
    }

    // On a panel: before it if dropped on its upper half, else after it.
    const dropped = active.rect.current.translated;
    const lower = dropped !== null && dropped.top + dropped.height / 2 > over.rect.top + over.rect.height / 2;
    const rest = column.panels.filter((p) => p !== String(active.id));
    const before = lower ? rest[rest.indexOf(target) + 1] : target;
    onMove(String(active.id), column.id, before);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
      <main className="columns">
        {workspace.columns.map((c) => (
          <SortableContext key={c.id} id={c.id} items={c.panels} strategy={verticalListSortingStrategy}>
            <section className="column" style={{ flexGrow: c.grow }} data-column={c.id}>
              {c.panels.flatMap((pid) => {
                const panel = panels.get(pid);

                return panel
                  ? [
                      <Sortable
                        key={pid}
                        panel={panel}
                        movable={panel.kind !== "transcript" || arranged}
                        onHide={() => onHide(pid)}
                      >
                        {render(panel)}
                      </Sortable>,
                    ]
                  : [];
              })}
            </section>
          </SortableContext>
        ))}
      </main>
    </DndContext>
  );
}

const TITLES: Record<Exclude<Panel["kind"], "html">, string> = {
  transcript: "Conversation",
  spend: "Spend",
  approvals: "Approvals",
  checkpoints: "Checkpoints",
  activity: "Activity",
};

/** The panels a person can show beside the conversation, in the palette's order. */
const SIDE_PANELS: SidePanel[] = ["spend", "checkpoints", "activity", "approvals"];

const panelTitle = (p: Panel) => (p.kind === "html" ? p.title : TITLES[p.kind]);

type SortableProps = { panel: Panel; movable: boolean; onHide: () => void; children: ReactNode };

function Sortable({ panel, movable, onHide, children }: SortableProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id });

  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  const transcript = panel.kind === "transcript";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`panel kind-${panel.kind} ${isDragging ? "dragging" : ""}`}
      data-panel={panel.id}
    >
      {(movable || !transcript) && (
        <div className="panel-head">
          {movable && (
            <div className="handle" {...attributes} {...listeners} aria-label={`move ${panel.id}`}>
              <Icon name="grip" />
            </div>
          )}
          {!transcript && (
            <>
              <h2>{panelTitle(panel)}</h2>
              <span className="spacer" />
              <button
                type="button"
                className="icon-button hide"
                onClick={onHide}
                aria-label={`hide ${panel.id}`}
                title="Hide (show it again from ⌘K)"
              >
                <Icon name="x" />
              </button>
            </>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** An agent widget's page, carried in its URL for the main process to serve. */
function widgetUrl(html: string): string {
  const bytes = new TextEncoder().encode(html);
  let binary = "";

  for (const b of bytes) binary += String.fromCharCode(b);

  return `strive-widget://page/${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

type PanelProps = { panel: Panel; model: SessionModel; opened: Opened; session: SessionActions; inline: boolean };

function PanelView({ panel, model, opened, session, inline }: PanelProps) {
  switch (panel.kind) {
    case "transcript":
      return <Transcript model={model} opened={opened} session={session} />;
    case "spend":
      return <SpendView model={model} />;
    case "approvals": {
      const waiting = model.conversation.waiting();

      return (
        <div className="panel-body">
          {waiting.length === 0 && <p className="faint">Nothing waiting.</p>}
          {/* With the conversation on screen, questions are answered there, next to what the agent was doing. */}
          {inline
            ? waiting.map((t) => (
                <p key={t.effect} className="waiting-line">
                  <span className="dot waiting" /> {t.approval?.description}
                </p>
              ))
            : waiting.map((t) => <Approval key={t.effect} tool={t} session={session} />)}
          {inline && waiting.length > 0 && <p className="faint small">Answer in the conversation.</p>}
        </div>
      );
    }

    case "checkpoints":
      return (
        <div className="panel-body">
          {model.checkpoints.length === 0 && <p className="faint">None yet: one is taken before each prompt.</p>}
          <ul className="checkpoints">
            {model.checkpoints.toReversed().map((c) => (
              <li key={c.n}>
                <span className="n">{c.n}</span>
                <span className="grow">{c.label || "Checkpoint"}</span>
                <button type="button" className="quiet" onClick={() => session.rewind(c.n)}>
                  Rewind
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    case "activity":
      return (
        <div className="panel-body">
          {model.activity.length === 0 && <p className="faint">Nothing run yet.</p>}
          <ul className="activity">
            {model.activity.slice(-12).map((a) => (
              <li key={a.effect}>
                <span className={`dot ${a.outcome ?? "running"}`} />
                <span className="mono">{a.what}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "html":
      return (
        <div className="panel-body">
          {/* An opaque origin (no allow-same-origin): no parent, bridge or storage. The
              strive-widget: response carries its own CSP, so no network either. */}
          <iframe className="widget" title={panel.title} sandbox="allow-scripts" src={widgetUrl(panel.html)} />
        </div>
      );
    default:
      return panel satisfies never;
  }
}

function SpendView({ model }: { model: SessionModel }) {
  const s = model.spend;
  const share = s.usdLimit ? Math.min(1, s.spentUsd / s.usdLimit) : 0;

  return (
    <div className="panel-body spend">
      <p className="figure">{formatUsd(s.spentUsd)}</p>
      <p className="faint small">
        {s.usdLimit === undefined ? "No limit" : `of ${formatUsd(s.usdLimit)} for this session`}
        {s.spentTokens > 0 && ` · ${compact(s.spentTokens)} tokens`}
      </p>
      {s.usdLimit !== undefined && (
        <div className={`meter ${share > 0.8 ? "high" : ""}`} role="meter" aria-label="spend" aria-valuenow={share}>
          <span style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** The session's spend against its limit, small enough for the composer's footer. */
function SpendMeter({ spend: s }: { spend: SessionModel["spend"] }) {
  const share = s.usdLimit ? Math.min(1, s.spentUsd / s.usdLimit) : 0;
  const tokens = s.spentTokens > 0 ? ` · ${compact(s.spentTokens)} tokens` : "";
  const limit = s.usdLimit === undefined ? "no limit" : `of ${formatUsd(s.usdLimit)}`;

  return (
    <span className="spend-meter" title={`${formatUsd(s.spentUsd)} ${limit} for this session${tokens}`}>
      {s.usdLimit !== undefined && (
        <span
          className={`meter mini ${share > 0.8 ? "high" : ""}`}
          role="meter"
          aria-label="spend"
          aria-valuenow={share}
          aria-valuemin={0}
          aria-valuemax={1}
        >
          <span style={{ width: `${share * 100}%` }} />
        </span>
      )}
      <span className="figures">
        {formatUsd(s.spentUsd)}
        {s.usdLimit !== undefined && <span className="faint"> / {formatUsd(s.usdLimit)}</span>}
      </span>
    </span>
  );
}

function compact(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;

  const s = ms / 1000;

  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function Transcript({ model, opened, session }: { model: SessionModel; opened: Opened; session: SessionActions }) {
  // Follows new output while the view is at the bottom; a scroll up (wheel,
  // keys, drag) lets go, and the pill or a new prompt takes it back.
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    initial: "instant",
    resize: "smooth",
  });

  // An entry the Learned pane's evidence points to: the item that holds it
  // (the last to start at or before it) comes into view, marked for a moment.
  useEffect(() => {
    const sessionId = opened.session.id;
    let frame = 0;

    const go = () => {
      const seq = takeFocus(sessionId);

      if (seq === undefined) return;
      // After the first paint, which puts the view at the bottom.
      frame = requestAnimationFrame(() => {
        const held = [...(contentRef.current?.querySelectorAll<HTMLElement>("[data-seq]") ?? [])].filter(
          (el) => Number(el.dataset.seq) <= seq,
        );

        const target = held.at(-1);

        if (!target) return;
        stopScroll();
        target.scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        });
        target.classList.add("focused");
        // As long as the mark's animation in styles.css.
        setTimeout(() => target.classList.remove("focused"), 1600);
      });
    };

    go();
    const stop = onFocus(go);

    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [opened.session.id, contentRef, stopScroll]);

  const items = model.conversation.items;
  const lastTools = items.findLastIndex((i) => i.kind === "tools");

  return (
    <div className="transcript">
      <PromptRail prompts={items.flatMap((i) => (i.kind === "user" ? [{ seq: i.seq, text: i.text }] : []))} />
      <div className="scroller" ref={scrollRef}>
        <div className="thread" ref={contentRef}>
          {!items.some((i) => i.kind === "user") && <Empty opened={opened} model={model} session={session} />}
          {items.map((item, i) => (
            <ItemView
              key={`${item.kind}-${item.seq}`}
              item={item}
              session={session}
              live={model.working && i === lastTools && i === items.length - 1}
              checkpoint={item.kind === "user" ? model.before.get(item.seq) : undefined}
            />
          ))}
          {model.live && (
            <div className="msg reply live">
              <Markdown text={model.live} streaming />
            </div>
          )}
          {model.working && <Trailer model={model} />}
        </div>
      </div>
      {!isAtBottom && (
        <button type="button" className="jump" onClick={() => scrollToBottom()}>
          <Icon name="arrow" className="down" /> Jump to latest
        </button>
      )}
      <Composer
        model={model}
        opened={opened}
        session={{
          ...session,
          prompt: (text) => {
            session.prompt(text);
            void scrollToBottom(); // a new prompt: follow what comes of it
          },
        }}
      />
    </div>
  );
}

/** Past this, a prompt shows folded, with "Show more". */
const LONG_PROMPT = { chars: 700, lines: 12 };

type UserMessageProps = {
  id: string;
  seq: number;
  text: string;
  /** The checkpoint taken just before this prompt, if one was. */
  checkpoint?: number;
  onRewind: (checkpoint: number) => void;
};

function UserMessage({ id, seq, text, checkpoint, onRewind }: UserMessageProps) {
  const long = text.length > LONG_PROMPT.chars || text.split("\n").length > LONG_PROMPT.lines;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="msg user" id={id} data-seq={seq}>
      <div className={`bubble ${long && !open ? "folded" : ""}`}>
        {text}
        {long && (
          <button type="button" className="more" onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      {confirming && checkpoint !== undefined ? (
        <div className="rewind-confirm" role="group" aria-label="rewind">
          <span>Put the files back as they were before this prompt? What's there now is saved first.</span>
          <button type="button" className="quiet" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setConfirming(false);
              onRewind(checkpoint);
            }}
          >
            Restore files
          </button>
        </div>
      ) : (
        <div className="msg-actions">
          <CopyButton text={text} label="copy prompt" />
          {checkpoint !== undefined && (
            <button
              type="button"
              className="quiet copy"
              aria-label="rewind to before this prompt"
              title={`Restore the files to checkpoint ${checkpoint}`}
              onClick={() => setConfirming(true)}
            >
              <Icon name="rewind" /> Rewind
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="quiet copy"
      aria-label={label}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })
      }
    >
      <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** The most ticks the prompt rail shows; past that, ticks stand for evenly spaced prompts. */
const RAIL_TICKS = 12;

/** One tick per prompt, at the conversation's left: hover to see it, click to go there. */
function PromptRail({ prompts }: { prompts: { seq: number; text: string }[] }) {
  if (prompts.length < 2) return null;

  const step = Math.max(1, prompts.length / RAIL_TICKS);

  const shown = Array.from(
    { length: Math.min(prompts.length, RAIL_TICKS) },
    (_, i) => prompts[Math.floor(i * step)],
  ).filter((p): p is { seq: number; text: string } => p !== undefined);

  return (
    <nav className="rail" aria-label="prompts">
      {shown.map((p) => (
        <button
          type="button"
          key={p.seq}
          className="tick"
          aria-label={p.text}
          onClick={() =>
            document.getElementById(`msg-${p.seq}`)?.scrollIntoView({
              block: "start",
              behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
            })
          }
        >
          <span className="card">{p.text.length > 120 ? `${p.text.slice(0, 117)}…` : p.text}</span>
        </button>
      ))}
    </nav>
  );
}

/** What the agent is doing now, and for how long. */
function Trailer({ model }: { model: SessionModel }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, []);

  const started = model.conversation.turnStartedMs;
  const waiting = model.conversation.waiting().length > 0;
  const elapsed = started === undefined ? "" : ` ${clock(now - started)}`;

  return (
    <div className={`thinking ${waiting ? "waiting" : ""}`}>
      <span className="pulse" />
      <span>{waiting ? "Waiting for you" : model.live ? "Writing" : "Working"}</span>
      <span className="faint">{elapsed}</span>
      {!waiting && <span className="faint hint">Esc to interrupt</span>}
    </div>
  );
}

/** Elapsed time as a clock reads it: 42s, 3m 05s. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const PROVIDERS = new Map([
  ["anthropic", { name: "Anthropic", variable: "ANTHROPIC_API_KEY" }],
  ["openai", { name: "OpenAI", variable: "OPENAI_API_KEY" }],
]);

/** What each approval mode lets the agent do, as the empty state explains it. */
const MODE_MEANING: Record<ApprovalMode, string> = {
  ask: "every change and command asks you first",
  autoEdit: "edits in this folder go ahead; commands ask you first",
  fullAuto: "edits and sandboxed commands go ahead without asking",
};

type EmptyProps = { opened: Opened; model: SessionModel; session: SessionActions };

/** A session with no prompt yet: where the agent works, what it may do, and anything missing to start. */
function Empty({ opened, model, session }: EmptyProps) {
  const current = currentModel(model, session.models);
  const provider = session.models?.models.find((m) => m.id === current)?.provider;
  const missing = provider !== undefined && session.keyed !== undefined && !session.keyed.has(provider);
  const who = provider === undefined ? undefined : (PROVIDERS.get(provider) ?? { name: provider, variable: "" });
  const limit = model.spend.usdLimit;

  return (
    <div className="empty">
      <div className="mark">
        <Icon name="spark" />
      </div>
      <h1>What should we work on?</h1>
      <p>
        Describe a change, a bug or a question. The agent reads and edits files in{" "}
        <span className="mono">{tilde(opened.session.cwd, opened.home)}</span> and runs commands in a sandbox.
      </p>
      {missing && who && (
        <div className="setup" role="status">
          <Icon name="key" />
          <div className="grow">
            <strong>Add an {who.name} API key to start.</strong>
            <p>
              {current} needs one. In a terminal, run <code>strive auth {provider}</code> and paste your key
              {who.variable && (
                <>
                  , or set <code>{who.variable}</code> before strive starts
                </>
              )}
              .
            </p>
          </div>
          <button type="button" onClick={session.recheck}>
            Check again
          </button>
        </div>
      )}
      <dl className="facts">
        <div>
          <dt>Approvals</dt>
          <dd>
            {MODE_NAMES[model.mode]}: {MODE_MEANING[model.mode]}
          </dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{limit === undefined ? "no limit for this session" : `${formatUsd(limit)} for this session`}</dd>
        </div>
        <div>
          <dt>Undo</dt>
          <dd>files are saved before each prompt; hover a prompt to rewind to it</dd>
        </div>
      </dl>
      <p className="keys">
        <kbd>⌘K</kbd> commands <kbd>⌘D</kbd> changes <kbd>⌘L</kbd> learned <kbd>⌘B</kbd> sessions <kbd>⇧↵</kbd> new line
      </p>
    </div>
  );
}

type ItemProps = { item: Item; session: SessionActions; live: boolean; checkpoint?: number };

function ItemView({ item, session, live, checkpoint }: ItemProps) {
  switch (item.kind) {
    case "user":
      return (
        <UserMessage
          id={`msg-${item.seq}`}
          seq={item.seq}
          text={item.text}
          checkpoint={checkpoint}
          onRewind={session.rewind}
        />
      );
    case "reply":
      return (
        <div className="msg reply" data-seq={item.seq}>
          <Markdown text={item.text} />
          <div className="msg-actions">
            <CopyButton text={item.text} label="copy reply" />
          </div>
        </div>
      );
    case "tools":
      return <ToolGroup seq={item.seq} tools={item.tools} session={session} live={live} />;
    case "turn": {
      const cost = item.costUsdMicros > 0 ? ` · ${formatUsd(item.costUsdMicros)}` : "";

      return item.reason.kind === "done" ? (
        <div className="turn-meta" data-seq={item.seq}>
          Worked for {duration(item.durationMs)}
          {cost}
        </div>
      ) : (
        <div className="turn-meta" data-seq={item.seq}>
          {cost.slice(3)}
        </div>
      );
    }

    case "notice":
      return (
        <div className={`notice ${item.tone}`} data-seq={item.seq}>
          {item.text}
        </div>
      );
    default:
      return item satisfies never;
  }
}

type ToolGroupProps = { seq: number; tools: Tool[]; session: SessionActions; live: boolean };

function ToolGroup({ seq, tools, session, live }: ToolGroupProps) {
  const active = tools.some((t) => t.status === "running" || t.status === "waiting");
  // Open while the agent is at it, closed once it has moved on, unless the
  // person has said otherwise by clicking.
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? (live || active);
  const waiting = tools.some((t) => t.status === "waiting");

  return (
    <div className="tools" data-seq={seq}>
      <button type="button" className="tools-head" aria-expanded={open} onClick={() => setChosen(!open)}>
        <Icon name="chevron" className={open ? "open" : ""} />
        <span>{summarize(tools)}</span>
        {waiting ? (
          <Icon name="hand" className="state waiting" />
        ) : (
          active && <Icon name="spinner" className="state running" />
        )}
      </button>
      {open && (
        <div className="tool-list">
          {tools.map((t) => (
            <ToolRow key={t.effect} tool={t} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<Tool["record"]["kind"], IconName> = {
  bash: "terminal",
  read: "file",
  edit: "pencil",
  write: "pencil",
  mcp: "plug",
};

const DECIDED: Record<Decision, string> = {
  allow: "Allowed",
  allowSession: "Allowed; full-auto from here",
  deny: "Declined",
};

function ToolRow({ tool, session }: { tool: Tool; session: SessionActions }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`tool ${tool.status}`} data-effect={tool.effect}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={KIND_ICON[tool.record.kind]} />
        <span className="mono label">{label(tool.record, session.workspace)}</span>
        {tool.approval?.decided && <span className="badge">{DECIDED[tool.approval.decided]}</span>}
        {tool.status === "failed" && tool.exitCode !== undefined && (
          <span className="badge bad">exit {tool.exitCode}</span>
        )}
        {tool.status === "refused" && <span className="badge bad">refused</span>}
        {tool.status === "interrupted" && <span className="badge bad">interrupted</span>}
        {tool.status === "running" && <Icon name="spinner" className="state running" />}
        {tool.durationMs !== undefined && <span className="faint small">{duration(tool.durationMs)}</span>}
      </button>
      {tool.status === "waiting" && <Approval tool={tool} session={session} />}
      {open && <ToolDetail tool={tool} session={session} />}
    </div>
  );
}

function Approval({ tool, session }: { tool: Tool; session: SessionActions }) {
  return (
    <div className="approval">
      <p>Allow the agent to {tool.approval?.description}?</p>
      <div className="actions">
        <button type="button" className="quiet danger" onClick={() => session.decide(tool.effect, "deny")}>
          Decline
        </button>
        <button
          type="button"
          title="Switches this session to full-auto: nothing asks again"
          onClick={() => session.decide(tool.effect, "allowSession")}
        >
          Allow everything
        </button>
        <button type="button" className="primary" onClick={() => session.decide(tool.effect, "allow")}>
          Allow
        </button>
      </div>
    </div>
  );
}

/** Loads blobs once the detail opens; each digest's text never changes. */
function useBlobs(digests: (Digest | undefined)[], blob: (d: Digest) => Promise<string>) {
  const [texts, setTexts] = useState<(string | undefined)[]>([]);
  const [failed, setFailed] = useState<string>();
  // The digests as one string: the same ones mean the same texts.
  const key = digests.map((d) => d ?? "").join(",");

  useEffect(() => {
    let live = true;
    Promise.all(key.split(",").map((d) => (d ? blob(d) : Promise.resolve(undefined))))
      .then((t) => live && setTexts(t))
      .catch((e: Error) => live && setFailed(e.message));

    return () => {
      live = false;
    };
  }, [key, blob]);

  return { texts, failed };
}

const MAX_LINES = 400;

function ToolDetail({ tool, session }: { tool: Tool; session: SessionActions }) {
  const r = tool.record;
  const inputs = r.kind === "edit" ? [r.oldText, r.newText] : r.kind === "write" ? [r.content] : [];
  const { texts, failed } = useBlobs([...inputs, tool.output], session.blob);

  if (failed) return <div className="detail faint">Couldn't load this: {failed}</div>;

  if (texts.length === 0) return <div className="detail faint">Loading…</div>;

  const output = texts.at(-1);

  return (
    <div className="detail">
      {tool.reason && <p className="danger small">{tool.reason}</p>}
      {r.kind === "edit" && <Diff before={texts[0] ?? ""} after={texts[1] ?? ""} path={r.path} />}
      {r.kind === "write" && <Diff before="" after={texts[0] ?? ""} path={r.path} />}
      {r.kind !== "edit" && r.kind !== "write" && output !== undefined && <Output text={output} />}
      {tool.truncated && <p className="faint small">The output was cut to fit; the agent saw only this much.</p>}
    </div>
  );
}

function Output({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");

  if (!text.trim()) return <p className="faint small">No output.</p>;

  return (
    <pre className="output">
      {lines.slice(0, MAX_LINES).join("\n")}
      {lines.length > MAX_LINES && `\n… ${lines.length - MAX_LINES} more lines`}
    </pre>
  );
}

const MODES: ApprovalMode[] = ["ask", "autoEdit", "fullAuto"];

/** The model the session's agent uses: the one it last called, else the one chosen for it, else settings'. */
function currentModel(model: SessionModel, list?: ModelListResult): string | undefined {
  return model.modelName ?? model.chosenModel ?? list?.default;
}

function Composer({ model, opened, session }: { model: SessionModel; opened: Opened; session: SessionActions }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  // Grows with what's typed, up to a limit.
  useLayoutEffect(() => {
    const el = box.current;

    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  });

  const send = () => {
    if (!text.trim()) return;
    session.prompt(text.trim());
    setText("");
  };

  const s = model.spend;

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={box}
          rows={1}
          placeholder="Ask strive to do anything…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") session.interrupt();

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <label className="chip" title="What the agent may do without asking">
            <Icon name="shield" />
            <select
              value={model.mode}
              aria-label="approvals"
              onChange={(e) => {
                const mode = MODES.find((m) => m === e.target.value);

                if (mode) session.setMode(mode);
              }}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_NAMES[m]}
                </option>
              ))}
            </select>
          </label>
          <ModelPicker
            models={session.models?.models}
            current={currentModel(model, session.models)}
            keyed={session.keyed}
            locked={model.prompted}
            onPick={session.setModel}
            onNewSession={session.newSession}
          />
          <span className="spacer" />
          {model.working ? (
            <button
              type="button"
              className="send stop"
              aria-label="interrupt"
              title="Interrupt (Esc)"
              onClick={session.interrupt}
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button type="button" className="send" aria-label="send" disabled={!text.trim()} onClick={send}>
              <Icon name="arrow" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot">
        <span title={opened.session.cwd}>
          <Icon name="folder" /> {tilde(opened.session.cwd, opened.home)}
        </span>
        <span className="spacer" />
        <SpendMeter spend={s} />
      </div>
    </div>
  );
}
