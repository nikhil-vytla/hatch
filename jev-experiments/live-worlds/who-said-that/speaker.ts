/**
 * A trained voice embedding: Wespeaker's CAM++ (VoxCeleb, Apache-2.0, 29 MB ONNX),
 * fed 80-bin Kaldi filterbank features with mean normalisation over time, as Wespeaker computes
 * them. The ONNX session is passed in, so the browser (onnxruntime-web) and Node
 * (onnxruntime-node) share this code.
 */
import type { Segment } from "./voice";

export const SPEAKER_MODEL = "Wespeaker/wespeaker-voxceleb-campplus (voxceleb_CAM++.onnx)";
export const SPEAKER_URL = "https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus/resolve/main/voxceleb_CAM++.onnx";

const RATE = 16000;
const FRAME = 400;
const HOP = 160;
const NFFT = 512;
const BINS = 80;

/** Run the model on [1, frames, 80] features; returns the embedding. */
export type SpeakerRunner = (feats: Float32Array, frames: number) => Promise<Float32Array>;

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
        const h = i + k + len / 2;
        const vr = re[h] * wr - im[h] * wi;
        const vi = re[h] * wi + im[h] * wr;

        re[h] = re[i + k] - vr;
        im[h] = im[i + k] - vi;
        re[i + k] += vr;
        im[i + k] += vi;
      }
  }
}

const kmel = (f: number) => 1127 * Math.log(1 + f / 700);

/** Kaldi's mel bank: 80 triangles between 20 Hz and Nyquist, over the 256 lower FFT bins. */
const BANK: Float64Array[] = (() => {
  const lo = kmel(20);
  const hi = kmel(RATE / 2);
  const delta = (hi - lo) / (BINS + 1);

  return Array.from({ length: BINS }, (_, m) => {
    const left = lo + m * delta;
    const centre = left + delta;
    const right = centre + delta;
    const w = new Float64Array(NFFT / 2);

    for (let i = 0; i < NFFT / 2; i++) {
      const mf = kmel((i * RATE) / NFFT);

      if (mf > left && mf < right) w[i] = mf <= centre ? (mf - left) / (centre - left) : (right - mf) / (right - centre);
    }

    return w;
  });
})();

// Wespeaker's own feature code passes window_type="hamming" to Kaldi's fbank, not Kaldi's default Povey window.
const WINDOW = Array.from({ length: FRAME }, (_, n) => 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FRAME - 1)));

/** Kaldi-compatible log mel filterbank (no dither), mean-normalised over time. */
export function fbank(x: Float32Array): { feats: Float32Array; frames: number } {
  const frames = x.length < FRAME ? 0 : 1 + Math.floor((x.length - FRAME) / HOP);
  const feats = new Float32Array(frames * BINS);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);

  for (let f = 0; f < frames; f++) {
    const s = f * HOP;
    let mean = 0;

    for (let i = 0; i < FRAME; i++) mean += x[s + i] * 32768;

    mean /= FRAME;
    re.fill(0);
    im.fill(0);

    let prev = x[s] * 32768 - mean;

    for (let i = 0; i < FRAME; i++) {
      const v = x[s + i] * 32768 - mean;

      re[i] = (v - 0.97 * (i === 0 ? v : prev)) * WINDOW[i];
      prev = v;
    }

    fft(re, im);

    for (let m = 0; m < BINS; m++) {
      let e = 0;
      const w = BANK[m];

      for (let i = 0; i < NFFT / 2; i++) if (w[i]) e += w[i] * (re[i] * re[i] + im[i] * im[i]);

      feats[f * BINS + m] = Math.log(Math.max(e, 1.1920929e-7));
    }
  }

  for (let m = 0; m < BINS; m++) {
    let mu = 0;

    for (let f = 0; f < frames; f++) mu += feats[f * BINS + m];

    mu /= Math.max(1, frames);

    for (let f = 0; f < frames; f++) feats[f * BINS + m] -= mu;
  }

  return { feats, frames };
}

/** A unit-length voice embedding for one stretch of audio (at least 0.5 s is used). */
export async function embedVoice(run: SpeakerRunner, x: Float32Array, seg: Segment): Promise<number[]> {
  let s0 = Math.floor(seg.start * RATE);
  let s1 = Math.ceil(seg.end * RATE);

  if (s1 - s0 < RATE / 2) {
    const mid = (s0 + s1) >> 1;

    s0 = Math.max(0, mid - RATE / 4);
    s1 = Math.min(x.length, mid + RATE / 4);
  }

  const all = fbank(x.subarray(s0, s1));
  // Keep the loudest 60% of frames: in a noisy room the quieter ones are mostly other people.
  const energy = Array.from({ length: all.frames }, (_, f) => {
    let e = 0;

    for (let m = 0; m < BINS; m++) e += all.feats[f * BINS + m];

    return e;
  });
  const cut = [...energy].sort((a, b) => a - b)[Math.floor(all.frames * 0.4)] ?? -Infinity;
  const keep = energy.flatMap((e, f) => (e >= cut ? [f] : []));
  const feats = new Float32Array(keep.length * BINS);

  keep.forEach((f, i) => feats.set(all.feats.subarray(f * BINS, (f + 1) * BINS), i * BINS));

  const frames = keep.length;
  const e = await run(feats, frames);
  const n = Math.sqrt(e.reduce((a, v) => a + v * v, 0)) || 1;

  return Array.from(e, (v) => v / n);
}
