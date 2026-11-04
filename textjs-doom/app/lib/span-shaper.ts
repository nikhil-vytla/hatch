export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

const LITTLE_ENDIAN = (() => {
  const probe = new Uint32Array(1);
  probe[0] = 0x01020304;
  return new Uint8Array(probe.buffer)[0] === 0x04;
})();

const R_SHIFT = LITTLE_ENDIAN ? 0 : 24;
const G_SHIFT = LITTLE_ENDIAN ? 8 : 16;
const B_SHIFT = LITTLE_ENDIAN ? 16 : 8;

function overlaps(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a.buffer === b.buffer &&
    a.byteOffset < b.byteOffset + b.byteLength &&
    b.byteOffset < a.byteOffset + a.byteLength
  );
}

function getU32View(data: Uint8Array, pixelCount: number): Uint32Array {
  const byteCount = pixelCount * 4;
  if ((data.byteOffset & 3) === 0 && data.length >= byteCount) {
    return new Uint32Array(data.buffer, data.byteOffset, pixelCount);
  }

  const copy = new Uint8Array(byteCount);
  const n = data.length < byteCount ? data.length : byteCount;
  copy.set(data.subarray(0, n));
  return new Uint32Array(copy.buffer);
}

function maxChannelDiff(a: number, b: number): number {
  let d = ((a >>> R_SHIFT) & 0xff) - ((b >>> R_SHIFT) & 0xff);
  if (d < 0) d = -d;

  let t = ((a >>> G_SHIFT) & 0xff) - ((b >>> G_SHIFT) & 0xff);
  if (t < 0) t = -t;
  if (t > d) d = t;

  t = ((a >>> B_SHIFT) & 0xff) - ((b >>> B_SHIFT) & 0xff);
  if (t < 0) t = -t;
  if (t > d) d = t;

  return d;
}

function sumChannelAbsDiff(a: number, b: number): number {
  let d = ((a >>> R_SHIFT) & 0xff) - ((b >>> R_SHIFT) & 0xff);
  if (d < 0) d = -d;
  let sum = d;

  d = ((a >>> G_SHIFT) & 0xff) - ((b >>> G_SHIFT) & 0xff);
  if (d < 0) d = -d;
  sum += d;

  d = ((a >>> B_SHIFT) & 0xff) - ((b >>> B_SHIFT) & 0xff);
  if (d < 0) d = -d;
  sum += d;

  return sum;
}

/** Count spans exactly as the renderer would (row start = new span, colour change = new span). */
export function countSpans(px: Pixels): number {
  const width = px.width;
  const height = px.height;
  const rows = height >> 1;

  if (width <= 0 || rows <= 0) return 0;

  const pixelCount = width * height;
  const u32 = getU32View(px.data, pixelCount);

  let spans = 0;

  for (let cy = 0; cy < rows; cy++) {
    const base = cy * 2 * width;

    let prevTop = u32[base];
    let prevBot = u32[base + width];
    spans++;

    for (let cx = 1; cx < width; cx++) {
      const topIdx = base + cx;
      const top = u32[topIdx];
      const bot = u32[topIdx + width];

      if (top !== prevTop || bot !== prevBot) {
        spans++;
        prevTop = top;
        prevBot = bot;
      }
    }
  }

  return spans;
}

/**
 * Lossy run merging with tolerance `tol` (0 = lossless, i.e. no change).
 * Writes into `out` (same size, allocate if null or size differs) — never modifies `src`.
 */
export function shapeSpans(
  src: Pixels,
  tol: number,
  out: Pixels | null
): { out: Pixels; spans: number; meanAbsError: number } {
  const width = src.width;
  const height = src.height;
  const pixelCount = width * height;
  const byteCount = pixelCount * 4;

  if (
    out !== null &&
    (out.width !== width ||
      out.height !== height ||
      out.data.length !== byteCount ||
      overlaps(out.data, src.data))
  ) {
    out = null;
  }

  if (out === null) {
    out = {
      width,
      height,
      data: new Uint8Array(byteCount),
    };
  }

  const srcU32 = getU32View(src.data, pixelCount);

  let outU32: Uint32Array;
  let outCopy: Uint8Array | null = null;

  if ((out.data.byteOffset & 3) === 0 && out.data.length >= byteCount) {
    outU32 = new Uint32Array(out.data.buffer, out.data.byteOffset, pixelCount);
  } else {
    outCopy = new Uint8Array(byteCount);
    outU32 = new Uint32Array(outCopy.buffer);
  }

  const rows = height >> 1;
  const t = tol < 0 ? 0 : tol;

  let spans = 0;
  let errorSum = 0;

  for (let cy = 0; cy < rows; cy++) {
    if (width === 0) continue;

    const base = cy * 2 * width;

    let topIdx = base;
    let botIdx = base + width;

    let anchorTop = srcU32[topIdx];
    let anchorBot = srcU32[botIdx];

    outU32[topIdx] = anchorTop;
    outU32[botIdx] = anchorBot;
    spans++;

    for (let cx = 1; cx < width; cx++) {
      topIdx = base + cx;
      botIdx = topIdx + width;

      const top = srcU32[topIdx];
      const bot = srcU32[botIdx];

      if (top === anchorTop && bot === anchorBot) {
        outU32[topIdx] = anchorTop;
        outU32[botIdx] = anchorBot;
        continue;
      }

      if (t > 0) {
        const topDiff = maxChannelDiff(top, anchorTop);
        const botDiff = maxChannelDiff(bot, anchorBot);

        if (topDiff <= t && botDiff <= t) {
          outU32[topIdx] = anchorTop;
          outU32[botIdx] = anchorBot;
          errorSum +=
            sumChannelAbsDiff(top, anchorTop) +
            sumChannelAbsDiff(bot, anchorBot);
          continue;
        }
      }

      anchorTop = top;
      anchorBot = bot;

      outU32[topIdx] = top;
      outU32[botIdx] = bot;
      spans++;
    }
  }

  if ((height & 1) !== 0 && width > 0) {
    const start = rows * 2 * width;
    for (let i = start; i < pixelCount; i++) {
      outU32[i] = srcU32[i];
    }
  }

  if (outCopy !== null) {
    out.data.set(outCopy);
  }

  const meanAbsError =
    pixelCount === 0 ? 0 : errorSum / (pixelCount * 3);

  return { out, spans, meanAbsError };
}

/**
 * Choose the smallest tolerance in [0, maxTol] (integers) whose shaped span count is <= targetSpans,
 * by bisection (at most `iters` shapeSpans calls, default 6).
 */
export function fitSpans(
  src: Pixels,
  targetSpans: number,
  opts?: { maxTol?: number; iters?: number; scratch?: Pixels | null }
): {
  tol: number;
  out: Pixels;
  spans: number;
  meanAbsError: number;
  scratch: Pixels | null;
} {
  const maxTol = Math.max(
    0,
    Math.min(255, Math.floor(opts?.maxTol ?? 255))
  );
  const iters = Math.max(1, Math.floor(opts?.iters ?? 6));

  let calls = 0;
  let scratch = opts?.scratch ?? null;

  let result = shapeSpans(src, 0, scratch);
  calls++;

  if (result.spans <= targetSpans) {
    return {
      tol: 0,
      out: result.out,
      spans: result.spans,
      meanAbsError: result.meanAbsError,
      scratch: null,
    };
  }

  if (maxTol === 0) {
    return {
      tol: 0,
      out: result.out,
      spans: result.spans,
      meanAbsError: result.meanAbsError,
      scratch: null,
    };
  }

  let workOut = result.out;

  if (calls >= iters) {
    result = shapeSpans(src, maxTol, workOut);
    return {
      tol: maxTol,
      out: result.out,
      spans: result.spans,
      meanAbsError: result.meanAbsError,
      scratch: null,
    };
  }

  result = shapeSpans(src, maxTol, workOut);
  calls++;

  if (result.spans > targetSpans) {
    return {
      tol: maxTol,
      out: result.out,
      spans: result.spans,
      meanAbsError: result.meanAbsError,
      scratch: null,
    };
  }

  let bestOut: Pixels = result.out;
  let bestSpans = result.spans;
  let bestError = result.meanAbsError;
  let bestTol = maxTol;

  let otherOut: Pixels | null = null;
  let low = 0;
  let high = maxTol;

  while (calls < iters && high - low > 1) {
    const mid = (low + high) >> 1;
    if (mid === low) break;

    result = shapeSpans(src, mid, otherOut);
    calls++;
    otherOut = result.out;

    if (result.spans <= targetSpans) {
      const oldBest = bestOut;
      bestOut = result.out;
      bestSpans = result.spans;
      bestError = result.meanAbsError;
      bestTol = mid;
      otherOut = oldBest;
      high = mid;
    } else {
      low = mid;
    }
  }

  return {
    tol: bestTol,
    out: bestOut,
    spans: bestSpans,
    meanAbsError: bestError,
    scratch: otherOut,
  };
}
