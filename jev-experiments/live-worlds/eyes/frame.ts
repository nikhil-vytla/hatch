/**
 * Draws a Snake board to a PNG, the way the pixels lane sees it: the same palette and layout
 * the page paints. Pure TypeScript (zlib + CRC32), so the recorder and its tests need no canvas.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { State } from "../../local-models-and-games/arcade/engine";
import { PALETTE } from "./model";

export const CELL = 32;
export const SIZE = CELL * 10;

const CRC = (() => {
  const t = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

    t[n] = c >>> 0;
  }

  return t;
})();

function crc32(buf: Uint8Array) {
  let c = 0xffffffff;

  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));

  return out;
}

/** RGB pixels for the board. */
export function pixels(s: State): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 3);
  const put = (x: number, y: number, c: readonly number[]) => {
    const i = (y * SIZE + x) * 3;

    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };

  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) put(x, y, x % CELL === 0 || y % CELL === 0 ? PALETTE.grid : PALETTE.floor);

  const square = (cx: number, cy: number, c: readonly number[]) => {
    for (let y = cy * CELL + 2; y < (cy + 1) * CELL - 2; y++)
      for (let x = cx * CELL + 2; x < (cx + 1) * CELL - 2; x++) put(x, y, c);
  };

  for (const p of s.snake!.slice(1)) square(p.x, p.y, PALETTE.body);

  square(s.snake![0].x, s.snake![0].y, PALETTE.head);

  const fx = (s.food!.x + 0.5) * CELL;
  const fy = (s.food!.y + 0.5) * CELL;
  const r = CELL * 0.38;

  for (let y = Math.floor(fy - r); y <= fy + r; y++)
    for (let x = Math.floor(fx - r); x <= fx + r; x++) if ((x - fx) ** 2 + (y - fy) ** 2 <= r * r) put(x, y, PALETTE.food);

  return px;
}

/** The board as a PNG, and the SHA-256 of those bytes. */
export function png(s: State) {
  const px = pixels(s);
  const raw = new Uint8Array(SIZE * (SIZE * 3 + 1));

  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 3 + 1)] = 0;
    raw.set(px.subarray(y * SIZE * 3, (y + 1) * SIZE * 3), y * (SIZE * 3 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);

  v.setUint32(0, SIZE);
  v.setUint32(4, SIZE);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;

  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }

  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
