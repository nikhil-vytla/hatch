/**
 * PROTOTYPE — Who said that? The whole pipeline over one clip, with the speech-to-text and
 * sentence-embedding models passed in so the same code runs in the browser (Transformers.js
 * in a worker) and in Node (the recorder, the CLI behind the Mac app).
 */
import { decideAll, type Answers, type Heard, type Tags } from "./decide.proto";
import { embedVoice, type SpeakerRunner } from "./speaker.proto";
import { detectSpeech, fingerprint, standardise, type Segment } from "./voice.proto";

export type Models = {
  /** Text for a stretch of 16 kHz audio. */
  transcribe: (audio: Float32Array) => Promise<string>;
  /** Normalised sentence embeddings. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** A trained voice embedding (CAM++). Without it, the MFCC + pitch fingerprint is used. */
  speaker?: SpeakerRunner;
};

export type Line = Heard & { answers: Answers };

export type Result = { segments: Segment[]; lines: Line[]; ms: { speech: number; voice: number; asr: number; embed: number; decide: number } };

const slice = (x: Float32Array, s: Segment) => x.subarray(Math.floor(s.start * 16000), Math.ceil(s.end * 16000));

/** `tagged` gives the time ranges where each person was tagged (a few seconds each). */
export async function hear(
  audio: Float32Array,
  tagged: { me: [number, number]; friend: [number, number] },
  models: Models,
  onProgress?: (done: number, total: number) => void,
): Promise<Result> {
  const t0 = performance.now();
  const segments = detectSpeech(audio);
  const t1 = performance.now();
  const stretches = [...segments, { start: tagged.me[0], end: tagged.me[1] }, { start: tagged.friend[0], end: tagged.friend[1] }];
  const z: number[][] = [];

  if (models.speaker) for (const s of stretches) z.push(await embedVoice(models.speaker, audio, s));
  else z.push(...standardise(stretches.map((s) => fingerprint(audio, s))));

  const tags: Tags = { me: z[segments.length], friend: z[segments.length + 1], bar: models.speaker ? 0.35 : 0.25 };
  const t2 = performance.now();
  const texts: string[] = [];

  for (const [i, s] of segments.entries()) {
    texts.push((await models.transcribe(slice(audio, s))).trim());
    onProgress?.(i + 1, segments.length);
  }

  const t3 = performance.now();
  const meanings = models.embed ? await models.embed(texts.map((t) => t || "…")) : texts.map(() => null);
  const t4 = performance.now();
  const heard: Heard[] = segments.map((s, i) => ({ ...s, text: texts[i], voice: z[i], meaning: meanings[i] }));
  const answers = decideAll(heard, tags);
  const t5 = performance.now();

  return {
    segments,
    lines: heard.map((h, i) => ({ ...h, answers: answers[i] })),
    ms: { speech: t1 - t0, voice: t2 - t1, asr: t3 - t2, embed: t4 - t3, decide: t5 - t4 },
  };
}

/** The transcript as Markdown, one line per turn, merging consecutive lines by the same person. */
export function markdown(lines: Line[], names: { me: string; friend: string } = { me: "Me", friend: "Friend" }, keepBackground = false) {
  const label = (w: Line["answers"]["who"]) => (w === "me" ? names.me : w === "friend" ? names.friend : "Background");
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const turns: { who: Line["answers"]["who"]; start: number; text: string[] }[] = [];

  for (const l of lines) {
    if (!keepBackground && l.answers.who === "else") continue;

    const last = turns.at(-1);

    if (last && last.who === l.answers.who) last.text.push(l.text);
    else turns.push({ who: l.answers.who, start: l.start, text: [l.text] });
  }

  return turns.map((t) => `**${label(t.who)}** (${mmss(t.start)}): ${t.text.join(" ")}`).join("\n\n") + "\n";
}
