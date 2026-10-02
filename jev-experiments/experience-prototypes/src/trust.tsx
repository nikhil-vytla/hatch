/**
 * Honest labels for controls, and the session meter. A control says whether pressing it calls
 * Jev on the visitor's key or replays something free; the meter says what this tab has spent.
 */
import { useHasKey } from "./api";
import { formatCost } from "./receipt";
import { LIST_PRICE, resetSession, useSessionUsage } from "./session-meter";
import "./trust.css";

export type Mode = "recorded" | "live" | "browser" | "needs-key";

const MODE_TEXT: Record<Mode, string> = {
  recorded: "recorded · free",
  live: "live · your key",
  browser: "in your browser · free",
  "needs-key": "live · needs your key",
};

/** A small tag on, or right beside, a control. */
export function ModeTag({ mode }: { mode: Mode }) {
  return <small className={`mode-tag mode-${mode}`}>{MODE_TEXT[mode]}</small>;
}

/** The tag for a control that calls Jev: "live · your key", or "needs your key" until one is connected. */
export function KeyTag() {
  return <ModeTag mode={useHasKey() ? "live" : "needs-key"} />;
}

/** This tab's spend on the visitor's key. Renders nothing until a key is connected. */
export function SessionMeter({ connected, compact = false }: { connected: boolean; compact?: boolean }) {
  const u = useSessionUsage();

  if (!connected) return null;

  const calls = `${u.calls} call${u.calls === 1 ? "" : "s"}`;
  const tokens = `${u.inputTokens.toLocaleString("en-US")} tokens`;

  return (
    <div className={`session-meter${compact ? " compact" : ""}`} aria-live="polite">
      <span className="session-meter-head">Your key this session</span>
      <span className="session-meter-line">
        {calls}
        {u.failed ? ` (${u.failed} failed)` : ""} · {tokens} · {formatCost(u.costUsd)}
      </span>
      {!compact && (
        <>
          <span className="session-meter-price">
            <a href={LIST_PRICE.source} target="_blank" rel="noreferrer">
              {LIST_PRICE.label}
            </a>{" "}
            · list price, read {LIST_PRICE.checked}. Resets on reload. Recorded answers and in-browser models cost $0.
          </span>
          {u.calls > 0 && (
            <button type="button" className="session-meter-reset" onClick={resetSession}>
              Reset
            </button>
          )}
        </>
      )}
    </div>
  );
}
