/**
 * The student: one small network per decision, a hidden ReLU layer and a head per question,
 * trained on the open teacher's answers (see train.py). Weights ship as base64 float32 in JSON
 * and run identically in Node and the browser.
 */
export type Head = { kind: "softmax" | "sigmoid"; labels: string[]; w: string; b: string };

export type NetFile = { input: number; hidden: number; w: string; b: string; heads: Record<string, Head> };

type Layer = { w: Float32Array; b: Float32Array; out: number };

export type Net = { input: number; hidden: Layer; heads: Record<string, { kind: Head["kind"]; labels: string[]; layer: Layer }> };

function decode(b64: string): Float32Array {
  const bytes =
    typeof atob === "function" ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(b64, "base64"));

  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export function load(f: NetFile): Net {
  return {
    input: f.input,
    hidden: { w: decode(f.w), b: decode(f.b), out: f.hidden },
    heads: Object.fromEntries(
      Object.entries(f.heads).map(([k, h]) => [k, { kind: h.kind, labels: h.labels, layer: { w: decode(h.w), b: decode(h.b), out: h.labels.length } }]),
    ),
  };
}

/** y = W x + b, with W stored row-major as [out][in]. */
function affine(l: Layer, x: ArrayLike<number>) {
  const n = x.length;
  const y = new Float32Array(l.out);

  for (let o = 0; o < l.out; o++) {
    let s = l.b[o];
    const row = o * n;

    for (let i = 0; i < n; i++) s += l.w[row + i] * x[i];

    y[o] = s;
  }

  return y;
}

export type Outputs = Record<string, Record<string, number>>;

/** Runs the network; `mask` drops labels a head can't choose here (e.g. "go" with no place). */
export function run(net: Net, x: ArrayLike<number>, mask: Record<string, string[]> = {}): Outputs {
  if (x.length !== net.input) throw new Error(`Expected ${net.input} inputs, got ${x.length}.`);

  const h = affine(net.hidden, x).map((v) => (v > 0 ? v : 0));
  const out: Outputs = {};

  for (const [name, head] of Object.entries(net.heads)) {
    const z = affine(head.layer, h);

    if (head.kind === "sigmoid") {
      out[name] = { true: 1 / (1 + Math.exp(-z[0])) };
      continue;
    }

    const allowed = head.labels.map((l) => !mask[name]?.includes(l));
    const max = Math.max(...head.labels.map((_, i) => (allowed[i] ? z[i] : -Infinity)));
    const e = head.labels.map((_, i) => (allowed[i] ? Math.exp(z[i] - max) : 0));
    const total = e.reduce((a, b) => a + b, 0);

    out[name] = Object.fromEntries(head.labels.map((l, i) => [l, e[i] / total]));
  }

  return out;
}

export const top = (d: Record<string, number>) => Object.entries(d).reduce((a, b) => (b[1] > a[1] ? b : a));
