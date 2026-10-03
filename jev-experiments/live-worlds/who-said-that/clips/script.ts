/**
 * The scripted café clip for "Who said that?": two friends (me, Priya) talk about a floor
 * plan while a barista and another table talk nearby. Every line has a known speaker, so the
 * prototype's attribution can be scored. Voices are Kokoro-82M (Apache-2.0) presets.
 */
export type Line = {
  who: "me" | "priya" | "barista" | "table";
  text: string;
  /** Gain relative to full scale; background is quieter. */
  gain: number;
  /** Seconds of silence before this line (negative overlaps the previous one). */
  gap: number;
};

export const VOICES = { me: "am_michael", priya: "af_bella", barista: "am_fenrir", table: "bm_george" } as const;

export const LINES: Line[] = [
  { who: "me", text: "Hi, it's me. I'll be the one talking about the new flat.", gain: 0.9, gap: 0.4 },
  { who: "priya", text: "And I'm Priya. I'm the one who keeps changing the plan.", gain: 0.9, gap: 0.5 },
  { who: "me", text: "So the floor plan has the kitchen facing", gain: 0.9, gap: 0.8 },
  { who: "priya", text: "facing the garden, right?", gain: 0.9, gap: 0.15 },
  { who: "barista", text: "Large oat latte for Sam!", gain: 0.45, gap: 0.3 },
  { who: "me", text: "Exactly, and the stairs go up behind the pantry.", gain: 0.9, gap: 0.3 },
  { who: "table", text: "Did you see the match last night? Unbelievable ending.", gain: 0.35, gap: 0.2 },
  { who: "priya", text: "Then the second bedroom loses its window, though.", gain: 0.9, gap: 0.4 },
  { who: "me", text: "Not if we move the bathroom to the north wall and", gain: 0.9, gap: 0.5 },
  { who: "priya", text: "and push the landing out by a metre. I like that.", gain: 0.9, gap: 0.15 },
  { who: "barista", text: "Can I get a name for the flat white?", gain: 0.45, gap: 0.4 },
  { who: "me", text: "How much would that cost us, do you think?", gain: 0.9, gap: 0.4 },
  { who: "table", text: "I think they'll sell the striker in January.", gain: 0.35, gap: 0.2 },
  { who: "priya", text: "Less than the extension. Maybe twelve thousand.", gain: 0.9, gap: 0.4 },
  { who: "me", text: "Then let's ask the architect about the north wall on Monday.", gain: 0.9, gap: 0.5 },
];

/** A quiet, continuous bed of chatter from other tables (not scored). */
export const BABBLE = [
  "Two more of those, please, and the bill when you have a moment.",
  "She said the train was cancelled again this morning.",
  "Honestly the soup here is better than the sandwiches.",
  "We should book the cabin before the prices go up.",
];
