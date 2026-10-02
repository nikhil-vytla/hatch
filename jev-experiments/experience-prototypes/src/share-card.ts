/**
 * Draws a Toy Box share card (1200×630 PNG) in the browser with a plain canvas: a ring for the
 * headline share, the headline number, one verdict sentence and the site URL. No dependencies.
 */
export type ShareCard = { title: string; big: string; ring: number | null; sentence: string; url: string };

const W = 1200;
const H = 630;
const INK = "#17140f";
const CREAM = "#fff4e0";
const SOFT = "#fbe9c9";
const TOMATO = "#f0532d";
const SUN = "#ffd23f";
const MINT = "#9be3c3";
const DISPLAY = '"Bricolage Grotesque", system-ui, sans-serif';
const BODY = "Nunito, system-ui, sans-serif";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Words wrapped to `width`, at most `lines` lines (the last one ellipsised). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number) {
  const out: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;

    if (ctx.measureText(next).width <= width || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }

  if (line) out.push(line);

  if (out.length > lines) {
    const kept = out.slice(0, lines);

    kept[lines - 1] = `${kept[lines - 1].replace(/[\s.,;:]+$/, "")}…`;

    return kept;
  }

  return out;
}

/** The largest font size from `max` down to `min` at which `text` fits in `width`. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, max: number, width: number, min = 18) {
  for (let size = max; size > min; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;

    if (ctx.measureText(text).width <= width) return size;
  }

  return min;
}

function face(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  roundRect(ctx, x, y, s, s, s * 0.3);
  ctx.fillStyle = TOMATO;
  ctx.fill();
  ctx.lineWidth = s * 0.07;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = INK;

  for (const ex of [0.37, 0.64]) {
    ctx.beginPath();
    ctx.arc(x + s * ex, y + s * 0.46, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(x + s * 0.34, y + s * 0.66);
  ctx.quadraticCurveTo(x + s * 0.5, y + s * 0.78, x + s * 0.66, y + s * 0.66);
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = "round";
  ctx.stroke();
}

export async function renderShareCard(card: ShareCard): Promise<Blob> {
  await Promise.all([document.fonts.load(`800 96px ${DISPLAY}`), document.fonts.load(`700 40px ${BODY}`)]).catch(() => undefined);

  const canvas = document.createElement("canvas");

  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext("2d");

  if (!ctx) throw new Error("This browser can't draw the card.");

  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, W, H);

  // The sticker: an ink shadow, then the white card with a thick outline.
  roundRect(ctx, 64, 64, W - 128, H - 128, 44);
  ctx.fillStyle = INK;
  ctx.translate(14, 14);
  ctx.fill();
  ctx.translate(-14, -14);
  roundRect(ctx, 64, 64, W - 128, H - 128, 44);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = INK;
  ctx.stroke();

  // The ring, or a plain sun sticker when there is no share to show.
  const cx = 290;
  const cy = 300;
  const r = 140;

  ctx.lineWidth = 40;
  ctx.lineCap = "round";
  ctx.strokeStyle = SOFT;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  if (card.ring !== null) {
    const share = Math.max(0, Math.min(1, card.ring));

    ctx.strokeStyle = TOMATO;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2);
    ctx.stroke();
  }

  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;

  for (const rr of [r + 23, r - 23]) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r - 26, 0, Math.PI * 2);
  ctx.fillStyle = card.ring === null ? SUN : MINT;
  ctx.fill();

  // The ring's share in the middle, unless the headline already says it; then the face.
  const inner = card.ring === null ? null : `${Math.round(card.ring * 100)}%`;

  if (inner && !card.big.includes(inner)) {
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${fit(ctx, inner, "800", DISPLAY, 72, 180)}px ${DISPLAY}`;
    ctx.fillText(inner, cx, cy + 4);
  } else face(ctx, cx - 60, cy - 60, 120);

  // The words.
  const left = 500;
  const width = W - left - 110;

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#4a443a";
  ctx.font = `700 30px ${BODY}`;
  ctx.fillText(card.title, left, 168);
  ctx.fillStyle = INK;
  ctx.font = `800 ${fit(ctx, card.big, "800", DISPLAY, 100, width)}px ${DISPLAY}`;
  ctx.fillText(card.big, left, 268);
  ctx.font = `700 36px ${BODY}`;

  wrap(ctx, card.sentence, width, 3).forEach((line, i) => ctx.fillText(line, left, 340 + i * 48));

  face(ctx, left, 470, 48);
  ctx.fillStyle = "#4a443a";

  const url = card.url.replace(/^https?:\/\//, "");

  ctx.font = `700 ${fit(ctx, url, "700", BODY, 28, width - 66)}px ${BODY}`;
  ctx.fillText(url, left + 66, 504);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The card could not be drawn."))), "image/png"));
}
