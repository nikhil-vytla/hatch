/**
 * "More controls": the advanced half of a creative tool, folded away until asked for. The
 * controls stay mounted while closed (hidden, not removed), so their state and every feature
 * survive. The open state is remembered per tool in localStorage.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const storageKey = (id: string) => `jev:more-controls:${id}`;

function readOpen(id: string) {
  try {
    return localStorage.getItem(storageKey(id)) === "open";
  } catch {
    return false;
  }
}

export function MoreControls({
  id,
  what,
  children,
  className = "",
}: {
  /** Unique per tool (and per disclosure within a tool); keys the remembered state. */
  id: string;
  /** What's inside, after "More controls": e.g. "mixer, note editor and exports". */
  what: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(() => readOpen(id));
  const region = useId();

  const toggle = () =>
    setOpen((was) => {
      try {
        localStorage.setItem(storageKey(id), was ? "closed" : "open");
      } catch {
        // Private mode or storage full: the disclosure still works, it just won't be remembered.
      }

      return !was;
    });

  return (
    <div className={`more-controls ${open ? "is-open" : ""} ${className}`}>
      <button type="button" className="more-controls-toggle" aria-expanded={open} aria-controls={region} onClick={toggle}>
        <span>
          {open ? "Fewer controls" : "More controls"}
          <small>{what}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id={region} className="more-controls-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
