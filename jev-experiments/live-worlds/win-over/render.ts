/**
 * Draws Bramble Square in the Toy Box style: ink outlines, flat colour, offset shadows. Over each
 * resident: a five-step mood bar and a glyph for what they just decided.
 */
import { BOARD, EARSHOT, PLACES, VIEW, goal, place, type World } from "./engine";

const INK = "#17140f";
const CREAM = "#fff4e0";
const MOOD = ["#c43a17", "#f0532d", "#e8dcc4", "#9be3c3", "#3fbf86"];

export function hitResident(w: World, x: number, y: number) {
  let best: { id: string; d: number } | null = null;

  for (const r of w.residents) {
    const d = Math.hypot(r.x - x, r.y - y);

    if (d < 18 && (!best || d < best.d)) best = { id: r.id, d };
  }

  return best?.id ?? null;
}

/** What part of the square is on screen: the whole of it, or a zoomed window that follows you. */
export type Camera = { zoom: number; x: number; y: number };

/** On small screens, zoom in around the newcomer, without showing past the edges. */
export function camera(w: World, zoom: number): Camera {
  const half = { x: VIEW.width / zoom / 2, y: VIEW.height / zoom / 2 };

  return {
    zoom,
    x: Math.max(half.x, Math.min(VIEW.width - half.x, w.player.x)) - half.x,
    y: Math.max(half.y, Math.min(VIEW.height - half.y, w.player.y)) - half.y,
  };
}

/** A point on the canvas (in view units) back to a point in the square. */
export const toWorld = (c: Camera, x: number, y: number) => ({ x: c.x + x / c.zoom, y: c.y + y / c.zoom });

export function paint(ctx: CanvasRenderingContext2D, w: World, selected: string | null, cam: Camera = { zoom: 1, x: 0, y: 0 }) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, VIEW.width, VIEW.height);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);

  // Dotted paving.
  ctx.fillStyle = "#ead9b8";

  for (let x = 20; x < VIEW.width; x += 30) for (let y = 20; y < VIEW.height; y += 30) ctx.fillRect(x, y, 3, 3);

  const sticker = (x: number, y: number, ww: number, hh: number, fill: string, r = 14) => {
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.roundRect(x + 5, y + 5, ww, hh, r);
    ctx.fill();
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, ww, hh, r);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
  };

  const ev = w.goal ? goal(w.goal).place : null;

  for (const p of PLACES) sticker(p.x - 64, p.y - 40, 128, 62, p.color);

  // Names go on top of the residents standing in front of them.
  const names = () => {
    ctx.textAlign = "center";

    for (const p of PLACES) {
      ctx.font = "800 14px 'Bricolage Grotesque', system-ui, sans-serif";
      ctx.lineWidth = 4;
      ctx.strokeStyle = p.color;
      ctx.strokeText(p.name, p.x, p.y - 10);
      ctx.fillStyle = INK;
      ctx.fillText(p.name, p.x, p.y - 10);

      if (p.id === ev) {
        ctx.font = "800 11px Nunito, system-ui, sans-serif";
        ctx.strokeText("your event, 5 pm", p.x, p.y + 6);
        ctx.fillText("your event, 5 pm", p.x, p.y + 6);
      }
    }
  };

  // The notice board.
  sticker(BOARD.x - 22, BOARD.y - 18, 44, 30, "#fff", 6);

  if (w.notice) {
    ctx.fillStyle = "#ffd23f";
    ctx.fillRect(BOARD.x - 12, BOARD.y - 12, 24, 18);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(BOARD.x - 12, BOARD.y - 12, 24, 18);
  }

  ctx.fillStyle = INK;
  ctx.font = "700 10px Nunito, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("notice board", BOARD.x, BOARD.y + 26);

  // Earshot.
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "#17140f88";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(w.player.x, w.player.y, EARSHOT, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Gossip on its way from teller to listener.
  for (const b of w.bubbles) {
    const from = w.residents.find((r) => r.id === b.from);
    const to = w.residents.find((r) => r.id === b.to);

    if (!from || !to) continue;

    const k = Math.min(1, Math.max(0, 1 - (b.until - w.t) / 1.6));
    const x = from.x + (to.x - from.x) * k;
    const y = from.y + (to.y - from.y) * k - 26 - Math.sin(k * Math.PI) * 14;

    sticker(x - 13, y - 9, 26, 18, b.tone === "warm" ? "#9be3c3" : "#f0532d", 9);
    ctx.fillStyle = INK;
    ctx.font = "800 12px Nunito, system-ui, sans-serif";
    ctx.fillText("…", x, y + 4);
  }

  for (const r of w.residents) {
    if (r.id === selected) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(r.x + 2, r.y + 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK;
    ctx.stroke();

    // Mood: a bar that fills (and changes colour) from hostile to fond.
    ctx.fillStyle = "#fff";
    ctx.fillRect(r.x - 12, r.y - 21, 24, 6);
    ctx.fillStyle = MOOD[r.mood];
    ctx.fillRect(r.x - 12, r.y - 21, (24 * (r.mood + 1)) / 5, 6);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = INK;
    ctx.strokeRect(r.x - 12, r.y - 21, 24, 6);

    if (r.glyph || r.busy) {
      ctx.fillStyle = r.glyph === "!" || r.glyph === "♥" ? "#c43a17" : INK;
      ctx.font = "900 17px 'Bricolage Grotesque', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(r.busy ? "…" : r.glyph, r.x, r.y - 26);
    }

    if (r.rumour) {
      ctx.fillStyle = r.rumour.tone === "warm" ? "#3fbf86" : "#c43a17";
      ctx.beginPath();
      ctx.arc(r.x + 9, r.y - 7, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  names();

  // The newcomer: a sun-yellow block with a face.
  const { x, y } = w.player;

  sticker(x - 13, y - 13, 26, 26, "#ffd23f", 9);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(x - 5, y - 2, 2.4, 0, Math.PI * 2);
  ctx.arc(x + 5, y - 2, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y + 2, 5, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.font = "800 11px Nunito, system-ui, sans-serif";
  ctx.fillText("you", x, y + 27);

  if (ev && w.t >= w.length * 0.8) {
    const p = place(ev);

    ctx.font = "800 12px Nunito, system-ui, sans-serif";
    ctx.fillText("starting soon", p.x, p.y + 38);
  }
}
