/** What a One box shows, drawn the same way in the Watch and Try it views. */
import {
  ArrowLeftRight,
  Bell,
  Calculator,
  Calendar,
  Contact,
  Dices,
  Globe,
  Hourglass,
  Link,
  ListTodo,
  Palette,
  Plane,
  Receipt,
  Repeat,
  StickyNote,
  Target,
  Timer,
  Users,
  Vote,
} from "lucide-react";
import type { ReactElement } from "react";
import type { Shown as CalmShown } from "../../../packages/arena/src/one-box/calm";

const ICON = { "aria-hidden": true, size: 18, strokeWidth: 1.75 } as const;

/** One icon per card, created once. */
const ICONS = new Map<string, ReactElement>([
  ["event", <Calendar key="event" {...ICON} />],
  ["reminder", <Bell key="reminder" {...ICON} />],
  ["todo", <ListTodo key="todo" {...ICON} />],
  ["timer", <Timer key="timer" {...ICON} />],
  ["habit", <Repeat key="habit" {...ICON} />],
  ["color", <Palette key="color" {...ICON} />],
  ["split", <Users key="split" {...ICON} />],
  ["expense", <Receipt key="expense" {...ICON} />],
  ["convert", <ArrowLeftRight key="convert" {...ICON} />],
  ["calc", <Calculator key="calc" {...ICON} />],
  ["travel", <Plane key="travel" {...ICON} />],
  ["poll", <Vote key="poll" {...ICON} />],
  ["contact", <Contact key="contact" {...ICON} />],
  ["link", <Link key="link" {...ICON} />],
  ["countdown", <Hourglass key="countdown" {...ICON} />],
  ["timezone", <Globe key="timezone" {...ICON} />],
  ["random", <Dices key="random" {...ICON} />],
  ["goal", <Target key="goal" {...ICON} />],
  ["note", <StickyNote key="note" {...ICON} />],
]);

export type State =
  | { kind: "input" }
  | { kind: "ghost" | "committed"; card: string }
  | { kind: "choose"; cards: string[] };

export function parse(state: string): State {
  const [kind, rest = ""] = state.split(":");

  if (kind === "choose") return { kind, cards: rest.split("|") };

  if ((kind === "ghost" || kind === "committed") && rest) return { kind, card: rest };

  return { kind: "input" };
}

/** The calm reducer's state, in the shape the views draw. */
export function fromCalm(s: CalmShown): State {
  if (s.kind === "choose") return { kind: "choose", cards: s.options };

  if (s.kind === "input") return { kind: "input" };

  return { kind: s.kind, card: s.intent };
}

export const words = (card: string) => card.replaceAll("_", " ");

function CardFace({
  card,
  kind,
  wrong,
}: {
  card: string;
  kind: "ghost" | "committed";
  wrong: boolean;
}) {
  return (
    <div className="ob-card" data-kind={kind} data-wrong={wrong}>
      {ICONS.get(card) ?? <StickyNote {...ICON} />}
      <span className="ob-card-name">{words(card)}</span>
      <span className="ob-card-note">
        {kind === "ghost" ? "preview" : wrong ? "wrong card" : "card"}
      </span>
    </div>
  );
}

/** `ok` is the fair cards when there is an expected answer; live text has none, so nothing is "wrong". */
export function Shown({ state, ok }: { state: State; ok?: Set<string> }) {
  if (state.kind === "input") return <p className="ob-waiting">waiting</p>;

  if (state.kind === "choose")
    return (
      <div className="ob-chips">
        {state.cards.map((c) => (
          <span key={c} className="ob-chip">
            {words(c)}
          </span>
        ))}
      </div>
    );

  return (
    <CardFace
      card={state.card}
      kind={state.kind}
      wrong={ok !== undefined && state.kind === "committed" && !ok.has(state.card)}
    />
  );
}
