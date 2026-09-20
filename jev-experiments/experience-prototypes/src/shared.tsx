import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Play,
  LoaderCircle,
  Download,
  ChevronDown,
  Info,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { download, pretty, percent } from "./api";
export function Button({
  children,
  onClick,
  disabled = false,
  secondary = false,
  ...props
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  secondary?: boolean;
  [key: string]: any;
}) {
  return (
    <button
      className={secondary ? "button secondary" : "button"}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
export function RunButton({
  busy,
  onClick,
  label = "Run with Jev",
}: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button onClick={onClick} disabled={busy}>
      {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={14} />}{" "}
      {busy ? "Working through it…" : label}
    </Button>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={"notice " + (error ? "error" : "")}
      role={error ? "alert" : "status"}
    >
      <Info size={15} />
      <span>{children}</span>
    </div>
  );
}
export function Pane({
  title,
  children,
  sub,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  sub?: string;
  className?: string;
}) {
  return (
    <section className={"pane " + className}>
      {title && (
        <div className="pane-heading">
          <h3>{title}</h3>
          {sub && <span>{sub}</span>}
        </div>
      )}
      {children}
    </section>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Pills({
  values,
  value,
  onChange,
}: {
  values: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="pills">
      {values.map((v) => (
        <button
          key={v}
          className={value === v ? "active" : ""}
          onClick={() => onChange(v)}
        >
          {pretty(v)}
        </button>
      ))}
    </div>
  );
}
export function Fold({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="fold" open={open || undefined}>
      <summary>
        {title}
        <ChevronDown size={15} />
      </summary>
      <div>{children}</div>
    </details>
  );
}
export function State({
  value,
  title = "Inspect the state",
}: {
  value: any;
  title?: string;
}) {
  return (
    <Fold title={title}>
      <pre className="code">{JSON.stringify(value, null, 2)}</pre>
      <Button secondary onClick={() => download("jev-record.json", value)}>
        <Download size={14} /> Export JSON
      </Button>
    </Fold>
  );
}
export function Bars({
  values,
  selected,
}: {
  values: Record<string, number>;
  selected?: string;
}) {
  return (
    <div className="bars">
      {Object.entries(values)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => (
          <div className={"bar " + (k === selected ? "selected" : "")} key={k}>
            <span>{pretty(k)}</span>
            <div>
              <motion.i
                initial={{ width: 0 }}
                animate={{ width: percent(v) }}
                transition={{ duration: 0.5 }}
              />
            </div>
            <small>{percent(v)}</small>
          </div>
        ))}
    </div>
  );
}
export function Stat({
  value,
  label,
  note,
}: {
  value: ReactNode;
  label: string;
  note?: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function ErrorText({ error }: { error: string }) {
  return error ? <Notice error>{error}</Notice> : null;
}
export function useRun() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return {
    busy,
    error,
    execute: async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
  };
}
export function Availability({ rows, result }: { rows: any[]; result: any }) {
  const unavailable = rows.filter((r) => r.error).length;
  return (
    <Fold title="How these results were collected">
      <p>
        {rows.length} planned cases · {rows.length - unavailable} returned
        results · {unavailable} unavailable. Completed examples are shown in the
        explorer. Incorrect answers remain visible.
      </p>
      <p>
        Availability and answer quality are separate. Temporary capacity errors
        can be retried; retries are never independent test cases. Results are
        from the recorded run shown here.
      </p>
      {result.recovery && (
        <p>
          {result.recovery.recovered_cases ??
            result.recovery.attempts?.filter(
              (a: any) => a.status === "completed",
            ).length}{" "}
          cases recovered after temporary failures. Original answers were
          retained. Original-run timing and recovery timing are recorded
          separately.
        </p>
      )}
      {result.note && <p>{result.note}</p>}
      {unavailable > 0 && (
        <State
          title="Unavailable cases and operational details"
          value={{
            unavailable: rows.filter((r) => r.error),
            transport: result.transport,
            recovery: result.recovery,
          }}
        />
      )}
    </Fold>
  );
}
