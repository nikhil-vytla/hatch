export const experimentNotes = [
  {
    slug: "a-score-is-not-a-vote",
    number: "01",
    title: "A score is not a vote",
    description:
      "Two very different answers can have the same average. Move the probability and see what disappears.",
    category: "Typed decisions",
    mode: "Interactive arithmetic",
    date: "2026-09-22",
    scene: "local-models",
  },
  {
    slug: "what-one-resident-saw",
    number: "02",
    title: "What one resident saw",
    description:
      "A notice, twelve neighbors and the boundary between a model's suggestion and a moving world.",
    category: "Living crowd",
    mode: "Recorded model run",
    date: "2026-09-22",
    scene: "crowd",
    // Teaches a scene that has been retired; the page stays reachable, the listings drop it.
    retired: {
      on: "2 Oct 2026",
      reason: "It explains The square at five, which was retired; Who can you win over? replaced it.",
    },
  },
  {
    slug: "four-classifiers-one-route",
    number: "03",
    title: "Four classifiers, one route",
    description:
      "The router could recognize different tasks. Its calibration gave those differences nowhere to go.",
    category: "Model routing",
    mode: "Recorded comparison",
    date: "2026-09-22",
    scene: "routing",
  },
  {
    slug: "when-a-phrase-changes",
    number: "04",
    title: "When a phrase changes",
    description:
      "An edited score and the notes you hear can be different. Step through the bar where they meet.",
    category: "Music arranger",
    mode: "Local scheduler + recorded choices",
    date: "2026-09-22",
    scene: "music",
  },
] as const;

export type Note = (typeof experimentNotes)[number];

/** The notes to list: retired ones keep their pages but leave the indexes. */
export const listedNotes = experimentNotes.filter((note) => !("retired" in note));

export const noteRetirement = (note: Note) => ("retired" in note ? note.retired : null);
