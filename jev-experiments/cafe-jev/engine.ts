/** The fictional cafe's only source of menu, ingredient and price facts. */
export const MENU_REVISION = "cafe-jev-menu-v1";
export const CONTRACT_VERSION = "cafe-jev-turn-v1";
export type Family = "espresso" | "brew" | "tea" | "cocoa" | "lemonade";
export type Milk = "none" | "dairy" | "oat" | "soy";
export type Temperature = "hot" | "cold";
export type Sweetness = "none" | "light" | "regular";
export type Recipe = {
  family: Family;
  temperature: Temperature;
  milk: Milk;
  sweetness: Sweetness;
  size: "small" | "large";
  shots: number;
  syrup: "none" | "vanilla";
};
export const INGREDIENTS = {
  espresso: { name: "Espresso", dairy: false, cents: 0 },
  brew: { name: "Brewed coffee", dairy: false, cents: 0 },
  tea: { name: "Mint infusion", dairy: false, cents: 0 },
  cocoa: { name: "Caffeine-free cocoa blend", dairy: false, cents: 0 },
  lemonade: { name: "Lemon juice", dairy: false, cents: 0 },
  dairy: { name: "Dairy milk", dairy: true, cents: 40 },
  oat: { name: "Oat milk", dairy: false, cents: 70 },
  soy: { name: "Soy milk", dairy: false, cents: 60 },
  sugar: { name: "Cane sugar", dairy: false, cents: 0 },
  vanilla: { name: "Vanilla syrup", dairy: false, cents: 50 },
} as const;
export type Ingredient = keyof typeof INGREDIENTS;
export type Inventory = Record<Ingredient, number>;
export const MENU: Record<
  Family,
  {
    name: string;
    description: string;
    color: string;
    cents: number;
    temperatures: Temperature[];
    milks: Milk[];
    sweetness: Sweetness[];
    shots: number[];
    syrup: boolean;
    caffeine: number;
    coffeeFlavor: boolean;
  }
> = {
  espresso: {
    name: "Espresso bar",
    description: "Roasted coffee, your way",
    color: "#815033",
    cents: 300,
    temperatures: ["hot", "cold"],
    milks: ["none", "dairy", "oat", "soy"],
    sweetness: ["none", "light", "regular"],
    shots: [1, 2],
    syrup: true,
    caffeine: 60,
    coffeeFlavor: true,
  },
  brew: {
    name: "Slow brew",
    description: "A longer, mellow coffee",
    color: "#633c27",
    cents: 250,
    temperatures: ["hot", "cold"],
    milks: ["none", "dairy", "oat", "soy"],
    sweetness: ["none", "light", "regular"],
    shots: [0],
    syrup: true,
    caffeine: 90,
    coffeeFlavor: true,
  },
  tea: {
    name: "Garden mint",
    description: "Fresh mint, no caffeine",
    color: "#99ac62",
    cents: 280,
    temperatures: ["hot", "cold"],
    milks: ["none"],
    sweetness: ["none", "light", "regular"],
    shots: [0],
    syrup: false,
    caffeine: 0,
    coffeeFlavor: false,
  },
  cocoa: {
    name: "Velvet cocoa",
    description: "Creamy chocolate comfort",
    color: "#976447",
    cents: 380,
    temperatures: ["hot", "cold"],
    milks: ["dairy", "oat", "soy"],
    sweetness: ["light", "regular"],
    shots: [0],
    syrup: true,
    caffeine: 0,
    coffeeFlavor: false,
  },
  lemonade: {
    name: "Cloud lemonade",
    description: "Bright lemon over ice",
    color: "#e9c966",
    cents: 320,
    temperatures: ["cold"],
    milks: ["none"],
    sweetness: ["light", "regular"],
    shots: [0],
    syrup: false,
    caffeine: 0,
    coffeeFlavor: false,
  },
};
export function inventoryFor(seed: number): Inventory {
  return {
    espresso: 10,
    brew: 10,
    tea: 10,
    cocoa: 10,
    lemonade: 10,
    dairy: 10,
    oat: seed % 5 === 0 ? 0 : 10,
    soy: 0,
    sugar: 10,
    vanilla: 10,
  };
}
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export function price(r: Recipe): number {
  return (
    MENU[r.family].cents +
    (r.milk === "none" ? 0 : INGREDIENTS[r.milk].cents) +
    (r.size === "large" ? 100 : 0) +
    Math.max(0, r.shots - 1) * 75 +
    (r.syrup === "vanilla" ? 50 : 0)
  );
}
export function ingredients(r: Recipe): Ingredient[] {
  return [
    r.family,
    ...(r.milk === "none" ? [] : [r.milk]),
    ...(r.sweetness === "none" ? [] : ["sugar" as const]),
    ...(r.syrup === "none" ? [] : ["vanilla" as const]),
  ];
}
export function facts(r: Recipe) {
  return {
    temperature: r.temperature,
    caffeine: Math.round(
      MENU[r.family].caffeine *
        (r.family === "espresso" ? r.shots : r.size === "large" ? 1.4 : 1),
    ),
    dairy: r.milk === "dairy" ? "yes" : "no",
    sweet: r.sweetness === "none" ? "no" : "yes",
    creamy: r.milk === "none" ? "no" : "yes",
    coffee: MENU[r.family].coffeeFlavor ? "yes" : "no",
    budget: price(r),
  };
}
export function recipeErrors(r: Recipe, inventory: Inventory): string[] {
  const base = MENU[r.family];
  if (!base) return ["Unknown drink family"];
  const errors: string[] = [];
  if (!base.temperatures.includes(r.temperature))
    errors.push("This drink is served cold only");
  if (!base.milks.includes(r.milk))
    errors.push("This milk does not belong in this recipe");
  if (!base.sweetness.includes(r.sweetness))
    errors.push("This base already contains a little sugar");
  if (!["small", "large"].includes(r.size)) errors.push("Unknown size");
  if (!base.shots.includes(r.shots)) errors.push("Unsupported shot count");
  if (
    !["none", "vanilla"].includes(r.syrup) ||
    (r.syrup === "vanilla" && (!base.syrup || r.sweetness === "none"))
  )
    errors.push("Vanilla requires a supported, sweetened recipe");
  for (const ingredient of ingredients(r))
    if (!inventory[ingredient])
      errors.push(`${INGREDIENTS[ingredient]?.name ?? ingredient} is sold out`);
  return errors;
}
export const RECIPE_CATALOG: Recipe[] = Object.entries(MENU).flatMap(
  ([family, base]) =>
    base.temperatures.flatMap((temperature) =>
      base.milks.flatMap((milk) =>
        base.sweetness.flatMap((sweetness) =>
          (["small", "large"] as const).flatMap((size) =>
            base.shots.flatMap((shots) =>
              (base.syrup && sweetness !== "none"
                ? (["none", "vanilla"] as const)
                : (["none"] as const)
              ).map((syrup) => ({
                family: family as Family,
                temperature,
                milk,
                sweetness,
                size,
                shots,
                syrup,
              })),
            ),
          ),
        ),
      ),
    ),
);
export const FIELDS = [
  "temperature",
  "caffeine",
  "dairy",
  "sweet",
  "creamy",
  "coffee",
  "budget",
] as const;
export type Field = (typeof FIELDS)[number];
export type Preference = {
  status: "unknown" | "required" | "preferred" | "conflicting";
  value: string | null;
  sourceTurn: number | null;
  evidence: string | null;
};
export type Preferences = Record<Field, Preference>;
export type Turn = { id: number; text: string; kind: "customer" | "choice" };
export const VALUES: Record<Field, Record<string, string>> = {
  temperature: { hot: "hot", cold: "cold" },
  caffeine: {
    yes: "some caffeine",
    no: "zero caffeine",
    low: "at most 50 mg of caffeine",
  },
  dairy: { yes: "dairy milk", no: "no dairy" },
  sweet: { yes: "sweetened", no: "unsweetened" },
  creamy: { yes: "creamy", no: "no milk or creaminess" },
  coffee: { yes: "coffee flavor", no: "no coffee flavor" },
  budget: {
    "300": "$3 maximum",
    "400": "$4 maximum",
    "500": "$5 maximum",
    "600": "$6 maximum",
    "800": "$8 maximum",
    unsupported: "a different explicit budget",
  },
};
export const FIELD_LABELS: Record<Field, string> = {
  temperature: "Temperature",
  caffeine: "Caffeine",
  dairy: "Dairy",
  sweet: "Sweetness",
  creamy: "Creaminess",
  coffee: "Coffee flavor",
  budget: "Budget",
};
export const QUESTIONS: Record<Field, string> = {
  temperature: "Something warm, or over ice?",
  caffeine: "Would you like caffeine?",
  dairy: "Does dairy milk work for you?",
  sweet: "Would you like a little sweetness?",
  creamy: "Do you feel like something creamy?",
  coffee: "Are you in the mood for coffee flavor?",
  budget: "What would you like to spend?",
};
export const emptyPreferences = (): Preferences =>
  Object.fromEntries(
    FIELDS.map((f) => [
      f,
      { status: "unknown", value: null, sourceTurn: null, evidence: null },
    ]),
  ) as Preferences;
export function setPreference(
  p: Preferences,
  field: Field,
  value: string,
  turn: Turn,
  status: "required" | "preferred" = "required",
): Preferences {
  if (!Object.hasOwn(VALUES[field], value))
    throw new Error("Unsupported preference value");
  return {
    ...p,
    [field]: { status, value, sourceTurn: turn.id, evidence: turn.text },
  };
}
export function matches(
  r: Recipe,
  field: Field,
  value: string | null,
): boolean {
  const f = facts(r);
  if (field === "caffeine")
    return value === "yes"
      ? f.caffeine > 0
      : value === "low"
        ? f.caffeine <= 50
        : f.caffeine === 0;
  if (field === "budget")
    return (
      value !== "unsupported" &&
      Number.isFinite(Number(value)) &&
      f.budget <= Number(value)
    );
  return f[field] === value;
}
export function constraintErrors(
  r: Recipe,
  preferences: Preferences,
  inventory: Inventory,
): string[] {
  return [
    ...recipeErrors(r, inventory),
    ...FIELDS.flatMap((field) => {
      const p = preferences[field];
      if (p.status === "conflicting")
        return [`Please resolve ${FIELD_LABELS[field].toLowerCase()}`];
      if (p.status === "required" && !matches(r, field, p.value))
        return [
          `Does not meet ${FIELD_LABELS[field].toLowerCase()}: ${VALUES[field][p.value ?? ""] ?? p.value}`,
        ];
      return [];
    }),
  ];
}
export function candidates(
  preferences: Preferences,
  inventory: Inventory,
): Recipe[] {
  return RECIPE_CATALOG.filter(
    (r) => !constraintErrors(r, preferences, inventory).length,
  ).sort(
    (a, b) =>
      softScore(b, preferences) - softScore(a, preferences) ||
      price(a) - price(b) ||
      recipeId(a).localeCompare(recipeId(b)),
  );
}
export const softScore = (r: Recipe, p: Preferences) =>
  FIELDS.reduce(
    (n, f) =>
      n + (p[f].status === "preferred" && matches(r, f, p[f].value) ? 1 : 0),
    0,
  );
export const recipeId = (r: Recipe) =>
  [r.family, r.temperature, r.milk, r.sweetness, r.size, r.shots, r.syrup].join(
    "/",
  );
export function drinkName(r: Recipe) {
  return `${r.temperature === "cold" ? "Iced " : ""}${r.family === "espresso" && r.milk !== "none" ? `${INGREDIENTS[r.milk].name.toLowerCase()} latte` : MENU[r.family].name.toLowerCase()}`;
}
export function usefulQuestions(p: Preferences, recipes: Recipe[]): Field[] {
  const conflicts = FIELDS.filter(
    (f) =>
      p[f].status === "conflicting" ||
      (f === "budget" && p[f].value === "unsupported"),
  );
  if (conflicts.length) return conflicts;
  return FIELDS.filter((f) => p[f].status === "unknown" && f !== "budget")
    .map((field) => {
      const sizes = Object.keys(VALUES[field]).map(
        (v) => recipes.filter((r) => matches(r, field, v)).length,
      );
      return { field, split: Math.min(...sizes) };
    })
    .filter((x) => x.split > 0)
    .sort((a, b) => b.split - a.split)
    .map((x) => x.field);
}
export function relaxations(p: Preferences, inventory: Inventory) {
  return FIELDS.filter((f) => p[f].status === "required")
    .map((field) => {
      const without = { ...p, [field]: emptyPreferences()[field] };
      return { field, count: candidates(without, inventory).length };
    })
    .filter((x) => x.count > 0);
}
export type Question = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
export type PublicInput = {
  transcript: Turn[];
  inventory: Inventory;
  explicit: Partial<Record<Field, Preference>>;
};
export function publicState(input: PublicInput) {
  return {
    contractVersion: CONTRACT_VERSION,
    menuRevision: MENU_REVISION,
    menu: MENU,
    ingredients: INGREDIENTS,
    ...input,
    note: "Fictional cafe. Cocoa is caffeine-free only in this authored menu. Do not infer a private customer goal. Explicit choices are authoritative unless the customer later explicitly revises them. Latest clear correction replaces that field only. No real order or purchase.",
  };
}
export function modelQuestions(
  prefix = "",
  reference = "the public transcript",
): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (const field of FIELDS) {
    q[`${prefix}${field}`] = {
      type: "choice",
      instructions: `Read ${reference}. Extract ${FIELD_LABELS[field].toLowerCase()} from stated language, preserving earlier preferences unless revised. Required means a definite request, explicit choice, must, only, no or maximum. Preferred means preferably, ideally or a stated wish allowing alternatives. Unknown means unstated or explicitly indifferent. Conflicting means mutually exclusive requirements remain unresolved, not a clear change of mind. Do not infer dairy from creamy, coffee flavor from caffeine, or sweetness from flavor alone. Treat "not sweet" as unsweetened and "not dairy-free" as dairy allowed, not dairy required. For a budget outside the supported numerical limits choose required_unsupported.`,
      criteria: {
        unknown:
          "Not stated, explicitly indifferent, or permission without a preference",
        conflicting: "Unresolved contradictory requirements",
        ...Object.fromEntries(
          Object.entries(VALUES[field]).flatMap(([value, label]) => [
            [`required_${value}`, `Requires ${label}`],
            [
              `preferred_${value}`,
              `Prefers ${label}, may accept an alternative`,
            ],
          ]),
        ),
      },
    };
    q[`${prefix}${field}_source`] = {
      type: "choice",
      instructions: `For ${reference}, which customer turn supplies the current ${FIELD_LABELS[field].toLowerCase()} preference? Choose none for unknown. Use the latest relevant statement; for a conflict use the latest conflicting turn. Turn numbers are explicit ids.`,
      criteria: {
        none: "No supporting turn",
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [
            String(i + 1),
            `Customer turn ${i + 1}`,
          ]),
        ),
      },
    };
  }
  q[`${prefix}question`] = {
    type: "choice",
    instructions: `For ${reference}, choose one useful unresolved preference to clarify. Resolve contradictory requirements first. Do not ask about an already known field. Choose done if the customer gave temperature, caffeine, dairy and sweetness with no contradiction. Choose no_match for an impossible requirement such as coffee flavor with zero caffeine on this menu or an unaffordable order.`,
    criteria: {
      ...QUESTIONS,
      done: "Enough stated preferences to offer a recipe",
      no_match: "Explain that the requirements cannot be met",
    },
  };
  q[`${prefix}family`] = {
    type: "choice",
    instructions: `For ${reference}, which drink family best fits the public request? Rank stated soft preferences too. Use none when unresolved contradictions or impossible requirements prevent a supported suggestion. Code will independently filter your suggestion.`,
    criteria: {
      ...Object.fromEntries(
        Object.entries(MENU).map(([id, b]) => [id, b.description]),
      ),
      none: "No supported suggestion yet",
    },
  };
  return q;
}
export function recordingPayload(cases: Record<string, PublicInput>) {
  return {
    state: {
      contractVersion: CONTRACT_VERSION,
      menuRevision: MENU_REVISION,
      menu: MENU,
      ingredients: INGREDIENTS,
      cases,
      note: "Separate fictional customers. Each question names its case. Interpret only that public transcript. No expected answers or private customer goals are supplied. Cocoa has zero caffeine in this fictional menu. Clear revisions replace one field while preserving unrelated preferences.",
    },
    questions: Object.assign(
      {},
      ...Object.keys(cases).map((id) =>
        modelQuestions(`${id}__`, `case ${id} in state.cases`),
      ),
    ) as Record<string, Question>,
  };
}
export type ModelResponse = {
  answers: Record<
    string,
    {
      value: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  >;
  [key: string]: unknown;
};
export function interpret(
  response: ModelResponse,
  input: PublicInput,
  prefix = "",
) {
  const preferences = emptyPreferences();
  const errors: string[] = [];
  for (const field of FIELDS) {
    const token = response.answers?.[`${prefix}${field}`]?.value;
    const source = response.answers?.[`${prefix}${field}_source`]?.value;
    if (token === "unknown") continue;
    const turn = input.transcript.find((t) => String(t.id) === source);
    if (!turn) {
      errors.push(`${field}: no supporting customer turn`);
      preferences[field] = {
        status: "conflicting",
        value: null,
        sourceTurn: null,
        evidence: null,
      };
      continue;
    }
    if (token === "conflicting") {
      preferences[field] = {
        status: "conflicting",
        value: null,
        sourceTurn: turn.id,
        evidence: turn.text,
      };
      continue;
    }
    const match = /^(required|preferred)_(.+)$/.exec(token ?? "");
    if (!match || !Object.hasOwn(VALUES[field], match[2])) {
      errors.push(`${field}: invalid model preference`);
      preferences[field] = {
        status: "conflicting",
        value: null,
        sourceTurn: turn.id,
        evidence: turn.text,
      };
      continue;
    }
    preferences[field] = {
      status: match[1] as "required" | "preferred",
      value: match[2],
      sourceTurn: turn.id,
      evidence: turn.text,
    };
  }
  // A manual choice cannot disappear just because an extraction omitted it. A later
  // customer utterance can revise it; both source turns remain in the trace.
  for (const field of FIELDS) {
    const explicit = input.explicit[field];
    if (
      explicit &&
      (preferences[field].sourceTurn ?? 0) <= (explicit.sourceTurn ?? 0)
    )
      preferences[field] = explicit;
  }
  const feasible = candidates(preferences, input.inventory);
  const rawQuestion = response.answers?.[`${prefix}question`]?.value;
  const legalQuestions = usefulQuestions(preferences, feasible);
  const isField = FIELDS.includes(rawQuestion as Field);
  let question: Field | null = null;
  if (isField && legalQuestions.includes(rawQuestion as Field))
    question = rawQuestion as Field;
  else if (isField)
    errors.push(
      `Jev asked a known or non-discriminating question: ${rawQuestion}`,
    );
  if (rawQuestion === "no_match" && feasible.length)
    errors.push("Jev reported no match although legal recipes exist");
  if (
    rawQuestion === "done" &&
    FIELDS.some((f) => preferences[f].status === "conflicting")
  )
    errors.push("Jev stopped before resolving a conflict");
  const family = response.answers?.[`${prefix}family`]?.value;
  const suggested = feasible.find((r) => r.family === family) ?? null;
  if (family !== "none" && !suggested)
    errors.push(
      `Jev's ${family ?? "missing"} suggestion does not meet the interpreted requirements`,
    );
  return { preferences, feasible, rawQuestion, question, suggested, errors };
}
export type RequestTicket = { session: number; revision: number };
export const isCurrent = (ticket: RequestTicket, current: RequestTicket) =>
  ticket.session === current.session && ticket.revision === current.revision;
export type Customer = {
  id: string;
  name: string;
  initials: string;
  seed: number;
  opening: string;
  goal: Partial<Record<Field, string>>;
  answers: Partial<Record<Field, string>>;
  preferredFamily: Family;
  color: string;
};
/** Private simulator data. publicState deliberately never receives a Customer. */
export const CUSTOMERS: Customer[] = [
  {
    id: "mina",
    name: "Mina",
    initials: "M",
    seed: 11,
    opening:
      "Something cold and creamy for my walk. I need it dairy-free and caffeine-free. A little sweetness is good. Under six dollars, please.",
    goal: {
      temperature: "cold",
      creamy: "yes",
      dairy: "no",
      caffeine: "no",
      sweet: "yes",
      budget: "600",
    },
    answers: {
      temperature: "cold",
      creamy: "yes",
      dairy: "no",
      caffeine: "no",
      sweet: "yes",
      budget: "600",
      coffee: "no",
    },
    preferredFamily: "cocoa",
    color: "#bc8267",
  },
  {
    id: "eli",
    name: "Eli",
    initials: "E",
    seed: 12,
    opening: "I could use a coffee, but I haven't decided what kind.",
    goal: {
      temperature: "hot",
      caffeine: "yes",
      dairy: "no",
      sweet: "no",
      budget: "400",
    },
    answers: {
      temperature: "hot",
      caffeine: "yes",
      dairy: "no",
      sweet: "no",
      creamy: "no",
      coffee: "yes",
      budget: "400",
    },
    preferredFamily: "brew",
    color: "#778570",
  },
  {
    id: "ro",
    name: "Ro",
    initials: "R",
    seed: 15,
    opening:
      "An iced, creamy cocoa with no dairy, please. It needs to be under five dollars.",
    goal: { temperature: "cold", creamy: "yes", dairy: "no", budget: "500" },
    answers: {
      temperature: "cold",
      caffeine: "no",
      dairy: "no",
      sweet: "yes",
      creamy: "yes",
      coffee: "no",
      budget: "500",
    },
    preferredFamily: "cocoa",
    color: "#9380a6",
  },
];
export function scoreCustomer(
  customer: Customer,
  recipe: Recipe,
  inventory: Inventory,
) {
  const missed = Object.entries(customer.goal)
    .filter(([f, v]) => !matches(recipe, f as Field, v!))
    .map(([f]) => f);
  const legal = recipeErrors(recipe, inventory).length === 0;
  const acceptable = RECIPE_CATALOG.filter(
    (r) =>
      !recipeErrors(r, inventory).length &&
      Object.entries(customer.goal).every(([f, v]) =>
        matches(r, f as Field, v!),
      ),
  );
  return {
    success: legal && !missed.length,
    legal,
    missed,
    goalFeasible: acceptable.length > 0,
    acceptableRecipes: acceptable.length,
    utility:
      legal && !missed.length
        ? recipe.family === customer.preferredFamily
          ? 1
          : 0.8
        : 0,
    hiddenGoal: customer.goal,
  };
}
