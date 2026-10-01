/**
 * Draws the reef on a canvas in the site's Toy Box style: flat colour, thick ink outlines,
 * friendly shapes. Glyphs over fish show what each one decided; the latency lens greys out
 * fish acting on a decision older than STALE_AFTER.
 */
import { eventActive, netX, SAND, STALE_AFTER, WIDTH, HEIGHT, type Action, type Fish, type World } from "./engine";

export const VIEW = { width: WIDTH, height: HEIGHT };

const INK = "#17140f";
const CORAL_COLOURS = ["#f0532d", "#ff8fab", "#ffd23f", "#c084fc", "#ff9f43"];

export type PaintOptions = { lens: boolean; selected: number | null; reduced: boolean };

const GLYPH: Partial<Record<Action, string>> = { flee: "!", forage: "🍴", hide: "◆", follow: "→", signal: "))", rest: "z" };

function water(ctx: CanvasRenderingContext2D, w: World) {
  const heat = eventActive(w, "heatwave");
  const g = ctx.createLinearGradient(0, 0, 0, SAND);

  g.addColorStop(0, heat ? "#bfe3e0" : "#a9e4ff");
  g.addColorStop(0.55, heat ? "#5fb3b3" : "#4aa8e8");
  g.addColorStop(1, heat ? "#2f7f86" : "#1f5fbf");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Light rays.
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = "#ffffff";

  for (let i = 0; i < 6; i++) {
    const x = ((i * 190 + w.time * 6) % (WIDTH + 200)) - 100;

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 60, 0);
    ctx.lineTo(x + 160, SAND);
    ctx.lineTo(x + 70, SAND);
    ctx.fill();
  }

  ctx.restore();

  if (heat) {
    ctx.fillStyle = "rgba(255, 140, 60, 0.14)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function sand(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#ffe08a";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, HEIGHT);
  ctx.lineTo(0, SAND);

  for (let x = 0; x <= WIDTH; x += 60) ctx.quadraticCurveTo(x + 30, SAND - 12, x + 60, SAND);

  ctx.lineTo(WIDTH, HEIGHT);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function kelp(ctx: CanvasRenderingContext2D, w: World, reduced: boolean) {
  ctx.lineCap = "round";

  for (let i = 0; i < 7; i++) {
    const x = 40 + i * 140;
    const sway = reduced ? 0 : Math.sin(w.time * 0.8 + i) * 12;

    ctx.strokeStyle = INK;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(x, SAND);
    ctx.quadraticCurveTo(x + sway, SAND - 90, x + sway * 1.5, SAND - 170);
    ctx.stroke();
    ctx.strokeStyle = "#5cc98f";
    ctx.lineWidth = 5;
    ctx.stroke();
  }
}

function coral(ctx: CanvasRenderingContext2D, w: World) {
  for (const c of w.coral) {
    const bleached = c.health < 0.35;
    const fill = bleached ? "#f6f1e7" : CORAL_COLOURS[Math.floor(c.hue * CORAL_COLOURS.length)];

    ctx.fillStyle = fill;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;

    // A cluster of round branches.
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k - 2) * 0.45;
      const len = c.r * (0.7 + 0.25 * Math.sin(k * 7.3 + c.id));
      const bx = c.x + Math.cos(a) * len * 0.6;
      const by = c.y + Math.sin(a) * len;

      ctx.beginPath();
      ctx.moveTo(c.x, c.y + 6);
      ctx.lineTo(bx, by);
      ctx.lineWidth = 13;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.lineWidth = 8;
      ctx.strokeStyle = fill;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }

    // Health bar for coral under stress.
    if (c.health < 0.95) {
      ctx.fillStyle = INK;
      ctx.fillRect(c.x - 20, c.y + 14, 40, 6);
      ctx.fillStyle = bleached ? "#f6f1e7" : "#9be3c3";
      ctx.fillRect(c.x - 19, c.y + 15, 38 * c.health, 4);
    }
  }
}

function fishShape(ctx: CanvasRenderingContext2D, f: Fish, fill: string, size: number) {
  const angle = Math.atan2(f.vy, f.vx);

  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(angle);
  ctx.fillStyle = fill;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-size * 0.9, 0);
  ctx.lineTo(-size * 1.6, -size * 0.6);
  ctx.lineTo(-size * 1.6, size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 0, size, size * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(size * 0.45, -size * 0.12, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function glyph(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string) {
  ctx.font = "800 10px Nunito, system-ui, sans-serif";

  const tw = ctx.measureText(text).width + 8;

  ctx.fillStyle = bg;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x - tw / 2, y - 16, tw, 13, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.fillText(text, x, y - 6);
}

export function paint(ctx: CanvasRenderingContext2D, w: World, o: PaintOptions) {
  water(ctx, w);
  kelp(ctx, w, o.reduced);
  sand(ctx);
  coral(ctx, w);

  // Plankton.
  ctx.fillStyle = "#f4fff8";

  for (const p of w.food) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  const oil = eventActive(w, "oil");

  if (oil) {
    const r = 40 + (w.time - oil.start) * 9;

    ctx.fillStyle = "rgba(23, 20, 15, 0.45)";
    ctx.beginPath();
    ctx.ellipse(oil.x, 30, r, r / 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const t of w.turtles) {
    ctx.fillStyle = "#5cc98f";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(t.x, t.y, 20, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(t.x + (t.vx >= 0 ? 22 : -22), t.y - 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  for (const f of w.fish) {
    const stale = w.time - f.decidedAt > STALE_AFTER;
    const size = 6 + f.traits.speed * 2.5;

    if (!f.alive) {
      ctx.globalAlpha = Math.max(0, 1 - (w.time - (f.diedAt ?? 0)) / 4);
      fishShape(ctx, { ...f, vx: 1, vy: 0.001, y: f.y + (w.time - (f.diedAt ?? 0)) * 6 }, "#d6d0c4", size);
      ctx.globalAlpha = 1;
      continue;
    }

    const fill = o.lens && stale ? "#b9b4aa" : `hsl(${f.hue} 85% 62%)`;

    fishShape(ctx, f, fill, size);

    if (f.hidden) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, size + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    const g = GLYPH[f.action];

    if (g && (!o.lens || !stale) && (f.action === "flee" || f.action === "signal" || f.id === o.selected || w.fish.length < 120 || f.id % 3 === 0))
      glyph(ctx, f.x, f.y - size, g, f.action === "flee" ? "#ffd23f" : f.action === "signal" ? "#a9cdfc" : "#ffffff");

    if (f.id === o.selected) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(f.x, f.y, 70 + f.traits.sight * 90, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(f.x, f.y, size + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  for (const s of w.sharks) {
    if (!s.alive) continue;

    const angle = Math.atan2(s.vy, s.vx);

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(angle);
    ctx.fillStyle = "#8a9bb0";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.lineTo(-40, -12);
    ctx.lineTo(-40, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-4, -8);
    ctx.lineTo(4, -22);
    ctx.lineTo(10, -8);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, 28, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(16, -2, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const net = eventActive(w, "net");

  if (net) {
    const x = netX(w, net);

    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 6]);

    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(x + k * 8, 40);
      ctx.lineTo(x + k * 8, SAND - 60);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - 14, 40);
    ctx.lineTo(x + 14, 40);
    ctx.stroke();
  }

  if (eventActive(w, "storm") && !o.reduced) {
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 2;

    for (let i = 0; i < 40; i++) {
      const x = (i * 97 + w.time * 220) % WIDTH;
      const y = (i * 53 + w.time * 60) % SAND;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 18, y + 6);
      ctx.stroke();
    }
  }
}

/** The fish under a point, if any. */
export function hitFish(w: World, x: number, y: number) {
  let best: Fish | null = null;
  let bd = 18;

  for (const f of w.fish) {
    if (!f.alive) continue;

    const d = Math.hypot(f.x - x, f.y - y);

    if (d < bd) {
      bd = d;
      best = f;
    }
  }

  return best;
}
