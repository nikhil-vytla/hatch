// The command palette (⌘K): every action the window has, and the project's
// sessions, found by typing a few letters.
import type { ApprovalMode, SessionInfo } from "@strive/protocol";
import { MODE_NAMES } from "@strive/view";
import { Command } from "cmdk";
import { useEffect, useState } from "react";

export type PaletteAction = {
  id: string;
  label: string;
  /** The keys that do it without the palette, shown beside it. */
  keys?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: PaletteAction[];
  modes: { current: ApprovalMode; set: (m: ApprovalMode) => void };
  checkpoints: { n: number; label: string }[];
  onRewind: (n: number) => void;
  sessions: () => Promise<SessionInfo[]>;
  currentSession: string;
  onSwitch: (id: string) => void;
};

const MODES: ApprovalMode[] = ["ask", "autoEdit", "fullAuto"];

export function Palette({
  open,
  onOpenChange,
  actions,
  modes,
  checkpoints,
  onRewind,
  sessions,
  currentSession,
  onSwitch,
}: Props) {
  const [listed, setListed] = useState<SessionInfo[]>([]);

  useEffect(() => {
    if (open) sessions().then(setListed, () => undefined);
  }, [open, sessions]);

  const others = listed.filter((s) => s.id !== currentSession);

  // Runs the choice once the palette has closed, so focus goes back where it was first.
  const choose = (run: () => void) => () => {
    onOpenChange(false);
    run();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      contentClassName="palette"
      overlayClassName="palette-overlay"
    >
      <Command.Input placeholder="Search commands and sessions…" />
      <Command.List>
        <Command.Empty>Nothing matches.</Command.Empty>
        <Command.Group heading="Actions">
          {actions.map((a) => (
            <Command.Item key={a.id} value={a.label} onSelect={choose(a.run)}>
              <span>{a.label}</span>
              {a.keys && <kbd>{a.keys}</kbd>}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Approvals">
          {MODES.map((m) => (
            <Command.Item key={m} value={`Approvals: ${MODE_NAMES[m]}`} onSelect={choose(() => modes.set(m))}>
              <span>Approvals: {MODE_NAMES[m]}</span>
              {modes.current === m && <span className="faint">current</span>}
            </Command.Item>
          ))}
        </Command.Group>
        {checkpoints.length > 0 && (
          <Command.Group heading="Rewind">
            {checkpoints.toReversed().map((c) => (
              <Command.Item
                key={c.n}
                value={`Rewind to checkpoint ${c.n} ${c.label}`}
                onSelect={choose(() => onRewind(c.n))}
              >
                <span>
                  Rewind to {c.n}: {c.label || "checkpoint"}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {others.length > 0 && (
          <Command.Group heading="Sessions">
            {others.map((s) => (
              <Command.Item
                key={s.id}
                value={`Session ${s.title ?? "New session"} ${s.id}`}
                onSelect={choose(() => onSwitch(s.id))}
              >
                <span>{s.title ?? "New session"}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
