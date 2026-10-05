/**
 * How each scene asks Jev, as a tiny schematic for the collection cards: what goes in, and the
 * typed answer that comes out. Monochrome ink with one accent for the answer.
 */
import type { Diagram } from "./scenes";

/** The diagram as words, for screen readers and search. */
export const diagramText = (d: Diagram) => `Asks Jev: ${d.from.join(", ")} → ${d.to}`;

const CHAR = 6.4;
const PAD = 8;
const H = 22;
const GAP = 5;
const ARROW = 20;

const width = (s: string) => Math.ceil(s.length * CHAR) + PAD * 2;

export function SceneDiagram({ d }: { d: Diagram }) {
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
