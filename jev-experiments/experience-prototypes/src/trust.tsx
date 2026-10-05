/**
 * Honest labels for controls, and the session meter. A control says whether pressing it calls
 * Jev on the visitor's key or replays something free; the meter says what this tab has spent.
 */
import { useHasKey } from "./api";
import type { Failure } from "./live-failure";
import { tagText, type TagMode } from "./mode";
import { formatCost } from "./receipt";
import { LIST_PRICE, resetSession, useSessionUsage } from "./session-meter";
import "./trust.css";

/** A small tag on, or right beside, a control. */
export function ModeTag({ mode }: { mode: TagMode }) {
  return <small className={`mode-tag mode-${mode}`}>{tagText(mode)}</small>;
}

/** The tag for a control that calls Jev: "live · your key", or "needs your key" until one is connected. */
export function KeyTag() {
  return <ModeTag mode={useHasKey() ? "live" : "needs-key"} />;
}

/** Opens the header's Settings panel, where the key is added. */
export function openSettings() {
  const details = document.querySelector<HTMLDetailsElement>("details:has(> summary[aria-label='Settings'])");

  if (!details) return;

  details.open = true;
  details.querySelector("summary")?.focus();
}

/**
 * The one way a live failure is shown: what happened, what's still on screen, and what to do.
 * `fallback` is required: one sentence saying what this scene is still showing or doing (a
 * recorded answer, the last card, fish keeping their last action). The shared failure messages
 * never claim a fallback, so this sentence is the only place that does. `alt` is a scene-specific
 * way out, such as switching to the free model.
 */
export function LiveFailure({
  failure,
  onRetry,
  fallback,
  alt,
}: {
  failure: Failure;
  onRetry?: () => void;
  fallback: string;
  alt?: { label: string; onClick: () => void };
}) {
  if (failure.kind === "cancelled") return null;

  const needsKey = failure.kind === "no-key" || failure.kind === "bad-key";
  const wait = failure.retryAfterMs ? Math.ceil(failure.retryAfterMs / 1000) : null;

  return (
    <div className={`live-failure live-failure-${failure.kind}`} role="alert">
      <p>
        <b>{failure.title}</b> {failure.message}
        {failure.kind === "rate-limited" && wait ? ` The server asked to wait ${wait} s.` : ""}
      </p>
      <p className="live-failure-fallback">{fallback}</p>
      <div className="live-failure-actions">
        {needsKey && (
          <button type="button" onClick={openSettings}>
            {failure.kind === "no-key" ? "Add key" : "Check key"}
          </button>
        )}
        {failure.retryable && onRetry && (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        )}
        {alt && (
          <button type="button" onClick={alt.onClick}>
            {alt.label}
          </button>
        )}
      </div>
    </div>
  );
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
