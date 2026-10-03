/**
 * The evidence drawer for game and simulation pages: play stays first, and the evidence (results,
 * method, caveats, data and the About material) opens in a side drawer only when asked. A native
 * <dialog> gives focus handling and Escape to close.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./formats.css";

export type EvidenceTab = { id: string; label: string; content: ReactNode };

export function EvidenceDrawer({
  open,
  onClose,
  title,
  tabs,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  tabs: EvidenceTab[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState(tabs[0]?.id ?? "");
  const base = useId();
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];

  useEffect(() => {
    const d = dialog.current;

    if (!d) return;

    if (open && !d.open) d.showModal();

    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="fmt-drawer"
      aria-labelledby={`${base}-title`}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="fmt-drawer-head">
        <h2 id={`${base}-title`}>Evidence: {title}</h2>
        <button type="button" className="fmt-drawer-close" onClick={onClose} aria-label="Close the evidence">
          ✕
        </button>
      </div>
      <div className="fmt-drawer-tabs" role="tablist" aria-label="Evidence">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={current?.id === t.id}
            aria-controls={`${base}-panel`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {current && (
        <div className="fmt-drawer-panel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${current.id}`}>
          {current.content}
        </div>
      )}
    </dialog>
  );
}
