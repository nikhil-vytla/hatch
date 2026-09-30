/**
 * Snake and Orbital rescue as one scene. Both replay recorded Jev moves beside a greedy rule,
 * so the scene says how often the greedy rule would have made Jev's move.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { greedy, type Game } from "../../local-models-and-games/arcade/engine";
import { Pane, Pills, Stat } from "./shared";

const Arcade = lazy(() => import("./arcade").then((m) => ({ default: m.Arcade })));

const GAMES: { id: Game; label: string }[] = [
  { id: "snake", label: "Snake" },
  { id: "orbital", label: "Orbital rescue" },
];

/** On every state Jev faced in the recording, would the greedy rule have made the same move? */
function agreement(result: any, game: Game) {
  let same = 0;
  let n = 0;

  for (const e of result.episodes ?? []) {
    if (e.game !== game || e.policy !== "jev" || !e.completed) continue;

    for (const t of e.trace ?? []) {
      if (!t.action || !t.state) continue;
      n++;
      same += Number(greedy(t.state) === t.action);
    }
  }

  return { same, n };
}

export function ArcadeScene({ result, initial = "snake" }: { result: any; initial?: Game }) {
  const [game, setGame] = useState<Game>(initial);
  const a = useMemo(() => agreement(result, game), [result, game]);
  const label = GAMES.find((g) => g.id === game)?.label ?? game;

  return (
    <div className="arcade-scene">
      <Pills
        values={GAMES.map((g) => g.label)}
        value={label}
        onChange={(v) => setGame(GAMES.find((g) => g.label === v)?.id ?? "snake")}
      />
      {a.n > 0 && (
        <Pane title="How different is Jev from a simple rule?" sub="Recorded Jev moves">
          <Stat
            label="Moves the greedy rule would also have made"
            value={`${a.same} of ${a.n}`}
            note={
              game === "orbital"
                ? "Code shows Jev a one-step preview of every action, and Jev almost always picks what the greedy rule picks. Both controllers win every seed, so this game doesn't show Jev doing anything the rule can't."
                : "Where Jev departs from the greedy rule it doesn't do better: across the three seeds it ties or loses to the rule."
            }
          />
        </Pane>
      )}
      <Suspense fallback={<div className="loading-stage">Opening the arena…</div>}>
        <Arcade key={game} game={game} result={result} />
      </Suspense>
    </div>
  );
}
