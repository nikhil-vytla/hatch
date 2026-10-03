/**
 * Held-out clip for "Who said that?": different voices, topic and background, written before
 * any rule was changed and never tuned on. "me" is a woman this time and the friend a man.
 */
import type { Line } from "./script";

export const VOICES = { me: "af_sarah", priya: "am_puck", barista: "af_nicole", table: "bm_lewis" } as const;

export const LINES: Line[] = [
  { who: "me", text: "Okay, this is me, I'm planning the trip.", gain: 0.9, gap: 0.4 },
  { who: "priya", text: "And this is Arjun, I'm the one with the spreadsheet.", gain: 0.9, gap: 0.5 },
  { who: "me", text: "If we take the early train to Porto we could", gain: 0.9, gap: 0.8 },
  { who: "priya", text: "could see the river before lunch, yes.", gain: 0.9, gap: 0.15 },
  { who: "table", text: "No, the meeting moved to Thursday afternoon.", gain: 0.35, gap: 0.3 },
  { who: "me", text: "Then the hostel near the bridge makes sense.", gain: 0.9, gap: 0.4 },
  { who: "barista", text: "Two croissants and a cappuccino?", gain: 0.45, gap: 0.2 },
  { who: "priya", text: "It's cheaper, but the reviews mention noise at night.", gain: 0.9, gap: 0.4 },
  { who: "me", text: "We could bring earplugs and", gain: 0.9, gap: 0.5 },
  { who: "priya", text: "and spend the savings on the port tasting.", gain: 0.9, gap: 0.15 },
  { who: "table", text: "Has anyone seen my umbrella?", gain: 0.35, gap: 0.4 },
  { who: "me", text: "Deal. Can you book the train tonight?", gain: 0.9, gap: 0.4 },
  { who: "priya", text: "Sure, I'll send you the tickets after dinner.", gain: 0.9, gap: 0.5 },
];

export const BABBLE = [
  "The printer on the second floor is broken again.",
  "I told him the deadline was Friday, not Monday.",
  "Could we get some more napkins over here?",
  "They're opening a new bakery across the street.",
];
