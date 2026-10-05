/**
 * Tetris items: a mid-game board, the falling piece and three labelled landings drawn on the
 * board. The state shows pictures only; the engine works out the answers (full rows, buried
 * empty cells, highest column), which the state never states.
 */
import {
  boardFeatures,
  cells,
  chooseLanding,
  command,
  createGame,
  landings,
  ROWS,
  type Game,
  type Landing,
} from "../tetris-engine";
import { type Item, type WireQuestion } from "./items";
import { mulberry32, shuffled } from "../../../seeded/src/index";

const LABELS = ["A", "B", "C"] as const;

type Label = (typeof LABELS)[number];

const TASK =
  "A Tetris piece is about to land. The board is 10 columns wide; rows run top to bottom and empty rows above the stack are left out. '#' is a filled cell and '.' is empty. Each landing shows the same board with the piece's four cells drawn as '@'. Full rows disappear after the piece lands.";

const rowsOf = (board: number[][], from: number, marked = new Set<string>()) =>
  board
    .slice(from)
    .map((row, dy) =>
      row.map((v, x) => (marked.has(`${x},${from + dy}`) ? "@" : v ? "#" : ".")).join(""),
    );

/** What code knows about a landing, after it locks and full rows clear. */
export function landingFacts(before: number[][], l: Landing) {
  const placed = new Set(cells(l.pose).map(([x, y]) => `${x},${y}`));

  const completes = before.some((row, y) =>
    row.every((v, x) => v !== 0 || placed.has(`${x},${y}`)),
  );

  return { completes, holes: l.features.holes, height: l.features.height, lines: l.features.lines };
}

/** The unique minimum of a measure among labelled facts, or null on a tie. */
function uniqueMin<T>(entries: [Label, T][], measure: (t: T) => number) {
  const sorted = [...entries].sort((a, b) => measure(a[1]) - measure(b[1]));

  return measure(sorted[0][1]) < measure(sorted[1][1]) ? sorted[0][0] : null;
}

function uniqueMax<T>(entries: [Label, T][], measure: (t: T) => number) {
  return uniqueMin(entries, (t) => -measure(t));
}

/** Plays a seeded game to a mid-game position: mostly sensible placements, some careless ones. */
function position(seed: number): Game | null {
  const random = mulberry32(seed);
  const g = createGame(seed);
  const pieces = 10 + Math.floor(random() * 30);

  for (let i = 0; i < pieces; i++) {
    const options = landings(g).filter((l) => !l.features.topOut);

    if (!options.length) return null;
    const careless = random() < 0.3;

    const pick = careless
      ? options[Math.floor(random() * options.length)]
      : chooseLanding(options, random() < 0.5 ? "avoid_holes" : "keep_low");

    g.active = pick.pose;
    command(g, "drop");

    if (g.status !== "playing") return null;
  }

  return g;
}

const choice = (instructions: string): WireQuestion => ({
  type: "choice",
  instructions,
  criteria: { A: "Landing A", B: "Landing B", C: "Landing C" },
});

export function tetrisItem(seed: number): Item | null {
  const g = position(seed);

  if (!g) return null;
  const before = g.board.map((row) => [...row]);

  if (boardFeatures(before).height < 4) return null;
  const options = landings(g).filter((l) => !l.features.topOut);

  if (options.length < 5) return null;
  const random = mulberry32(seed ^ 0x9e3779b9);

  // Plausible candidates: the better half by holes then height, plus a few others.
  const ranked = [...options].sort(
    (a, b) =>
      a.features.holes - b.features.holes ||
      a.features.height - b.features.height ||
      a.features.bumpiness - b.features.bumpiness,
  );

  const pool = ranked.slice(0, Math.max(6, Math.ceil(ranked.length / 2)));

  // Most positions have no row to fill; when one does, usually offer it, so "fills a row" is a
  // real question rather than an almost-always no.
  const fillers = options.filter((l) => landingFacts(before, l).completes);
  const offerFiller = fillers.length > 0 && random() < 0.7;

  for (let attempt = 0; attempt < 60; attempt++) {
    const others = shuffled(pool, random);
    const filler = offerFiller ? fillers[Math.floor(random() * fillers.length)] : undefined;

    const [p0, p1, p2] = shuffled(
      filler
        ? [filler, ...others.filter((l) => l.id !== filler.id).slice(0, 2)]
        : others.slice(0, 3),
      random,
    );

    if (!p0 || !p1 || !p2) return null;

    const trio: [Label, Landing][] = [
      ["A", p0],
      ["B", p1],
      ["C", p2],
    ];

    const facts = trio.map(([label, l]): [Label, ReturnType<typeof landingFacts>] => [
      label,
      landingFacts(before, l),
    ]);

    const fewestHoles = uniqueMin(facts, (f) => f.holes);
    const lowest = uniqueMin(facts, (f) => f.height);

    if (!fewestHoles || !lowest) continue;
    const mostLines = uniqueMax(facts, (f) => f.lines);
    const anyLines = facts.some(([, f]) => f.lines > 0);

    const questions: Item["questions"] = {
      fewest_holes: choice(
        "After the piece lands and full rows disappear, which landing leaves the fewest buried empty cells (an empty cell with a filled cell anywhere above it in the same column)?",
      ),
      lowest_stack: choice(
        "After the piece lands and full rows disappear, which landing leaves the lowest highest column?",
      ),
    };

    const truth: Item["truth"] = { fewest_holes: fewestHoles, lowest_stack: lowest };

    for (const [label, f] of facts) {
      questions[`completes_${label}`] = {
        type: "noul",
        instructions: `Landing ${label} fills at least one row completely.`,
      };
      truth[`completes_${label}`] = f.completes;
    }

    if (anyLines && mostLines) {
      questions.most_lines = choice("Which landing clears the most full rows?");
      truth.most_lines = mostLines;
    }

    const holes = facts.map(([, f]) => f.holes).sort((a, b) => a - b);
    const heights = facts.map(([, f]) => f.height).sort((a, b) => a - b);
    const gap = Math.min(holes[1] - holes[0], heights[1] - heights[0]);
    const difficulty = gap <= 1 ? 2 : gap <= 2 ? 1 : 0;

    const top = Math.max(
      0,
      Math.min(
        before.findIndex((row) => row.some((v) => v !== 0)),
        ...trio.flatMap(([, l]) => cells(l.pose).map(([, y]) => y)),
      ) - 1,
    );

    const landed = Object.fromEntries(
      trio.map(([label, l]) => [
        label,
        rowsOf(before, top, new Set(cells(l.pose).map(([x, y]) => `${x},${y}`))),
      ]),
    );

    return {
      id: `tetris-${seed}`,
      kind: "tetris",
      seed,
      difficulty,
      state: {
        task: TASK,
        piece: g.active.type,
        rowsShown: `${ROWS - top} of ${ROWS}`,
        board: rowsOf(before, top),
        landings: landed,
      },
      questions,
      truth,
    };
  }

  return null;
}
