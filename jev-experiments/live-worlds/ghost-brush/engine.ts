/** Original procedural mark construction. No external brush implementation is used. */
export const ENGINE_VERSION = "ghost-brush/1.0.0";
export const WIDTH = 1000, HEIGHT = 640;
export type Family = "woven" | "wind" | "branch" | "grain" | "geometry";
export type Recipe = { id: string; name: string; family: Family; description: string; tags: string[]; ink: string; accent: string; width: number; density: number; energy: number };
export const RECIPES: readonly Recipe[] = [
  { id: "indigo-loom", name: "Indigo loom", family: "woven", description: "Fine blue threads cross over one another in a controlled woven ribbon. Regular, tactile and quiet.", tags: ["woven", "weave", "fabric", "thread", "textile", "quiet", "blue", "indigo", "order"], ink: "#3449a1", accent: "#d16a46", width: 15, density: 5, energy: .35 },
  { id: "copper-mesh", name: "Copper mesh", family: "woven", description: "Wide warm copper strands form a loose net, with uneven crossings and open space. Rough, airy and handmade.", tags: ["woven", "mesh", "net", "copper", "warm", "loose", "rough", "handmade", "airy"], ink: "#a24c28", accent: "#d78b45", width: 29, density: 7, energy: .8 },
  { id: "coastal-wind", name: "Coastal wind", family: "wind", description: "Long sea-green hairlines bend to one side of the stroke. Windblown, fluid, light and flowing.", tags: ["wind", "windblown", "sea", "coast", "flow", "fluid", "green", "light", "hair", "breeze"], ink: "#1b777c", accent: "#78b8a6", width: 23, density: 3, energy: .7 },
  { id: "ember-drift", name: "Ember drift", family: "wind", description: "Short rust-orange filaments flick outward with sharp gusts. Restless, warm, fiery and energetic.", tags: ["wind", "gust", "fire", "ember", "orange", "restless", "warm", "energy", "sharp"], ink: "#bb4a29", accent: "#e79b3c", width: 34, density: 4, energy: 1 },
  { id: "fern-script", name: "Fern script", family: "branch", description: "A slender dark green stem sprouts paired small branches and smaller offshoots. Botanical, delicate and orderly.", tags: ["branch", "fern", "plant", "botanical", "nature", "leaf", "green", "delicate", "organic"], ink: "#326449", accent: "#82a25c", width: 23, density: 3, energy: .35 },
  { id: "coral-nerve", name: "Coral nerve", family: "branch", description: "Asymmetric violet branches fork into restless coral-like tips. Organic, strange, tangled and lively.", tags: ["branch", "coral", "nerve", "purple", "violet", "strange", "tangle", "wild", "organic"], ink: "#815198", accent: "#c16e8c", width: 38, density: 4, energy: .9 },
  { id: "graphite-dust", name: "Graphite dust", family: "grain", description: "Small dark angular grains collect around a narrow path. Dry, soft-edged, granular and understated.", tags: ["grain", "dust", "graphite", "pencil", "dry", "black", "charcoal", "soft", "quiet"], ink: "#383f46", accent: "#7e858c", width: 18, density: 8, energy: .35 },
  { id: "pollen-cloud", name: "Pollen cloud", family: "grain", description: "Scattered golden flecks float in a wide irregular cloud. Sunny, speckled, buoyant and soft.", tags: ["grain", "pollen", "cloud", "gold", "yellow", "sun", "speckle", "float", "soft", "dust"], ink: "#b48821", accent: "#dba947", width: 35, density: 10, energy: .85 },
  { id: "prism-fold", name: "Prism fold", family: "geometry", description: "Outlined blue angular facets fold along the stroke with a precise central spine. Architectural, crystalline and spare.", tags: ["geometry", "geometric", "prism", "fold", "crystal", "architecture", "angular", "precise", "blue"], ink: "#3856a0", accent: "#848ccc", width: 25, density: 3, energy: .3 },
  { id: "rose-kite", name: "Rose kite", family: "geometry", description: "Broad pink diamond facets alternate across the path, like a string of paper kites. Playful, bold and geometric.", tags: ["geometry", "geometric", "kite", "paper", "pink", "rose", "diamond", "playful", "bold"], ink: "#b4506c", accent: "#e4a18b", width: 38, density: 4, energy: .75 },
];
export function recipe(id: string): Recipe { const result = RECIPES.find(r => r.id === id); if (!result) throw new Error(`Unknown recipe: ${id}`); return result; }
export type Point = { x: number; y: number; pressure: number };
export type Stroke = { id: number; seed: number; recipeId: string; points: Point[] };
export type Mark = { d: string; stroke: string; fill: string; width: number; opacity: number };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const n = (v: number) => Number(v.toFixed(2));
const xy = (x: number, y: number) => `${n(x)} ${n(y)}`;
export function point(x: number, y: number, pressure = .5): Point {
  if (![x, y, pressure].every(Number.isFinite)) throw new Error("A point must be finite.");
  return { x: clamp(x, 0, WIDTH), y: clamp(y, 0, HEIGHT), pressure: clamp(pressure || .5, .1, 1) };
}
export function randomAt(seed: number, index: number) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b); value ^= value >>> 13;
  return (value >>> 0) / 4294967296;
}
/** Resampling makes texture density independent of pointer-event frequency. */
export function resample(points: Point[], step = 5): Point[] {
  if (!points.length) return [];
  const out = [{ ...points[0] }]; let remaining = step;
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1]; const b = points[i]; let distance = Math.hypot(b.x - a.x, b.y - a.y);
    while (distance >= remaining && distance > 0) {
      const t = remaining / distance;
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t };
      out.push(a); distance = Math.hypot(b.x - a.x, b.y - a.y); remaining = step;
    }
    remaining -= distance;
  }
  return out;
}
export function marks(stroke: Stroke, overrideId = stroke.recipeId): Mark[] {
  const r = recipe(overrideId), ps = resample(stroke.points), result: Mark[] = [];
  const add = (d: string, color = r.ink, width = 1, opacity = .7, fill = "none") => result.push({ d, stroke: color, fill, width, opacity });
  if (!ps.length) return result;
  if (ps.length === 1) { const p = ps[0]; add(`M${xy(p.x - 1, p.y - 1)}l2 2`, r.ink, 2, .8); return result; }
  if (r.family === "woven") {
    for (let strand = 0; strand < r.density; strand++) {
      let d = "";
      ps.forEach((p, i) => {
        const prev = ps[Math.max(0, i - 1)], next = ps[Math.min(ps.length - 1, i + 1)], angle = Math.atan2(next.y - prev.y, next.x - prev.x) + Math.PI / 2;
        const offset = ((strand / (r.density - 1)) - .5) * r.width * (p.pressure + .45) + Math.sin(i * .75 + strand * 1.8) * r.energy * 5;
        d += `${i ? "L" : "M"}${xy(p.x + Math.cos(angle) * offset, p.y + Math.sin(angle) * offset)}`;
      }); add(d, strand % 3 ? r.ink : r.accent, .85, .72);
    }
    for (let i = 2; i < ps.length; i += 3) { const a = ps[i - 1], p = ps[i], angle = Math.atan2(p.y - a.y, p.x - a.x) + Math.PI / 2, w = r.width * .5; add(`M${xy(p.x - Math.cos(angle) * w, p.y - Math.sin(angle) * w)}L${xy(p.x + Math.cos(angle) * w, p.y + Math.sin(angle) * w)}`, r.ink, .55, .32); }
  } else if (r.family === "wind") {
    for (let i = 1; i < ps.length; i += 2) {
      const p = ps[i], a = ps[i - 1], angle = Math.atan2(p.y - a.y, p.x - a.x);
      for (let j = 0; j < r.density; j++) {
        const length = r.width * (.6 + randomAt(stroke.seed, i * 13 + j) * 1.4) * (p.pressure + .6), side = j % 2 ? -.25 : 1;
        const dx = Math.cos(angle + .85 * side) * length, dy = Math.sin(angle + .85 * side) * length;
        add(`M${xy(p.x, p.y)}Q${xy(p.x + dx * .4 - Math.sin(angle) * 9 * r.energy, p.y + dy * .4 + Math.cos(angle) * 9 * r.energy)} ${xy(p.x + dx, p.y + dy)}`, j % 3 ? r.ink : r.accent, .65, .25 + j * .14);
      }
    }
  } else if (r.family === "branch") {
    add(ps.map((p, i) => `${i ? "L" : "M"}${xy(p.x, p.y)}`).join(""), r.ink, 1.2, .75);
    for (let i = 2; i < ps.length; i += 3) {
      const p = ps[i], a = ps[i - 1], angle = Math.atan2(p.y - a.y, p.x - a.x);
      for (const side of [-1, 1]) {
        const length = r.width * (.6 + randomAt(stroke.seed, i * 7 + side + 1) * r.energy) * (p.pressure + .4), theta = angle + side * 1.05;
        const end = { x: p.x + Math.cos(theta) * length, y: p.y + Math.sin(theta) * length };
        add(`M${xy(p.x, p.y)}Q${xy(p.x + Math.cos(angle) * length * .2, p.y + Math.sin(angle) * length * .2)} ${xy(end.x, end.y)}`, r.ink, .8, .68);
        for (let k = 1; k <= 2; k++) {
          const t = k / 3, bx = p.x + (end.x - p.x) * t, by = p.y + (end.y - p.y) * t, fork = theta + side * .65;
          add(`M${xy(bx, by)}L${xy(bx + Math.cos(fork) * length * .36, by + Math.sin(fork) * length * .36)}`, r.accent, .7, .7);
        }
      }
    }
  } else if (r.family === "grain") {
    for (let i = 0; i < ps.length; i += 2) for (let j = 0; j < r.density; j++) {
      const p = ps[i], k = i * 101 + j * 4, theta = randomAt(stroke.seed, k) * Math.PI * 2, radius = Math.sqrt(randomAt(stroke.seed, k + 1)) * r.width * (p.pressure + .3);
      const x = p.x + Math.cos(theta) * radius, y = p.y + Math.sin(theta) * radius, size = .6 + randomAt(stroke.seed, k + 2) * 2;
      add(`M${xy(x - size, y)}l${xy(size, -size)} ${xy(size, size * 1.6)}Z`, j % 3 ? r.ink : r.accent, .1, .18 + randomAt(stroke.seed, k + 3) * .55, j % 3 ? r.ink : r.accent);
    }
  } else {
    for (let i = 3; i < ps.length; i += 4) {
      const p = ps[i], a = ps[i - 3], angle = Math.atan2(p.y - a.y, p.x - a.x) + Math.PI / 2, width = r.width * (.5 + p.pressure * .5), side = i % 8 === 3 ? 1 : -1;
      const bx = p.x + Math.cos(angle) * width * side, by = p.y + Math.sin(angle) * width * side;
      add(`M${xy(a.x, a.y)}L${xy(bx, by)}L${xy(p.x + (p.x - a.x) * .8, p.y + (p.y - a.y) * .8)}L${xy(p.x - Math.cos(angle) * width * .35 * side, p.y - Math.sin(angle) * width * .35 * side)}Z`, r.ink, .9, .6, r.energy > .5 ? r.accent : "none");
    }
  }
  return result;
}
export function sampleStroke(id = 0, recipeId = "indigo-loom"): Stroke {
  return { id, seed: 1943, recipeId, points: Array.from({ length: 82 }, (_, i) => { const t = i / 81; return point(135 + t * 730, 320 + Math.sin(t * Math.PI * 2.2) * 112 + Math.cos(t * Math.PI * 4) * 32, .5 + Math.sin(t * Math.PI) * .25); }) };
}
export function fitStroke(stroke: Stroke): Stroke {
  if (!stroke.points.length) return stroke;
  const xs = stroke.points.map(p => p.x), ys = stroke.points.map(p => p.y), left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top, scale = Math.min(730 / Math.max(width, 1), 310 / Math.max(height, 1), 3);
  return { ...stroke, points: stroke.points.map(p => ({ ...p, x: (p.x - left - width / 2) * scale + WIDTH / 2, y: (p.y - top - height / 2) * scale + HEIGHT / 2 })) };
}
export const escapeXml = (s: string) => s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
export function exportSvg(strokes: Stroke[], title: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}"><title>${escapeXml(title)}</title><rect width="100%" height="100%" fill="#fbf8f0"/>${strokes.flatMap(s => marks(s)).map(m => `<path d="${m.d}" stroke="${m.stroke}" fill="${m.fill}" stroke-width="${m.width}" opacity="${m.opacity}" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}</svg>`;
}
