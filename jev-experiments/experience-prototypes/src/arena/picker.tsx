import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { useRef, useState } from "react";
import { colorVars, MAX_CONTESTANTS, type CardModel } from "./model";

const KIND_LABEL = {
  hosted: "Hosted models",
  local: "Local models",
  code: "Code references",
} as const;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Contestant chips with remove buttons, and a searchable list to add more. */
export function Picker({ model: m }: { model: CardModel }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const chips = useRef<HTMLDivElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const available = m.pool.filter((c) => !m.ids.includes(c.id));
  const exhausted = !available.length;
  const full = m.ids.length >= MAX_CONTESTANTS;
  const noun = m.noun;

  const remove = (id: string) => {
    const index = m.ids.indexOf(id);

    m.set({ c: m.ids.filter((x) => x !== id) }, "push");
    // Keep keyboard focus in the chip row: the next chip's remove button, or Add.
    requestAnimationFrame(() => {
      const buttons = chips.current?.querySelectorAll<HTMLButtonElement>(".chip-remove");
      const next = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];

      (next ?? add.current)?.focus();
    });
  };

  return (
    <div className="picker">
      <div
        className="chips"
        ref={chips}
        role="list"
        aria-label={`${capital(noun)}s in this figure`}
      >
        {m.ids.map((id) => {
          const c = m.contestant(id);

          if (!c) return null;

          return (
            <span key={id} role="listitem" className="chip" style={colorVars(c)} data-kind={c.kind}>
              <span className="swatch" aria-hidden="true" />
              <span className="chip-name">{c.name}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${c.name}`}
                disabled={m.ids.length <= 1}
                onClick={() => remove(id)}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      {exhausted ? (
        <span className="picker-count">All {m.ids.length} shown</span>
      ) : (
        <Popover.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next);

            if (!next) setSearch("");
          }}
        >
          <span className="picker-add">
            <Popover.Trigger asChild>
              <button ref={add} type="button" className="add" disabled={full}>
                Add {noun}
              </button>
            </Popover.Trigger>
            <span className="picker-count">
              {full
                ? `${MAX_CONTESTANTS} is the most one figure shows`
                : `${m.ids.length} of ${Math.min(MAX_CONTESTANTS, m.pool.length)}`}
            </span>
          </span>
          <Popover.Portal>
            <Popover.Content
              className="picker-popover"
              align="start"
              sideOffset={6}
              collisionPadding={16}
            >
              <Command label={`Add a ${noun}`} loop>
                <Command.Input
                  className="picker-search"
                  placeholder={`Search ${noun}s`}
                  value={search}
                  onValueChange={setSearch}
                  autoFocus
                />
                <Command.List className="picker-list">
                  <Command.Empty className="picker-empty">
                    No {noun} matches “{search}”.{" "}
                    <button type="button" className="text-button" onClick={() => setSearch("")}>
                      Clear search
                    </button>
                  </Command.Empty>
                  {(["hosted", "local", "code"] as const).map((kind) => {
                    const list = available.filter((c) => c.kind === kind);
                    const heading = noun === "condition" ? "Conditions" : KIND_LABEL[kind];

                    return list.length ? (
                      <Command.Group key={kind} heading={heading} className="picker-group">
                        {list.map((c) => (
                          <Command.Item
                            key={c.id}
                            value={`${c.name} ${c.policy ?? ""}`}
                            className="picker-option"
                            style={colorVars(c)}
                            data-kind={c.kind}
                            onSelect={() => {
                              m.set({ c: [...m.ids, c.id] }, "push");
                              setOpen(false);
                            }}
                          >
                            <span className="swatch" aria-hidden="true" />
                            <span>
                              <b>{c.name}</b>
                              {c.policy && <small>{c.policy}</small>}
                            </span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    ) : null;
                  })}
                </Command.List>
              </Command>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
      {m.dropped.length > 0 && <p className="notice">Not on this card: {m.dropped.join(", ")}.</p>}
      {m.protocolsInView.size > 1 && (
        <p className="notice">
          These contestants were recorded under {m.protocolsInView.size} different protocols (
          {m.card.protocolGroups
            .filter((g) => m.protocolsInView.has(g.hash))
            .map((g) => g.label)
            .join("; ")}
          ). Compare with care.
        </p>
      )}
    </div>
  );
}
