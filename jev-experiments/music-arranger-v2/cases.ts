import type { Contour } from "./engine";
export const originalBriefs = [
  "A quiet lullaby for a rainy evening",
  "An upbeat melody for a morning walk",
  "A mysterious tune for exploring a cave",
  "A cheerful theme for a tiny robot",
  "A slow melancholy melody for an empty station",
  "A playful underwater dance",
  "An urgent chase through a neon city",
  "A warm song for coming home",
];
export const cases: { id: string; set: "original" | "contour"; brief: string; seed: number; requestedContour?: Contour }[] = [
  ...originalBriefs.map((brief, i) => ({ id: `original-${i + 1}`, set: "original" as const, brief, seed: 101 + i })),
  ...([
    ["rising", "A bright sunrise. Each two-bar melody must rise overall without a final drop. Keep the pulse measured."],
    ["falling", "A quiet farewell in shadow. Each two-bar melody should descend and settle into its lower register."],
    ["arch", "A hopeful journey over a hill. Each two-bar melody should climb to a peak and then fall back."],
    ["inverted", "A tense dive and recovery. Each two-bar melody should dip into a valley then climb back up."],
    ["breath", "A calm conversation by the water. Every two-bar melody needs silence between gestures and a rest at its end."],
    ["syncopated", "A playful midnight chase. Use offbeat melody attacks, short rests and an active pulse in every two-bar phrase."],
  ] as [Contour, string][]).map(([requestedContour, brief], i) => ({ id: `contour-${requestedContour}`, set: "contour" as const, brief, seed: 201 + i, requestedContour })),
];
