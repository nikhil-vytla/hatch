export const WARDROBE_VERSION = "wardrobe-v2";
export const FAL_MODEL = "decart/lucy2-vton/realtime";
export const SESSION_SECONDS = 60;
export const COLORS = {
  navy: "#35465f",
  black: "#292d32",
  pink: "#d88a9f",
  cream: "#ded4bf",
  olive: "#788266",
  amber: "#bb8a49",
} as const;
export const CATALOG = [
  {
    id: "denim",
    slot: "jacket",
    name: "The everyday denim",
    type: "denim jacket",
    tags: ["casual", "denim", "button front", "structured"],
    colors: ["navy", "black", "pink", "cream"],
    defaultColor: "navy",
    source: "Original code illustration",
    path: "M33 21 16 30 5 67 22 73 30 49 30 94 70 94 70 49 78 73 95 67 84 30 67 21 59 30 41 30Z",
  },
  {
    id: "bomber",
    slot: "jacket",
    name: "Weekend bomber",
    type: "bomber jacket",
    tags: ["casual", "nylon", "zip front", "ribbed cuffs"],
    colors: ["olive", "black", "pink", "cream"],
    defaultColor: "olive",
    source: "Original code illustration",
    path: "M35 22 15 30 5 78 22 84 30 51 30 94 70 94 70 51 78 84 95 78 85 30 65 22 59 29 41 29Z",
  },
  {
    id: "blazer",
    slot: "jacket",
    name: "After-hours blazer",
    type: "tailored blazer",
    tags: ["formal", "woven wool", "lapels", "single breasted"],
    colors: ["navy", "black", "pink", "cream"],
    defaultColor: "black",
    source: "Original code illustration",
    path: "M36 19 17 28 7 82 24 84 30 48 27 97 50 92 73 97 70 48 76 84 93 82 83 28 64 19 59 35 41 35Z",
  },
  {
    id: "raincoat",
    slot: "jacket",
    name: "Rain check",
    type: "hooded raincoat",
    tags: ["outdoors", "waterproof", "hood", "longline"],
    colors: ["olive", "navy", "pink", "cream"],
    defaultColor: "olive",
    source: "Original code illustration",
    path: "M36 23 Q29 5 50 4 Q71 5 64 23 L84 33 95 79 80 84 72 56 76 99 24 99 28 56 20 84 5 79 16 33Z",
  },
  {
    id: "wayfarer",
    slot: "glasses",
    name: "City shades",
    type: "wayfarer sunglasses",
    tags: ["square", "sunglasses", "acetate", "classic"],
    colors: ["black", "pink", "amber"],
    defaultColor: "black",
    source: "Original code illustration",
    path: "M10 39 Q24 32 42 39 L45 44 55 44 58 39 Q76 32 90 39 L88 61 Q74 70 60 61 L55 49 45 49 40 61 Q26 70 12 61Z",
  },
  {
    id: "round",
    slot: "glasses",
    name: "Sunday circles",
    type: "round sunglasses",
    tags: ["round", "sunglasses", "thin frame", "retro"],
    colors: ["black", "pink", "amber"],
    defaultColor: "amber",
    source: "Original code illustration",
    path: "M43 50 A16 16 0 1 1 11 50 A16 16 0 1 1 43 50 M89 50 A16 16 0 1 1 57 50 A16 16 0 1 1 89 50 M43 49 Q50 43 57 49",
  },
  {
    id: "sport",
    slot: "glasses",
    name: "Fast lane",
    type: "wraparound sport sunglasses",
    tags: ["sport", "wraparound", "sunglasses", "visor"],
    colors: ["black", "pink", "amber"],
    defaultColor: "black",
    source: "Original code illustration",
    path: "M7 38 Q50 28 93 38 L84 61 Q69 69 57 54 L43 54 Q31 69 16 61Z",
  },
] as const;
export type Jacket = "none" | "denim" | "bomber" | "blazer" | "raincoat";
export type Glasses = "none" | "wayfarer" | "round" | "sport";
export type Color = keyof typeof COLORS;
export type Outfit = {
  jacket: Jacket;
  jacketColor: Color;
  fit: "fitted" | "regular" | "oversized";
  glasses: Glasses;
  glassesColor: Color;
  glassesSize: "small" | "regular" | "large";
  shirt: "white" | "black";
  trousers: "indigo" | "cream";
  focus: "jacket" | "glasses" | "none";
};
export const INITIAL_OUTFIT: Outfit = {
  jacket: "none",
  jacketColor: "navy",
  fit: "regular",
  glasses: "none",
  glassesColor: "black",
  glassesSize: "regular",
  shirt: "white",
  trousers: "indigo",
  focus: "none",
};
export const EDIT_FIELDS = [
  "jacket",
  "jacketColor",
  "fit",
  "glasses",
  "glassesColor",
  "glassesSize",
  "shirt",
  "trousers",
] as const;
export type EditField = (typeof EDIT_FIELDS)[number];
export type Patch = Partial<Pick<Outfit, EditField>>;
export type Provenance = "manual" | "recorded-jev" | "live-jev";
export type CommandSource = "typed" | "speech" | "authored-demo" | "catalog";
export type Command = {
  id: string;
  text: string;
  source: CommandSource;
  before: Outfit;
  after: Outfit;
  patch: Patch;
  provenance: Provenance;
  raw?: unknown;
  accepted: boolean;
  reason?: string;
};
export const item = (id: string) => CATALOG.find((item) => item.id === id);
export function outfitErrors(outfit: Outfit): string[] {
  const errors: string[] = [];
  if (outfit.jacket !== "none") {
    const jacket = item(outfit.jacket);
    if (!jacket || jacket.slot !== "jacket")
      errors.push("Choose a jacket in this wardrobe.");
    else if (!(jacket.colors as readonly string[]).includes(outfit.jacketColor))
      errors.push(`${jacket.name} does not come in ${outfit.jacketColor}.`);
  }
  if (outfit.glasses !== "none") {
    const glasses = item(outfit.glasses);
    if (!glasses || glasses.slot !== "glasses")
      errors.push("Choose sunglasses in this wardrobe.");
    else if (
      !(glasses.colors as readonly string[]).includes(outfit.glassesColor)
    )
      errors.push(`${glasses.name} does not come in ${outfit.glassesColor}.`);
  }
  if (!["fitted", "regular", "oversized"].includes(outfit.fit))
    errors.push("Unsupported jacket fit.");
  if (!["small", "regular", "large"].includes(outfit.glassesSize))
    errors.push("Unsupported sunglasses size.");
  if (
    !["white", "black"].includes(outfit.shirt) ||
    !["indigo", "cream"].includes(outfit.trousers)
  )
    errors.push("Unsupported base outfit.");
  if (
    !Object.hasOwn(COLORS, outfit.jacketColor) ||
    !Object.hasOwn(COLORS, outfit.glassesColor)
  )
    errors.push("Unknown color.");
  return errors;
}
export function applyPatch(outfit: Outfit, patch: Patch): Outfit {
  if (Object.keys(patch).some((key) => !EDIT_FIELDS.includes(key as EditField)))
    throw new Error("Unknown outfit field.");
  const next = { ...outfit, ...patch };
  if (
    (Object.hasOwn(patch, "jacketColor") || Object.hasOwn(patch, "fit")) &&
    next.jacket === "none"
  )
    throw new Error("Choose a jacket before changing its color or fit.");
  if (
    (Object.hasOwn(patch, "glassesColor") ||
      Object.hasOwn(patch, "glassesSize")) &&
    next.glasses === "none"
  )
    throw new Error("Choose sunglasses before changing their color or size.");
  const errors = outfitErrors(next);
  if (errors.length) throw new Error(errors.join(" "));
  const jacketChanged = ["jacket", "jacketColor", "fit"].some(
    (k) => Object.hasOwn(patch, k) && (patch as any)[k] !== (outfit as any)[k],
  );
  const glassesChanged = ["glasses", "glassesColor", "glassesSize"].some(
    (k) => Object.hasOwn(patch, k) && (patch as any)[k] !== (outfit as any)[k],
  );
  next.focus =
    jacketChanged && !glassesChanged
      ? "jacket"
      : glassesChanged && !jacketChanged
        ? "glasses"
        : jacketChanged && glassesChanged
          ? "none"
          : outfit.focus;
  if (next[next.focus === "glasses" ? "glasses" : "jacket"] === "none")
    next.focus = "none";
  return next;
}
export function fullPrompt(outfit: Outfit): string {
  const jacket =
    outfit.jacket === "none"
      ? "No jacket, coat or outer layer."
      : `Wear a ${outfit.jacketColor} ${item(outfit.jacket)!.type} in a ${outfit.fit} fit. ${outfit.fit === "oversized" ? "Make only the jacket wider with dropped shoulders, not the person's body." : "Keep the jacket's proportions appropriate to that fit."}`;
  const glasses =
    outfit.glasses === "none"
      ? "No sunglasses or eyewear."
      : `Wear ${outfit.glassesColor} ${item(outfit.glasses)!.type}, ${outfit.glassesSize === "large" ? "with large frames" : outfit.glassesSize === "small" ? "with small frames" : "with regular frames"}.`;
  return `Transform clothing and accessories only. Preserve the person's face, identity, hair, skin tone, body shape, pose, motion and background. The complete current outfit is: a ${outfit.shirt} crew-neck T-shirt and ${outfit.trousers} trousers. ${jacket} ${glasses} Keep all listed garments and accessories together. Do not remove an existing listed item when adding another. Do not add logos, text, hats or extra accessories.`;
}
export function choiceQuestion(
  instructions: string,
  criteria: Record<string, string>,
) {
  return { type: "choice" as const, instructions, criteria };
}
const keep = {
  keep: "Keep this field exactly as it is; the current request does not change it",
};
export function editQuestions(outfit: Outfit = INITIAL_OUTFIT) {
  const referent = `The currently focused garment is ${outfit.focus}. When the newest command uses them/these/those/it without explicitly naming another garment, it means ONLY ${outfit.focus}. In this case every field belonging to another garment MUST be keep. If focus is none, an unqualified color/size change requires clarify. 'Make them pink' with glasses focus means only glassesColor=pink. 'Make them bigger' with glasses focus means only glassesSize=large, NEVER jacket fit. Jacket selection remains keep when sunglasses are added. Explicit garment names override this focus rule. `;
  const question = (field: string, criteria: Record<string, string>) =>
    choiceQuestion(
      referent +
        `Interpret only the newest command as an edit to the canonical outfit. For ${field}, select the explicitly requested change or keep. Preserve all unrelated fields. Resolve pronouns using outfit.focus only when unambiguous. A request to add sunglasses never removes a jacket. Bigger means garment fit or frame size, never the person's body. Do not turn a negated item or color into a positive request. Use the wardrobe metadata; do not invent items.`,
      { ...keep, ...criteria },
    );
  return {
    action: choiceQuestion(
      referent +
        "Choose apply for supported clear edits, undo for an explicit request to undo the last change, reset only for an explicit request to reset the whole outfit, clarify when the target is ambiguous, and unsupported for a request outside this wardrobe. If a phrase like 'make it bigger' has no outfit.focus, clarify. Unsupported requests must not change clothing.",
      {
        apply: "Apply the requested supported edits",
        undo: "Undo the most recent accepted edit",
        reset: "Reset the whole outfit",
        clarify: "Ask which garment or detail the user means",
        unsupported: "Explain that the catalog cannot make that change",
      },
    ),
    jacket: question("jacket selection", {
      none: "Remove the jacket",
      ...Object.fromEntries(
        CATALOG.filter((i) => i.slot === "jacket").map((i) => [
          i.id,
          `${i.name}: ${i.type}; ${i.tags.join(", ")}`,
        ]),
      ),
    }),
    jacketColor: question(
      "jacket color",
      Object.fromEntries(
        ["navy", "black", "pink", "cream", "olive"].map((c) => [c, c]),
      ),
    ),
    fit: question("jacket fit", {
      fitted: "Fitted jacket",
      regular: "Regular jacket",
      oversized: "Oversized, bigger jacket with dropped shoulders",
    }),
    glasses: question("sunglasses selection", {
      none: "Remove sunglasses",
      ...Object.fromEntries(
        CATALOG.filter((i) => i.slot === "glasses").map((i) => [
          i.id,
          `${i.name}: ${i.type}; ${i.tags.join(", ")}`,
        ]),
      ),
    }),
    glassesColor: question("sunglasses color", {
      black: "Black frames",
      pink: "Pink frames",
      amber: "Amber frames",
    }),
    glassesSize: question("sunglasses size", {
      small: "Smaller frames",
      regular: "Regular frames",
      large: "Bigger frames",
    }),
    shirt: question("T-shirt color", {
      white: "White T-shirt",
      black: "Black T-shirt",
    }),
    trousers: question("trousers color", {
      indigo: "Indigo trousers",
      cream: "Cream trousers",
    }),
  };
}
export const editState = (outfit: Outfit, text: string) => ({
  version: WARDROBE_VERSION,
  canonicalOutfit: outfit,
  outfit,
  newestCommand: text,
  wardrobe: CATALOG.map(({ path, ...metadata }) => metadata),
  privacy:
    "No photograph, camera frame, voice recording or private person data is included. Only clothing state, catalog metadata and the command transcript.",
});
export function focusedEditScope(
  outfit: Outfit,
  command: string,
): "jacket" | "glasses" | null {
  // A small interaction grammar, not a second clothing classifier: a simple
  // pronoun-only edit is scoped to the conversation's current garment.
  return outfit.focus !== "none" &&
    /^(?:please\s+)?(?:make|change|turn)\s+(?:it|them|these|those)\b/i.test(
      command.trim(),
    ) &&
    !/\b(jacket|coat|blazer|bomber|sunglasses|glasses|frames|shirt|trousers|both|everything)\b/i.test(
      command,
    )
    ? outfit.focus
    : null;
}
export function interpretEdit(outfit: Outfit, response: any, command = "") {
  const action = response?.answers?.action?.value;
  if (!["apply", "undo", "reset", "clarify", "unsupported"].includes(action))
    return {
      action: "rejected" as const,
      patch: {},
      outfit,
      reason: "Jev returned an unsupported action.",
    };
  if (action !== "apply")
    return {
      action,
      patch: {},
      outfit,
      reason:
        action === "clarify"
          ? "Which piece should change: the jacket or the sunglasses?"
          : action === "unsupported"
            ? "This wardrobe supports the pictured jackets, sunglasses and base colors."
            : "",
    };
  const questions = editQuestions();
  const patch: Record<string, string> = {};
  for (const field of EDIT_FIELDS) {
    const value = response.answers?.[field]?.value;
    if (!Object.hasOwn(questions[field].criteria, value ?? ""))
      return {
        action: "rejected" as const,
        patch: {},
        outfit,
        reason: `Invalid model edit for ${field}.`,
      };
    if (value !== "keep") patch[field] = value;
  }
  if (!Object.keys(patch).length)
    return {
      action: "rejected" as const,
      patch: {},
      outfit,
      reason: "Jev chose apply but did not select an edit.",
    };
  try {
    // First validate the entire raw model selection. Never repair illegal values.
    applyPatch(outfit, patch as Patch);
    const scope = focusedEditScope(outfit, command),
      discarded: string[] = [];
    if (scope)
      for (const field of Object.keys(patch)) {
        const permitted =
          scope === "jacket"
            ? ["jacket", "jacketColor", "fit"]
            : ["glasses", "glassesColor", "glassesSize"];
        if (!permitted.includes(field)) {
          if ((outfit as any)[field] !== patch[field]) discarded.push(field);
          delete patch[field];
        }
      }
    if (!Object.keys(patch).length)
      return {
        action: "rejected" as const,
        patch: {},
        outfit,
        reason: "The model did not propose an edit to the focused garment.",
      };
    return {
      action: "apply" as const,
      patch: patch as Patch,
      outfit: applyPatch(outfit, patch as Patch),
      discarded,
      reason: discarded.length
        ? `Jev also proposed changing ${discarded.join(", ")}. The focus rule kept this pronoun edit on the ${scope}.`
        : "",
    };
  } catch (e) {
    return {
      action: "rejected" as const,
      patch: patch as Patch,
      outfit,
      reason:
        e instanceof Error
          ? e.message
          : "The edit is incompatible with this wardrobe.",
    };
  }
}
export const DEMO_COMMANDS = [
  {
    id: "jacket",
    text: "Put a denim jacket on me.",
    expected: { jacket: "denim" } as Patch,
  },
  {
    id: "sunglasses",
    text: "Add black square sunglasses, and keep the jacket.",
    expected: { glasses: "wayfarer", glassesColor: "black" } as Patch,
  },
  {
    id: "pink",
    text: "Make them pink.",
    expected: { glassesColor: "pink" } as Patch,
  },
  {
    id: "bigger",
    text: "Make them bigger.",
    expected: { glassesSize: "large" } as Patch,
  },
];
export function demoOutfits() {
  let current = INITIAL_OUTFIT;
  return DEMO_COMMANDS.map((c) => ({
    ...c,
    before: current,
    after: (current = applyPatch(current, c.expected)),
  }));
}
export type Ticket = { session: number; revision: number };
export const currentTicket = (request: Ticket, state: Ticket) =>
  request.session === state.session && request.revision === state.revision;
export function garmentSvg(id: string, color: Color = "navy") {
  const garment = item(id);
  if (!garment) return "";
  const fill = COLORS[color];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 108"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${fill}"/><stop offset="1" stop-color="${fill}" stop-opacity=".77"/></linearGradient></defs><path d="${garment.path}" fill="url(#g)" stroke="#202830" stroke-width="1.2" stroke-linejoin="round"/>${garment.slot === "jacket" ? `<path d="M50 33V92 M35 46H44V57H35Z M56 46H65V57H56Z" fill="none" stroke="#ffffff66" stroke-width="1"/><path d="M34 22 42 40 50 32 58 40 66 22" fill="none" stroke="#ffffff66" stroke-width="1.2"/>` : `<path d="M17 42H35 M63 42H81" stroke="#ffffff55" stroke-width="3" stroke-linecap="round"/>`}</svg>`;
}
export const garmentImage = (id: string, color: Color) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(garmentSvg(id, color))}`;
