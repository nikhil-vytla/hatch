/**
 * How each scene asks Jev, as a tiny schematic for the collection cards: what goes in, and the
 * typed answer that comes out. Monochrome ink with one accent for the answer.
 */
export type Diagram = { from: string[]; to: string };

export const DIAGRAMS: Record<string, Diagram> = {
  paste: { from: ["copied page", "form"], to: "fact per field" },
  ui: { from: ["request"], to: "layout choices" },
  games: { from: ["what it sees"], to: "next move" },
  music: { from: ["motif"], to: "arrangement" },
  "semantic-table": { from: ["each row"], to: "yes/no per column" },
  beverage: { from: ["craving"], to: "next question" },
  verify: { from: ["claim", "trace"], to: "supported?" },
  search: { from: ["query", "sources"], to: "which answers" },
  classify: { from: ["request"], to: "1 of 77 intents" },
  handoff: { from: ["answer", "confidence"], to: "act or ask" },
  "open-decisions": { from: ["prompt"], to: "label odds" },
  decoy: { from: ["A", "B", "A′"], to: "choice" },
  prose: { from: ["question", "78 rewordings"], to: "yes/no shift" },
  judge: { from: ["answer A", "answer B"], to: "which is better" },
  rewardbench2: { from: ["prompt", "answer"], to: "preferred?" },
  snake: { from: ["board"], to: "next move" },
  "local-models": { from: ["state"], to: "typed answers" },
  "answer-key": { from: ["5 models' answers"], to: "whose key?" },
  tetris: { from: ["board"], to: "landing" },
  "drawing-framing": { from: ["canvas"], to: "pixel or shape" },
  "visual-search": { from: ["query", "artwork"], to: "relevance" },
  wardrobe: { from: ["spoken edit"], to: "outfit" },
  "icon-studio": { from: ["idea"], to: "1 of 1,703 icons" },
  "rumour-mill": { from: ["rumour", "resident"], to: "share or argue" },
  "win-over": { from: ["your line", "listener"], to: "intent · mood · move" },
  ocean: { from: ["fish's view"], to: "next move" },
  "who-said-that": { from: ["a line", "lines before"], to: "continues · replies" },
  "ghost-brush": { from: ["gesture", "feeling"], to: "brush style" },
  "screen-sentry": { from: ["page block"], to: "hijack risk" },
};

/** The diagram as words, for screen readers and search. */
export const diagramText = (d: Diagram) => `Asks Jev: ${d.from.join(", ")} → ${d.to}`;

const CHAR = 6.4;
const PAD = 8;
const H = 22;
const GAP = 5;
const ARROW = 20;

const width = (s: string) => Math.ceil(s.length * CHAR) + PAD * 2;

export function SceneDiagram({ id }: { id: string }) {
  const d = DIAGRAMS[id];

  if (!d) return null;

  let x = 1;

  const boxes = d.from.map((label) => {
    const w = width(label);
    const box = { label, x, w };

    x += w + GAP;

    return box;
  });

  const arrowAt = x - GAP + 4;

  x = arrowAt + ARROW + 4;

  const answer = { label: d.to, x, w: width(d.to) };
  const total = answer.x + answer.w + 2;

  return (
    <svg className="scene-diagram" viewBox={`0 0 ${total} ${H + 2}`} width={total} height={H + 2} aria-hidden="true">
      {boxes.map((b) => (
        <g key={b.label}>
          <rect x={b.x} y={1} width={b.w} height={H} rx={7} className="scene-diagram-in" />
          <text x={b.x + b.w / 2} y={1 + H / 2}>
            {b.label}
          </text>
        </g>
      ))}
      <path d={`M${arrowAt} ${1 + H / 2}h${ARROW}m-6 -4l6 4l-6 4`} className="scene-diagram-arrow" />
      <rect x={answer.x} y={1} width={answer.w} height={H} rx={7} className="scene-diagram-out" />
      <text x={answer.x + answer.w / 2} y={1 + H / 2}>
        {answer.label}
      </text>
    </svg>
  );
}
