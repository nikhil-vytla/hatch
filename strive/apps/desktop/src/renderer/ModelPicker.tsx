// The composer's model chip, which opens the models the daemon can price.
// A session's agent starts on its model and keeps it, so the choice is open
// only until the first prompt; after that the picker says so.
import type { ModelInfo } from "@strive/protocol";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

type Props = {
  /** The daemon's priced models; undefined until they've loaded. */
  models?: ModelInfo[];
  /** The model the session uses (or will). */
  current?: string;
  /** Providers with a key: a model of any other can't be called. */
  keyed: ReadonlySet<string>;
  /** The session has a prompt, so its model is fixed. */
  locked: boolean;
  onPick: (model: string) => void;
  onNewSession: () => void;
};

/** Dollars per million tokens, as short as they go: $1, $0.25, $1.25. */
function perMillion(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? (micros % 1_000_000 === 0 ? 0 : 2) : 3)}`;
}

function contextSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}

export function ModelPicker({ models, current, keyed, locked, onPick, onNewSession }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Closes on a click anywhere else, or Escape (which then doesn't also interrupt the agent).
  useEffect(() => {
    if (!open) return;

    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };

    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape, true);
    list.current?.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus();

    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  // Up and Down move between the options.
  const step = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;

    e.preventDefault();
    const options = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const at = options.findIndex((o) => o === document.activeElement);
    options[(at + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length]?.focus();
  };

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="chip"
        aria-label={`model: ${current ?? "loading"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="The model the agent uses"
        onClick={() => setOpen(!open)}
      >
        <Icon name="spark" />
        <span className="chip-text">{current ?? "…"}</span>
        <Icon name="chevronDown" className="caret" />
      </button>
      {open && (
        <div className="popover model-menu" role="dialog" aria-label="models">
          {locked && (
            <p className="menu-note">
              This session's agent keeps the model it started with; switching mid-session isn't supported.
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  setOpen(false);
                  onNewSession();
                }}
              >
                New session <kbd>⌘N</kbd>
              </button>
            </p>
          )}
          <div role="listbox" aria-label="model" tabIndex={-1} ref={list} onKeyDown={step}>
            {models === undefined && <p className="menu-note">Loading…</p>}
            {models?.map((m) => {
              const selected = m.id === current;
              const disabled = locked && !selected;

              return (
                <div
                  key={m.id}
                  role="option"
                  tabIndex={disabled ? -1 : 0}
                  aria-selected={selected}
                  aria-disabled={disabled}
                  className="option"
                  onClick={() => {
                    if (disabled) return;
                    setOpen(false);

                    if (!selected) onPick(m.id);
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !disabled) {
                      e.preventDefault();
                      setOpen(false);

                      if (!selected) onPick(m.id);
                    }
                  }}
                >
                  <span className="check">{selected && <Icon name="check" />}</span>
                  <span className="name">{m.id}</span>
                  {!keyed.has(m.provider) && <span className="tag">no {m.provider} key</span>}
                  <span className="meta">
                    {contextSize(m.contextWindow)} · {perMillion(m.inputUsdMicros)} / {perMillion(m.outputUsdMicros)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="menu-foot">Context · dollars per million tokens in / out</p>
        </div>
      )}
    </div>
  );
}
