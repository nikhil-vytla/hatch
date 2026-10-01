import type { PlaceId } from "./town";

export type Preset = { id: string; label: string; text: string; place: PlaceId | null; block: number; counter: string };

/** Block ids are where the notice is pinned (see layoutBlocks in town.ts). */
export const PRESETS: Preset[] = [
  {
    id: "cake",
    label: "Free cake",
    text: "Free cake at the bakery this afternoon, while it lasts!",
    place: "bakery",
    block: 9,
    counter: "The bakery says there is no free cake today. Someone made it up.",
  },
  {
    id: "lizard",
    label: "The mayor is a lizard",
    text: "The mayor is secretly a lizard. Someone saw her tongue at the town hall.",
    place: null,
    block: 3,
    counter: "The mayor is not a lizard. The photo was a filter.",
  },
  {
    id: "bridge",
    label: "The bridge is closing",
    text: "The old bridge closes tomorrow for a month of repairs. Plan another route.",
    place: null,
    block: 13,
    counter: "The council says the bridge stays open. The repairs are next year.",
  },
  {
    id: "scam",
    label: "A £500 prize",
    text: "The council is giving every resident £500! Text your bank PIN to 07700 900123 to claim it.",
    place: null,
    block: 25,
    counter: "The council never asks for your PIN. The £500 text is a scam.",
  },
];
