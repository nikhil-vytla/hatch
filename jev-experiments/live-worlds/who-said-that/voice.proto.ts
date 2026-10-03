/**
 * PROTOTYPE — Who said that? Voice side: find speech, then fingerprint each stretch of it.
 *
 * No model: a voice fingerprint is the mean and spread of 12 MFCCs plus pitch, computed in
 * plain TypeScript, so it runs the same in the browser and in Node and needs no download or
 * licence. It's crude next to a trained speaker-embedding network; it separates voices that
 * differ in pitch and timbre and struggles with similar ones.
 */
export const RATE = 16000;
const FRAME = 400; // 25 ms
const HOP = 160; // 10 ms
const NFFT = 512;
const MELS = 26;
const CEPS = 12;

export type Segment = { start: number; end: number };

/** Frame energies in dB. */
export function frameDb(x: Float32Array): number[] {
  const out: number[] = [];

  for (let s = 0; s + FRAME <= x.length; s += HOP) {
    let e = 0;

    for (let i = 0; i < FRAME; i++) e += x[s + i] * x[s + i];

    out.push(10 * Math.log10(e / FRAME + 1e-10));
  }

  return out;
}

/**
 * Energy voice-activity detection. Speech is anything well above the room's noise floor (its
 * 20th-percentile frame); a pause of at least `minGap` seconds splits a segment.
 */
export function detectSpeech(x: Float32Array, opts: { aboveFloorDb?: number; minGap?: number; minLength?: number } = {}): Segment[] {
  const { aboveFloorDb = 9, minGap = 0.12, minLength = 0.35 } = opts;
  const db = frameDb(x);
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? -100;
  // Smooth over 50 ms so single quiet frames inside words don't split them.
  const on = db.map((_, i) => {
    let m = -Infinity;

    for (let j = Math.max(0, i - 2); j <= Math.min(db.length - 1, i + 2); j++) m = Math.max(m, db[j]);

    return m > floor + aboveFloorDb;
  });
  const segs: Segment[] = [];
  let start = -1;
  let quiet = 0;
  const gapFrames = Math.round((minGap * RATE) / HOP);

  for (let i = 0; i < on.length; i++) {
    if (on[i]) {
      if (start < 0) start = i;

      quiet = 0;
    } else if (start >= 0) {
      quiet++;

      if (quiet >= gapFrames) {
        segs.push({ start: (start * HOP) / RATE, end: ((i - quiet + 1) * HOP + FRAME) / RATE });
        start = -1;
        quiet = 0;
      }
    }
  }

  if (start >= 0) segs.push({ start: (start * HOP) / RATE, end: x.length / RATE });

  return segs.filter((s) => s.end - s.start >= minLength);
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;

    for (; j & bit; bit >>= 1) j ^= bit;

    j ^= bit;

    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;

    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;

        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
  }
}

const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

const FILTERS: number[][] = (() => {
  const lo = mel(80);
  const hi = mel(7600);
  const pts = Array.from({ length: MELS + 2 }, (_, i) => Math.floor(((NFFT + 1) * hz(lo + ((hi - lo) * i) / (MELS + 1))) / RATE));

  return Array.from({ length: MELS }, (_, m) => {
    const w = new Array(NFFT / 2 + 1).fill(0);

    for (let k = pts[m]; k < pts[m + 1]; k++) w[k] = (k - pts[m]) / Math.max(1, pts[m + 1] - pts[m]);

    for (let k = pts[m + 1]; k < pts[m + 2]; k++) w[k] = (pts[m + 2] - k) / Math.max(1, pts[m + 2] - pts[m + 1]);

    return w;
  });
})();

const HAMMING = Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

/** One frame's MFCCs (c1–c12) and pitch in Hz (0 when unvoiced). */
function frameFeatures(x: Float32Array, s: number): { mfcc: number[]; f0: number } {
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);

  for (let i = 0; i < FRAME; i++) re[i] = (x[s + i] - 0.97 * (x[s + i - 1] ?? 0)) * HAMMING[i];

  fft(re, im);

  const power = Array.from({ length: NFFT / 2 + 1 }, (_, k) => re[k] * re[k] + im[k] * im[k]);
  const logMel = FILTERS.map((w) => Math.log(w.reduce((a, wk, k) => a + wk * power[k], 0) + 1e-10));
  const mfcc = Array.from({ length: CEPS }, (_, c) =>
    logMel.reduce((a, v, m) => a + v * Math.cos((Math.PI * (c + 1) * (m + 0.5)) / MELS), 0),
  );
  // Pitch by normalised autocorrelation over 70–400 Hz.
  let best = 0;
  let lagAt = 0;
  let e0 = 0;

  for (let i = 0; i < FRAME; i++) e0 += x[s + i] * x[s + i];

  for (let lag = Math.floor(RATE / 400); lag <= Math.floor(RATE / 70); lag++) {
    let c = 0;
    let e1 = 0;

    for (let i = 0; i + lag < FRAME; i++) {
      c += x[s + i] * x[s + i + lag];
      e1 += x[s + i + lag] * x[s + i + lag];
    }

    const r = c / Math.sqrt(e0 * e1 + 1e-12);

    if (r > best) {
      best = r;
      lagAt = lag;
    }
  }

  return { mfcc, f0: best > 0.45 && lagAt ? RATE / lagAt : 0 };
}

/**
 * A fingerprint for one stretch of audio: mean and standard deviation of c1–c12 over its
 * louder frames, plus mean log pitch and its spread. 26 numbers.
 */
export function fingerprint(x: Float32Array, seg: Segment): number[] {
  const s0 = Math.floor(seg.start * RATE);
  const s1 = Math.min(x.length - FRAME, Math.floor(seg.end * RATE));
  const frames: { mfcc: number[]; f0: number; db: number }[] = [];

  for (let s = Math.max(1, s0); s < s1; s += HOP) {
    let e = 0;

    for (let i = 0; i < FRAME; i++) e += x[s + i] * x[s + i];

    frames.push({ ...frameFeatures(x, s), db: 10 * Math.log10(e / FRAME + 1e-10) });
  }

  if (!frames.length) return new Array(CEPS * 2 + 2).fill(0);

  // The loudest 60% of frames belong to the foreground voice more than to the room.
  const cut = [...frames].map((f) => f.db).sort((a, b) => a - b)[Math.floor(frames.length * 0.4)];
  const use = frames.filter((f) => f.db >= cut);
  const mean = Array.from({ length: CEPS }, (_, c) => use.reduce((a, f) => a + f.mfcc[c], 0) / use.length);
  const std = Array.from({ length: CEPS }, (_, c) =>
    Math.sqrt(use.reduce((a, f) => a + (f.mfcc[c] - mean[c]) ** 2, 0) / use.length),
  );
  const voiced = use.filter((f) => f.f0 > 0).map((f) => Math.log(f.f0));
  const lf0 = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : Math.log(150);
  const sf0 = voiced.length ? Math.sqrt(voiced.reduce((a, v) => a + (v - lf0) ** 2, 0) / voiced.length) : 0;

  return [...mean, ...std, lf0, sf0];
}

/** Z-scores each dimension across a set of fingerprints, so no one feature dominates. */
export function standardise(vs: number[][]): number[][] {
  if (!vs.length) return vs;

  const d = vs[0].length;
  const mu = Array.from({ length: d }, (_, i) => vs.reduce((a, v) => a + v[i], 0) / vs.length);
  const sd = Array.from({ length: d }, (_, i) => Math.sqrt(vs.reduce((a, v) => a + (v[i] - mu[i]) ** 2, 0) / vs.length) || 1);

  return vs.map((v) => v.map((x, i) => (x - mu[i]) / sd[i]));
}

export function cosine(a: number[], b: number[]) {
  let ab = 0;
  let aa = 0;
  let bb = 0;

  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }

  return ab / Math.sqrt(aa * bb + 1e-12);
}
