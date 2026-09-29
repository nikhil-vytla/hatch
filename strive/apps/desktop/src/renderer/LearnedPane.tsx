// What the learner proposed for this project, for a person to review: each
// proposal's diff, why, its evidence and the daemon's checks, and Accept,
// Reject or Roll back. The same as `strive review`.
import type { Evidence, GateOutcome, ProposalDecision, ProposalState, SessionInfo, SkippedRun } from "@strive/protocol";
import { SIGN_NAMES, triggerText } from "@strive/view";
import { useEffect, useState } from "react";
import type { Cited } from "../shared/cited";
import { blocks } from "./cited";
import { Diff } from "./DiffView";
import { Icon } from "./icons";
import { Markdown } from "./MarkdownView";
import {
  artifactName,
  artifactPath,
  errorText,
  fileHistory,
  GATE_NAMES,
  type Run,
  readJudge,
  STATUS_NAMES,
  statusNote,
  VERDICT_NAMES,
} from "./learning";

type Props = {
  /** Newest first; none until loaded. */
  proposals?: ProposalState[];
  /** Learned files, by path in the project, that aren't what an accepted proposal last left there. */
  outsideReview: string[];
  /** The latest automatic run that didn't start, if none started since. */
  skipped?: SkippedRun;
  run?: Run;
  /** This project's work sessions. */
  sessions: SessionInfo[];
  currentSession: string;
  selected?: number;
  onSelect: (id?: number) => void;
  before: (proposal: number) => Promise<string | null>;
  decide: (proposal: number, decision: ProposalDecision) => Promise<void>;
  rollback: (proposal: number) => Promise<void>;
  learn: () => Promise<void>;
  cited: (session: string, seqs: number[]) => Promise<Cited>;
  /** Shows one of this project's sessions, and the entry `seq` in it if given. */
  onShow: (session: string, seq?: number) => void;
  onClose: () => void;
};

export function LearnedPane(props: Props) {
  const { proposals, selected, onSelect, onClose } = props;
  const shown = proposals?.find((p) => p.id === selected);

  return (
    <aside className="changes-pane learned-pane" aria-label="learned">
      <div className="changes-head">
        {shown ? (
          <button type="button" className="quiet back" onClick={() => onSelect(undefined)} aria-label="all proposals">
            <Icon name="chevron" className="left" /> Learned
          </button>
        ) : (
          <h2 className="pane-title">Learned</h2>
        )}
        <span className="spacer" />
        <button type="button" className="icon-button" onClick={onClose} aria-label="close learned" title="Close (⌘L)">
          <Icon name="x" />
        </button>
      </div>
      {shown ? <Detail {...props} proposal={shown} /> : <List {...props} />}
    </aside>
  );
}

/** A time ago as a list shows it: now, 5m, 3h, 2d. */
function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60_000);

  if (m < 1) return "now";

  if (m < 60) return `${m}m`;

  const h = Math.floor(m / 60);

  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function Badge({ status }: { status: ProposalState["status"] }) {
  return <span className={`badge status-${status}`}>{STATUS_NAMES[status]}</span>;
}

/** On a proposal from a run nobody asked for. */
function AutomaticBadge() {
  return (
    <span className="badge automatic" title="From a run strive started on its own">
      Automatic
    </span>
  );
}

/** The learn button, and what's happening with the latest run. */
function Learn({ run, learn }: Pick<Props, "run" | "learn">) {
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string>();
  const running = asking || run?.running === true;

  const start = () => {
    setAsking(true);
    setFailed(undefined);
    learn()
      .catch((e: Error) => setFailed(errorText(e)))
      .finally(() => setAsking(false));
  };

  return (
    <>
      <button type="button" className="learn" disabled={running} onClick={start}>
        <Icon name="bulb" /> Learn from recent sessions
      </button>
      {failed && <p className="danger small learn-note">Couldn't start learning: {failed}</p>}
      {run && !running && run.stopped && <p className="danger small learn-note">The learner stopped: {run.stopped}</p>}
    </>
  );
}

/** A run in progress: what the learner is doing, and for how long. */
function Learning({ run }: { run: Run }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, []);

  const s = Math.max(0, Math.floor((now - run.askedMs) / 1000));

  return (
    <div className="learning-now" role="status">
      <span className="pulse" />
      <span>Learning…</span>
      {run.step && <span className="faint">{run.step}</span>}
      <span className="spacer" />
      <span className="faint small">
        {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`}
      </span>
    </div>
  );
}

/** Learned files someone changed without a proposal, and what that means for review. */
function OutsideReview({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;

  const one = paths.length === 1;

  return (
    <section className="outside-review" aria-label="changed outside review">
      <h4>
        <Icon name="pencil" /> Changed outside review
      </h4>
      <ul>
        {paths.map((p) => (
          <li key={p} className="mono">
            {p}
          </li>
        ))}
      </ul>
      <p>
        {one ? "This file isn't" : "These files aren't"} what an accepted proposal last left there: edited by hand or by
        another tool, or written without a proposal. New sessions read {one ? "it" : "them"} as{" "}
        {one ? "it is" : "they are"}, unreviewed. Rolling back a proposal for {one ? "it" : "one"} is refused, and a
        proposal made before the change goes stale if accepted.
      </p>
    </section>
  );
}

/** Why the latest automatic run didn't start. */
function Skipped({ skipped }: { skipped?: SkippedRun }) {
  if (!skipped) return null;

  return (
    <p className="status-note skipped small" role="status" data-skipped="">
      An automatic run didn't start ({triggerText(skipped.trigger)}): {skipped.reason}
    </p>
  );
}

function List({ proposals, outsideReview, skipped, run, onSelect, learn }: Props) {
  const now = Date.now();

  if (proposals === undefined) return <div className="changes-body" />;

  return (
    <div className="changes-body">
      {run?.running && <Learning run={run} />}
      <OutsideReview paths={outsideReview} />
      <Skipped skipped={skipped} />
      {proposals.length === 0 ? (
        <div className="learned-empty">
          <div className="mark">
            <Icon name="bulb" />
          </div>
          <p>
            The learner reads this project's recent sessions and proposes changes to its memory and skills, which every
            new session reads. Nothing changes until a proposal is accepted, and you can roll it back.
          </p>
          <Learn run={run} learn={learn} />
        </div>
      ) : (
        <>
          <div className="learned-bar">
            <Learn run={run} learn={learn} />
          </div>
          <ul className="learned-list" aria-label="proposals">
            {proposals.map((p) => (
              <li key={p.id}>
                <button type="button" className="learned-item" onClick={() => onSelect(p.id)} data-proposal={p.id}>
                  <span className="summary">{p.proposal.summary}</span>
                  <span className="meta">
                    <Badge status={p.status} />
                    {p.trigger && <AutomaticBadge />}
                    <span className="mono">{artifactName(p.proposal.artifact)}</span>
                    <span className="spacer" />
                    <span className="when" title={new Date(p.madeAtMs).toLocaleString()}>
                      {ago(p.madeAtMs, now)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

type Confirming = "accept" | "rollback";

function Detail({
  proposal: p,
  proposals,
  outsideReview,
  sessions,
  currentSession,
  before,
  decide,
  rollback,
  run,
  learn,
  cited,
  onShow,
  onSelect,
}: Props & { proposal: ProposalState }) {
  const path = artifactPath(p.proposal.artifact);
  const [old, setOld] = useState<{ text: string | null } | { failed: string }>();
  const [confirming, setConfirming] = useState<Confirming>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let live = true;
    setOld(undefined);
    before(p.id).then(
      (text) => live && setOld({ text }),
      (e: Error) => live && setOld({ failed: errorText(e) }),
    );

    return () => {
      live = false;
    };
  }, [p.id, before]);

  useEffect(() => {
    setConfirming(undefined);
    setFailed(undefined);
  }, [p.id, p.status]);

  const act = (what: Promise<void>) => {
    setBusy(true);
    setFailed(undefined);
    what
      .catch((e: Error) => setFailed(errorText(e)))
      .finally(() => {
        setBusy(false);
        setConfirming(undefined);
      });
  };

  const known = new Map(sessions.map((s) => [s.id, s]));
  const history = fileHistory(proposals ?? [], p);
  const now = Date.now();

  return (
    <div className="changes-body learned-detail" data-proposal={p.id}>
      <header className="learned-head">
        <div className="learned-title">
          <Badge status={p.status} />
          {p.trigger && <AutomaticBadge />}
          <span className="faint small">#{p.id}</span>
        </div>
        <h3>{p.proposal.summary}</h3>
        <p className="faint small">
          <span className="mono">{path}</span> · proposed {new Date(p.madeAtMs).toLocaleString()}
        </p>
        {p.trigger && (
          <div className="trigger small" data-trigger={p.trigger.kind}>
            <p>Automatic run, {triggerText(p.trigger)}.</p>
            <ul>
              {p.trigger.signals.map((s) => (
                <li key={`${s.session}-${s.seq}`}>
                  <span className="faint">
                    {SIGN_NAMES[s.kind]}, entry {s.seq}:
                  </span>{" "}
                  {s.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className={`status-note ${p.status}`}>{statusNote(p, path)}</p>
        {outsideReview.includes(path) && (
          <p className="status-note outside">
            <span className="mono">{path}</span> has changed outside review: it isn't what an accepted proposal last
            left there.
          </p>
        )}
        {p.status === "stale" && <Learn run={run} learn={learn} />}
      </header>

      <Actions
        proposal={p}
        path={path}
        confirming={confirming}
        busy={busy}
        onConfirm={setConfirming}
        onAccept={() => act(decide(p.id, "accept"))}
        onReject={() => act(decide(p.id, "reject"))}
        onRollback={() => act(rollback(p.id))}
      />
      {failed && <p className="danger small pad">{failed}</p>}

      <section className="learned-section">
        <h4>{p.before === undefined ? "New file" : "Change, against the file as the learner read it"}</h4>
        {old === undefined && <p className="faint small">Loading…</p>}
        {old && "failed" in old && <p className="danger small">Couldn't read the file as it was: {old.failed}</p>}
        {old && "text" in old && (
          <div className="learned-diff">
            <Diff before={old.text ?? ""} after={p.proposal.content} path={path} />
          </div>
        )}
      </section>

      <section className="learned-section">
        <h4>Why</h4>
        <Markdown text={p.proposal.rationale} />
      </section>

      <section className="learned-section" aria-label="prediction">
        <h4>Prediction</h4>
        <Markdown text={p.proposal.prediction} />
      </section>

      <section className="learned-section">
        <h4>Evidence</h4>
        <ul className="evidence">
          {p.proposal.evidence.map((e, i) => (
            // Evidence has no identity beyond its place in the proposal.
            <EvidenceItem
              key={`${p.id}-${e.session}-${i}`}
              evidence={e}
              session={known.get(e.session)}
              shown={e.session === currentSession}
              cited={cited}
              onShow={onShow}
            />
          ))}
        </ul>
      </section>

      <section className="learned-section">
        <h4>Checks</h4>
        <ul className="checks">
          {p.gates.map((g) => (
            <Check key={g.gate} gate={g} />
          ))}
          {p.gates.length === 0 && <li className="faint small">None has finished yet.</li>}
        </ul>
      </section>

      {history.length > 1 && (
        <section className="learned-section">
          <h4>Proposals for {path}</h4>
          <ol className="file-history" aria-label="proposals for this file">
            {history.map((q) => (
              <li key={q.id} className={q.id === p.id ? "this" : undefined}>
                <Badge status={q.status} />
                {q.id === p.id ? (
                  <span className="summary" aria-current="true">
                    {q.proposal.summary}
                  </span>
                ) : (
                  <button type="button" className="link summary" onClick={() => onSelect(q.id)} data-proposal={q.id}>
                    {q.proposal.summary}
                  </button>
                )}
                <span className="when faint small" title={new Date(q.madeAtMs).toLocaleString()}>
                  {ago(q.madeAtMs, now)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

type EvidenceProps = {
  evidence: Evidence;
  /** The cited session, if it's one of this project's. */
  session?: SessionInfo;
  /** Whether the window shows that session now. */
  shown: boolean;
  cited: Props["cited"];
  onShow: Props["onShow"];
};

type Loaded = { cited: Cited } | { failed: string };

/** One piece of evidence: its session, the note, and the entries it cites, opened on request. */
function EvidenceItem({ evidence: e, session: s, shown, cited, onShow }: EvidenceProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>();
  const name = s?.title ?? "New session";

  useEffect(() => {
    if (!open || loaded || s === undefined) return;

    let live = true;
    cited(s.id, e.seqs).then(
      (c) => live && setLoaded({ cited: c }),
      (err: Error) => live && setLoaded({ failed: errorText(err) }),
    );

    return () => {
      live = false;
    };
  }, [open, loaded, s, e.seqs, cited]);

  const first = e.seqs.length > 0 ? Math.min(...e.seqs) : undefined;

  return (
    <li>
      <div className="evidence-head">
        {s === undefined ? (
          <span className="mono faint" title="Not one of this project's sessions">
            {e.session}
          </span>
        ) : shown ? (
          <span className="session-name" title={s.id}>
            {name} <span className="faint">(shown)</span>
          </span>
        ) : (
          <button type="button" className="link" title={s.id} onClick={() => onShow(s.id, first)}>
            {name}
          </button>
        )}
        {e.seqs.length > 0 && (
          <span className="faint small">
            {e.seqs.length === 1 ? "entry" : "entries"} {e.seqs.join(", ")}
          </span>
        )}
      </div>
      <p className="prose">{e.note}</p>
      {s !== undefined && e.seqs.length > 0 && (
        <>
          <button type="button" className="quiet cited-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="chevron" className={open ? "open" : ""} />
            {open ? "Hide" : "Show"} what {e.seqs.length === 1 ? "it cites" : `the ${e.seqs.length} entries say`}
          </button>
          {open && <CitedEntries loaded={loaded} seqs={e.seqs} cwd={s.cwd} onShow={(seq) => onShow(s.id, seq)} />}
        </>
      )}
    </li>
  );
}

function CitedEntries({
  loaded,
  seqs,
  cwd,
  onShow,
}: {
  loaded?: Loaded;
  seqs: number[];
  cwd: string;
  onShow: (seq: number) => void;
}) {
  if (loaded === undefined) return <p className="faint small cited-note">Loading…</p>;

  if ("failed" in loaded) return <p className="danger small cited-note">Couldn't read the session: {loaded.failed}</p>;

  const shown = blocks(loaded.cited, seqs, cwd);

  return (
    <div className="cited" role="list" aria-label="cited entries">
      {shown.blocks.map((b) => (
        <div key={b.seq} className={`cited-entry ${b.cited ? "named" : ""}`} role="listitem" data-seq={b.seq}>
          <div className="cited-head">
            <button type="button" className="seq" title="Show it in the conversation" onClick={() => onShow(b.seq)}>
              #{b.seq}
            </button>
            <span className="who">{b.who}</span>
          </div>
          {b.style === "markdown" ? (
            <Markdown text={b.text} />
          ) : (
            <p className={b.style === "code" ? "code" : "prose"}>{b.text}</p>
          )}
          {b.output !== undefined && <pre className="output">{b.output}</pre>}
        </div>
      ))}
      {shown.missing.length > 0 && (
        <p className="danger small cited-note">
          The session has no {shown.missing.length === 1 ? "entry" : "entries"} {shown.missing.join(", ")}.
        </p>
      )}
    </div>
  );
}

/** A check's outcome; the judge's, when its detail reads by criterion, one line per criterion. */
function Check({ gate: g }: { gate: GateOutcome }) {
  const judged = g.gate === "judge" ? readJudge(g.detail) : undefined;

  return (
    <li data-gate={g.gate}>
      <span className="gate">{GATE_NAMES[g.gate]}</span>
      <span className={`badge verdict-${g.verdict}`}>{VERDICT_NAMES[g.verdict]}</span>
      {judged === undefined ? (
        <span className="detail">{g.detail}</span>
      ) : (
        <div className="detail judged">
          <p className="judge-head">{judged.head}</p>
          {judged.summary && <p className="judge-summary">{judged.summary}</p>}
          <ul className="criteria" aria-label="criteria">
            {judged.criteria.map((c) => (
              <li key={c.id} data-criterion={c.id} className={c.pass ? "pass" : "fail"}>
                <span className="mark" role="img" aria-label={c.pass ? "passed" : "failed"}>
                  <Icon name={c.pass ? "check" : "x"} />
                </span>
                <span className="name">{c.name}</span>
                <span className="reason">{c.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

type ActionsProps = {
  proposal: ProposalState;
  path: string;
  confirming?: Confirming;
  busy: boolean;
  onConfirm: (what?: Confirming) => void;
  onAccept: () => void;
  onReject: () => void;
  onRollback: () => void;
};

function Actions({ proposal: p, path, confirming, busy, onConfirm, onAccept, onReject, onRollback }: ActionsProps) {
  if (confirming)
    return (
      <div className="learned-actions confirm" role="group" aria-label={`confirm ${confirming}`}>
        <span>
          {confirming === "accept"
            ? `Write ${path}? New sessions in this project will read it.`
            : p.before === undefined
              ? `Remove ${path}? It didn't exist before this proposal.`
              : `Put ${path} back as it was before this proposal?`}
        </span>
        <button type="button" className="quiet" onClick={() => onConfirm(undefined)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={confirming === "accept" ? onAccept : onRollback}
        >
          {confirming === "accept" ? "Write it" : "Roll back"}
        </button>
      </div>
    );

  const undecided = p.status === "ready" || p.status === "failed" || p.status === "checking";

  if (!undecided && p.status !== "applied") return null;

  return (
    <div className="learned-actions">
      {undecided && (
        <button type="button" disabled={busy} onClick={onReject}>
          Reject
        </button>
      )}
      {undecided && (
        <button
          type="button"
          className="primary"
          disabled={busy || p.status !== "ready"}
          title={p.status === "ready" ? undefined : "Only a proposal whose checks passed can be accepted"}
          onClick={() => onConfirm("accept")}
        >
          Accept
        </button>
      )}
      {p.status === "applied" && (
        <button type="button" disabled={busy} onClick={() => onConfirm("rollback")}>
          <Icon name="rewind" /> Roll back
        </button>
      )}
    </div>
  );
}
