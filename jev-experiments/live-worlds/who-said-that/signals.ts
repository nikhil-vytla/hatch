/**
 * Who said that? Step one: turn audio into signals, one row per stretch of speech.
 *
 * Speech detection is loudness-based, and long stretches are cut at their quietest point so no
 * segment runs past MAX_SEGMENT seconds. For every segment we keep the words (whisper-tiny.en),
 * a voice embedding (CAM++), a meaning embedding (all-MiniLM-L6-v2) and its loudness. The same
 * code runs in Node (to record a scenario) and in the browser (a worker), with the models passed in.
 */
import { embedVoice, type SpeakerRunner } from "./speaker";
import { detectSpeech, frameDb, RATE, type Segment } from "./voice";

export const MAX_SEGMENT = 5;

const HOP_S = 0.01;

export type Models = {
  /** Text for a stretch of 16 kHz audio. */
  transcribe: (audio: Float32Array) => Promise<string>;
  /** Unit-length sentence embeddings. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** A trained voice embedding (CAM++). */
  speaker: SpeakerRunner;
};

/** One stretch of speech and what we measured about it. */
export type Heard = {
  start: number;
  end: number;
  text: string;
  /** CAM++ voice embedding, unit length. */
  voice: number[];
  /** MiniLM meaning embedding, unit length. */
  meaning: number[];
  /** Loudness in dB (mean frame energy over the segment's loudest half). */
  db: number;
  /** With more than one microphone: which one heard it, and by how many dB over the next loudest. */
  channel?: number;
  balance?: number;
};

/** A segment heard louder on another channel (by more than this) is that channel's speech leaking in. */
export const BLEED_MARGIN_DB = 0;

/** Cut segments longer than `max` seconds at their quietest frame, recursively. */
export function splitLong(segs: Segment[], db: number[], max = MAX_SEGMENT): Segment[] {
  const out: Segment[] = [];

  const cut = (s: Segment) => {
    if (s.end - s.start <= max) {
      out.push(s);

      return;
    }

    // Look for the quietest 100 ms between 40% and 100% of the allowed length.
    const lo = Math.floor((s.start + max * 0.4) / HOP_S);
    const hi = Math.min(Math.floor((s.start + max) / HOP_S), db.length - 1);
    let best = lo;

    for (let f = lo; f <= hi; f++) {
      const window = db.slice(Math.max(0, f - 5), f + 5);
      const mean = window.reduce((a, b) => a + b, 0) / Math.max(1, window.length);
      const bestWindow = db.slice(Math.max(0, best - 5), best + 5);
      const bestMean = bestWindow.reduce((a, b) => a + b, 0) / Math.max(1, bestWindow.length);

      if (mean < bestMean) best = f;
    }

    const at = best * HOP_S;

    out.push({ start: s.start, end: at });
    cut({ start: at, end: s.end });
  };

  for (const s of segs) cut(s);

  return out.filter((s) => s.end - s.start >= 0.3);
}

/** Mean dB over the loudest half of the segment's frames. */
export function segmentDb(db: number[], s: Segment): number {
  const frames = db.slice(Math.floor(s.start / HOP_S), Math.ceil(s.end / HOP_S)).sort((a, b) => b - a);
  const top = frames.slice(0, Math.max(1, Math.floor(frames.length / 2)));

  return top.reduce((a, b) => a + b, 0) / top.length;
}

/** Speech segments for a recording: loudness-based detection, then long ones cut. */
export function segment(audio: Float32Array): { segments: Segment[]; db: number[] } {
  const db = frameDb(audio);

  // 6 dB above the quiet floor (chosen on the development windows): with two tables talking, 9 dB
  // missed half the speech.
  return { segments: splitLong(detectSpeech(audio, { minGap: 0.25, aboveFloorDb: 6 }), db), db };
}

const slice = (x: Float32Array, s: Segment) => x.subarray(Math.floor(s.start * RATE), Math.ceil(s.end * RATE));

type Found = Segment & { channel: number; db: number; balance: number };

/**
 * A copy of channel `c` with every 10 ms frame silenced where another microphone is louder: those
 * frames are the other table's speech leaking in, so speech detection on the copy finds only this
 * table's own stretches.
 */
function ownOnly(channels: Float32Array[], dbs: number[][], c: number): Float32Array {
  const out = channels[c].slice();
  const hop = Math.round(HOP_S * RATE);

  for (let f = 0; f < dbs[c].length; f++) {
    const other = Math.max(...dbs.filter((_, k) => k !== c).map((d) => d[f] ?? -100));

    if (dbs[c][f] - other <= BLEED_MARGIN_DB) out.fill(0, f * hop, (f + 1) * hop);
  }

  return out;
}

/** Segments per channel, each from the frames where that microphone hears its own table. */
function findSpeech(channels: Float32Array[]): Found[] {
  const dbs = channels.map((x) => frameDb(x));
  const per =
    channels.length === 1
      ? [segment(channels[0])]
      : channels.map((_, c) => ({ segments: segment(ownOnly(channels, dbs, c)).segments, db: dbs[c] }));
  const found: Found[] = [];

  per.forEach(({ segments }, c) => {
    for (const s of segments) {
      const own = segmentDb(per[c].db, s);

      if (per.length === 1) {
        found.push({ ...s, channel: c, db: own, balance: 0 });
        continue;
      }

      // Frame by frame, how much louder is this microphone than the loudest other one? The median
      // over the segment's frames separates tables far better than comparing average loudness.
      const diffs: number[] = [];

      for (let f = Math.floor(s.start / HOP_S); f < Math.min(per[c].db.length, Math.ceil(s.end / HOP_S)); f++)
        diffs.push(per[c].db[f] - Math.max(...per.filter((_, k) => k !== c).map((p) => p.db[f] ?? -100)));

      diffs.sort((x, y) => x - y);

      const balance = diffs[Math.floor(diffs.length / 2)] ?? 0;

      if (balance <= BLEED_MARGIN_DB) continue;

      // Both microphones can keep overlapping stretches when both tables talk at once.
      found.push({ ...s, channel: c, db: own, balance });
    }
  });

  return found.sort((a, b) => a.start - b.start);
}

/**
 * Every segment's signals, from one channel or several (one microphone per table). Segments come
 * out in time order; with several channels they can overlap in time. `onProgress` reports after
 * each segment is transcribed.
 */
export async function listen(audio: Float32Array | Float32Array[], models: Models, onProgress?: (done: number, total: number) => void): Promise<Heard[]> {
  const channels = Array.isArray(audio) ? audio : [audio];
  const found = findSpeech(channels);
  const multi = channels.length > 1;
  const texts: string[] = [];
  const voices: number[][] = [];

  for (const [i, s] of found.entries()) {
    texts.push((await models.transcribe(slice(channels[s.channel], s))).trim());
    voices.push(await embedVoice(models.speaker, channels[s.channel], s));
    onProgress?.(i + 1, found.length);
  }

  const meanings = await models.embed(texts.map((t) => t || "…"));

  return found
    .map((s, i) => ({
      start: s.start,
      end: s.end,
      text: texts[i],
      voice: voices[i],
      meaning: meanings[i],
      db: s.db,
      ...(multi ? { channel: s.channel, balance: Math.round(s.balance * 10) / 10 } : {}),
    }))
    .filter((h) => h.text && !/^\[.*\]$|^\(.*\)$/.test(h.text));
}

/** Rounded copies of the signals, for a smaller recorded file. */
export const compact = (h: Heard[]): Heard[] =>
  h.map((x) => ({
    ...x,
    start: Math.round(x.start * 100) / 100,
    end: Math.round(x.end * 100) / 100,
    db: Math.round(x.db * 10) / 10,
    voice: x.voice.map((v) => Math.round(v * 1000) / 1000),
    meaning: x.meaning.map((v) => Math.round(v * 1000) / 1000),
  }));
