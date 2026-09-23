// The desktop app's window: the workspace's columns of panels over one
// session. Panels read the session model; people rearrange them by
// dragging, which records an edit in the workspace history.
import { closestCorners, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { ApprovalMode, Decision, Digest } from "@strive/protocol";
import { formatUsd as exactUsd, MODE_NAMES } from "@strive/view";
import {
  DEFAULT_WORKSPACE,
  decide,
  fold,
  type History,
  history as newHistory,
  type Panel,
  ProposalSchema,
  parseJson,
  record,
  setReverted,
  type Workspace,
} from "@strive/workspace";
import { type ReactNode, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { Bridge, Opened } from "../shared/bridge";
import { type Item, label, summarize, type Tool } from "./conversation";
import { diffLines } from "./diff";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./MarkdownView";
import { SessionModel } from "./model";

type Props = { bridge: Bridge; opened: Opened };

export function App({ bridge, opened }: Props) {
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

  const act = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));
  const id = opened.session.id;

  const edit = (next: History) => {
    if (!loaded) return;
    setLayout(next);
    act(bridge.saveWorkspace(next));
  };

  const workspace = fold(layout).workspace;
  const inline = workspace.columns.some((c) => c.panels.includes("transcript"));

  const session: SessionActions = {
    prompt: (text) => act(bridge.request("session/prompt", { id, text })),
    interrupt: () => act(bridge.request("session/interrupt", { id })),
    decide: (effect, decision) => act(bridge.request("approval/respond", { id, effect, decision })),
    rewind: (checkpoint) => act(bridge.request("session/rewind", { id, checkpoint })),
    setMode: (mode) => act(bridge.request("session/approvals", { id, mode })),
    blob: (digest) => bridge.blob(digest),
  };

  return (
    <div className={`app ${opened.platform === "darwin" ? "mac" : ""}`}>
      <Titlebar model={model} opened={opened} />
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
      <Columns
        workspace={workspace}
        onMove={(panel, column, before) => {
          const r = record(layout, "person", `move ${panel}`, [{ op: "move", panel, column, before }]);

          if (r.ok) edit(r.history);
        }}
        render={(panel) => <PanelView panel={panel} model={model} opened={opened} session={session} inline={inline} />}
      />
    </div>
  );
}

type SessionActions = {
  prompt: (text: string) => void;
  interrupt: () => void;
  decide: (effect: number, decision: Decision) => void;
  rewind: (checkpoint: number) => void;
  setMode: (mode: ApprovalMode) => void;
  blob: (digest: Digest) => Promise<string>;
};

/** Dollars as people read them: cents from a dollar up, four places below. */
function formatUsd(micros: number): string {
  return micros >= 1_000_000 ? `$${(micros / 1_000_000).toFixed(2)}` : exactUsd(micros);
}

/** A path under the user's home written with `~`. */
function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function Titlebar({ model, opened }: { model: SessionModel; opened: Opened }) {
  const first = model.conversation.items.find((i) => i.kind === "user");
  const title = first?.kind === "user" ? first.text : "New session";

  return (
    <header className="titlebar">
      <span className="title" title={title}>
        {title}
      </span>
      <span className="where" title={opened.session.cwd}>
        <Icon name="folder" /> {basename(opened.session.cwd)}
      </span>
      <span className="spacer" />
      {model.working ? (
        <span className="status working">
          <span className="pulse" /> Working
        </span>
      ) : (
        <span className="status">Ready</span>
      )}
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
                      <Sortable key={pid} panel={panel}>
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

const panelTitle = (p: Panel) => (p.kind === "html" ? p.title : TITLES[p.kind]);

function Sortable({ panel, children }: { panel: Panel; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id });

  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`panel kind-${panel.kind} ${isDragging ? "dragging" : ""}`}
      data-panel={panel.id}
    >
      <div className="panel-head">
        <div className="handle" {...attributes} {...listeners} aria-label={`move ${panel.id}`}>
          <Icon name="grip" />
        </div>
        {panel.kind !== "transcript" && <h2>{panelTitle(panel)}</h2>}
      </div>
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

function compact(n: number): string {
  return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;

  const s = ms / 1000;

  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function Transcript({ model, opened, session }: { model: SessionModel; opened: Opened; session: SessionActions }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const items = model.conversation.items;

  // Follows new output while the view is at the bottom; leaves it be once the person scrolls up.
  useLayoutEffect(() => {
    const el = scroller.current;

    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="transcript">
      <div
        className="scroller"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="thread">
          {!items.some((i) => i.kind === "user") && <Empty opened={opened} />}
          {items.map((item) => (
            <ItemView key={`${item.kind}-${item.seq}`} item={item} session={session} />
          ))}
          {model.live && (
            <div className="msg reply live">
              <Markdown text={model.live} />
            </div>
          )}
          {model.working && !model.live && (
            <div className="thinking">
              <span className="pulse" /> {model.conversation.waiting().length > 0 ? "Waiting for you…" : "Working…"}
            </div>
          )}
        </div>
      </div>
      <Composer
        model={model}
        opened={opened}
        session={{
          ...session,
          prompt: (text) => {
            pinned.current = true; // a new prompt: follow what comes of it
            session.prompt(text);
          },
        }}
      />
    </div>
  );
}

function Empty({ opened }: { opened: Opened }) {
  return (
    <div className="empty">
      <div className="mark">
        <Icon name="spark" />
      </div>
      <h1>What should we work on?</h1>
      <p>
        strive works in <span className="mono">{tilde(opened.session.cwd, opened.home)}</span>. Commands run in a
        sandbox, every step is journaled, and you can rewind the files to before any prompt.
      </p>
    </div>
  );
}

function ItemView({ item, session }: { item: Item; session: SessionActions }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case "reply":
      return (
        <div className="msg reply">
          <Markdown text={item.text} />
        </div>
      );
    case "tools":
      return <ToolGroup tools={item.tools} session={session} />;
    case "turn": {
      const cost = item.costUsdMicros > 0 ? ` · ${formatUsd(item.costUsdMicros)}` : "";

      return item.reason.kind === "done" ? (
        <div className="turn-meta">
          Worked for {duration(item.durationMs)}
          {cost}
        </div>
      ) : (
        <div className="turn-meta">{cost.slice(3)}</div>
      );
    }

    case "notice":
      return <div className={`notice ${item.tone}`}>{item.text}</div>;
    default:
      return item satisfies never;
  }
}

const GROUP_ICON: Record<Tool["status"], IconName> = {
  running: "spinner",
  waiting: "hand",
  done: "check",
  failed: "x",
  refused: "x",
  interrupted: "x",
};

function groupStatus(tools: readonly Tool[]): Tool["status"] {
  const order: Tool["status"][] = ["waiting", "running", "refused", "interrupted", "failed"];

  return order.find((s) => tools.some((t) => t.status === s)) ?? "done";
}

function ToolGroup({ tools, session }: { tools: Tool[]; session: SessionActions }) {
  const status = groupStatus(tools);
  const [open, setOpen] = useState(status === "waiting");

  // A question for a person opens the group, and it stays open once answered.
  useEffect(() => {
    if (status === "waiting") setOpen(true);
  }, [status]);

  return (
    <div className={`tools ${status}`}>
      <button type="button" className="tools-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" className={open ? "open" : ""} />
        <span>{summarize(tools)}</span>
        {status !== "done" && <Icon name={GROUP_ICON[status]} className={`state ${status}`} />}
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
        <span className="mono label">{label(tool.record)}</span>
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
      {r.kind === "edit" && <Diff before={texts[0] ?? ""} after={texts[1] ?? ""} />}
      {r.kind === "write" && <Diff before="" after={texts[0] ?? ""} />}
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

function Diff({ before, after }: { before: string; after: string }) {
  const rows = diffLines(before, after).slice(0, MAX_LINES);

  return (
    <pre className="diff">
      {rows.map((row) => (
        <div key={row.n} className={`row ${row.kind}`}>
          <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span>
          {row.text || " "}
        </div>
      ))}
    </pre>
  );
}

const MODES: ApprovalMode[] = ["ask", "autoEdit", "fullAuto"];

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
          {model.modelName && (
            <span className="chip" title="The model the agent is using">
              <Icon name="spark" /> {model.modelName}
            </span>
          )}
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
        <span>
          {formatUsd(s.spentUsd)}
          {s.usdLimit !== undefined && ` of ${formatUsd(s.usdLimit)}`}
        </span>
      </div>
    </div>
  );
}
