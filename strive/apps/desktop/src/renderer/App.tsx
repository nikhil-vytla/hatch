// The desktop app's window: the workspace's columns of panels over one
// session. Panels read the session model; people rearrange them by
// dragging, which records an edit in the workspace history.
import { closestCorners, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { formatUsd, MODE_NAMES } from "@strive/view";
import {
  DEFAULT_WORKSPACE,
  fold,
  type History,
  history as newHistory,
  type Panel,
  record,
  type Workspace,
} from "@strive/workspace";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import type { Bridge, Opened } from "../shared/bridge";
import { SessionModel } from "./model";

type Props = { bridge: Bridge; opened: Opened };

export function App({ bridge, opened }: Props) {
  const [model] = useState(() => new SessionModel(opened.home));
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<History>(() => newHistory(DEFAULT_WORKSPACE));

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
    bridge.loadWorkspace().then((saved) => saved && setLayout(saved));
  }, [bridge, model, opened]);

  const act = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));
  const id = opened.session.id;

  const edit = (next: History) => {
    setLayout(next);
    act(bridge.saveWorkspace(next));
  };

  const workspace = fold(layout).workspace;

  return (
    <div className="app">
      <header>
        <span className="brand">strive</span>
        <span className="cwd">{opened.session.cwd}</span>
        <span className="spacer" />
        <span className="mode">Approvals: {MODE_NAMES[model.mode]}</span>
        {model.working && <span className="working">working… Esc to interrupt</span>}
      </header>
      {closed && <div className="banner danger">Lost the connection to the daemon.</div>}
      {error && (
        <button type="button" className="banner danger" onClick={() => setError(undefined)}>
          {error}
        </button>
      )}
      <Columns
        workspace={workspace}
        onMove={(panel, column, before) => {
          const r = record(layout, "person", `move ${panel}`, [{ op: "move", panel, column, before }]);

          if (r.ok) edit(r.history);
        }}
        render={(panel) => (
          <PanelView
            panel={panel}
            model={model}
            onPrompt={(text) => act(bridge.request("session/prompt", { id, text }))}
            onInterrupt={() => act(bridge.request("session/interrupt", { id }))}
            onDecide={(effect, decision) => act(bridge.request("approval/respond", { id, effect, decision }))}
            onRewind={(checkpoint) => act(bridge.request("session/rewind", { id, checkpoint }))}
          />
        )}
      />
    </div>
  );
}

type ColumnsProps = {
  workspace: Workspace;
  onMove: (panel: string, column: string, before?: string) => void;
  render: (panel: Panel) => ReactNode;
};

function Columns({ workspace, onMove, render }: ColumnsProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const panels = new Map(workspace.panels.map((p) => [p.id, p]));

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
                      <Sortable key={pid} id={pid}>
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

function Sortable({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="panel" data-panel={id}>
      <div className="handle" {...attributes} {...listeners} aria-label={`move ${id}`} />
      {children}
    </div>
  );
}

type PanelProps = {
  panel: Panel;
  model: SessionModel;
  onPrompt: (text: string) => void;
  onInterrupt: () => void;
  onDecide: (effect: number, decision: "allow" | "allowSession" | "deny") => void;
  onRewind: (checkpoint: number) => void;
};

function PanelView({ panel, model, onPrompt, onInterrupt, onDecide, onRewind }: PanelProps) {
  switch (panel.kind) {
    case "transcript":
      return <Transcript model={model} onPrompt={onPrompt} onInterrupt={onInterrupt} />;
    case "spend": {
      const s = model.spend;

      return (
        <>
          <h2>Spend</h2>
          <p className="meter">
            {formatUsd(s.spentUsd)}
            {s.usdLimit === undefined ? " (no limit)" : ` of ${formatUsd(s.usdLimit)}`}
          </p>
          {s.usdLimit !== undefined && (
            <progress max={s.usdLimit} value={Math.min(s.spentUsd, s.usdLimit)} aria-label="spend" />
          )}
        </>
      );
    }

    case "approvals":
      return (
        <>
          <h2>Approvals</h2>
          {model.pending.size === 0 && <p className="faint">Nothing waiting.</p>}
          {[...model.pending].map(([effect, what]) => (
            <div key={effect} className="approval">
              <p>Allow the agent to {what}?</p>
              <button type="button" onClick={() => onDecide(effect, "allow")}>
                Allow
              </button>
              <button type="button" onClick={() => onDecide(effect, "allowSession")}>
                Allow for this session
              </button>
              <button type="button" className="danger" onClick={() => onDecide(effect, "deny")}>
                Decline
              </button>
            </div>
          ))}
        </>
      );
    case "checkpoints":
      return (
        <>
          <h2>Checkpoints</h2>
          {model.checkpoints.length === 0 && <p className="faint">None yet: one is taken before each prompt.</p>}
          <ul className="checkpoints">
            {model.checkpoints.map((c) => (
              <li key={c.n}>
                <span>
                  {c.n} {c.label}
                </span>
                <button type="button" onClick={() => onRewind(c.n)}>
                  Rewind
                </button>
              </li>
            ))}
          </ul>
        </>
      );
    case "activity":
      return (
        <>
          <h2>Activity</h2>
          <ul className="activity">
            {model.activity.slice(-12).map((a) => (
              <li key={a.effect} className={a.outcome ?? "running"}>
                {a.what}
              </li>
            ))}
          </ul>
        </>
      );
    case "html":
      return (
        <>
          <h2>{panel.title}</h2>
          <p className="faint">Agent widgets arrive in a later version.</p>
        </>
      );
    default:
      return panel satisfies never;
  }
}

function Transcript({
  model,
  onPrompt,
  onInterrupt,
}: {
  model: SessionModel;
  onPrompt: (text: string) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);

  // A block body: an effect's return value is taken as its cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  });

  return (
    <div className="transcript">
      <div className="lines">
        {model.lines.map((l, i) => (
          <p key={`${l.seq}-${i}`} className={`line ${l.kind} ${l.tone}`}>
            {l.kind === "prompt" && <span className="caret">› </span>}
            {l.text}
          </p>
        ))}
        {model.live && <p className="line reply live">{model.live}</p>}
        <div ref={end} />
      </div>
      <textarea
        className="composer"
        placeholder="What should the agent do?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onInterrupt();

          if (e.key === "Enter" && !e.shiftKey && text.trim()) {
            e.preventDefault();
            onPrompt(text.trim());
            setText("");
          }
        }}
      />
    </div>
  );
}
