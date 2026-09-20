import {
  CUSTOMERS,
  FIELDS,
  emptyPreferences,
  inventoryFor,
  type Field,
  type Preferences,
  type PublicInput,
  type Turn,
} from "./engine";
type Gold = Partial<Record<Field, string>>;
export type Case = {
  id: string;
  category: string;
  input: PublicInput;
  expected: Preferences;
  customerId?: string;
};
export function makeCase(
  id: string,
  category: string,
  text: string | string[],
  gold: Gold,
  seed = 11,
): Case {
  const transcript: Turn[] = (Array.isArray(text) ? text : [text]).map(
    (text, i) => ({ id: i + 1, text, kind: "customer" }),
  );
  const expected = emptyPreferences();
  for (const [key, token] of Object.entries(gold)) {
    const field = key as Field;
    const [status, ...value] = token!.split("_");
    expected[field] = {
      status: status as Preferences[Field]["status"],
      value: value.length ? value.join("_") : null,
      sourceTurn: null,
      evidence: null,
    };
  }
  return {
    id,
    category,
    input: { transcript, inventory: inventoryFor(seed), explicit: {} },
    expected,
  };
}
const basic = ["temperature", "caffeine", "dairy", "sweet"] as const;
const statements = {
  temperature: ["Serve it cold.", "Serve it hot."],
  caffeine: ["No caffeine.", "I want caffeine."],
  dairy: ["No dairy.", "Use dairy milk."],
  sweet: ["Unsweetened, please.", "Make it sweet."],
};
const values = {
  temperature: ["cold", "hot"],
  caffeine: ["no", "yes"],
  dairy: ["no", "yes"],
  sweet: ["no", "yes"],
};
export const partialCases: Case[] = Array.from({ length: 81 }, (_, i) => {
  let n = i;
  const gold: Gold = {};
  const parts: string[] = [];
  for (const field of basic) {
    const digit = n % 3;
    n = Math.floor(n / 3);
    if (digit) {
      gold[field] = `required_${values[field][digit - 1]}`;
      parts.push(statements[field][digit - 1]);
    }
  }
  return makeCase(
    `partial_${String(i).padStart(2, "0")}`,
    "finite-partial-state",
    parts.join(" ") || "Hello. I haven't decided on a drink yet.",
    gold,
  );
});
export const specialCases: Case[] = [
  makeCase(
    "negation",
    "negation",
    "Please don't give me anything hot or caffeinated. No dairy and no sugar either.",
    {
      temperature: "required_cold",
      caffeine: "required_no",
      dairy: "required_no",
      sweet: "required_no",
    },
  ),
  makeCase(
    "double-negation",
    "negation",
    "It doesn't have to be dairy-free. I don't want something sweet.",
    { sweet: "required_no" },
  ),
  makeCase(
    "soft",
    "soft-preference",
    "I need no dairy. Preferably something hot and creamy, though cold is fine too.",
    {
      dairy: "required_no",
      temperature: "preferred_hot",
      creamy: "preferred_yes",
    },
  ),
  makeCase(
    "conflict",
    "contradiction",
    "It must be hot and it must be cold at the same time. Both are non-negotiable.",
    { temperature: "conflicting" },
  ),
  makeCase(
    "revision",
    "revision",
    [
      "I want a hot drink with dairy milk, caffeine and no sweetness.",
      "Actually, make it iced. Keep everything else the same.",
    ],
    {
      temperature: "required_cold",
      dairy: "required_yes",
      caffeine: "required_yes",
      sweet: "required_no",
    },
  ),
  makeCase(
    "budget-revision",
    "revision",
    [
      "Hot coffee with dairy milk and no sugar. My maximum is six dollars.",
      "Change the milk to dairy-free and lower my maximum to four dollars.",
    ],
    {
      temperature: "required_hot",
      coffee: "required_yes",
      dairy: "required_no",
      sweet: "required_no",
      budget: "required_400",
    },
  ),
  makeCase(
    "budget-impossible",
    "no-match",
    "A creamy sweet drink, served hot with dairy milk. My maximum is three dollars.",
    {
      creamy: "required_yes",
      sweet: "required_yes",
      temperature: "required_hot",
      dairy: "required_yes",
      budget: "required_300",
    },
  ),
  makeCase(
    "coffee-no-caffeine",
    "no-match",
    "I need coffee flavor with absolutely zero caffeine. No substitutes for either.",
    { coffee: "required_yes", caffeine: "required_no" },
  ),
  makeCase(
    "unsupported-budget",
    "no-match",
    "I can spend at most $2.75. Something hot, please.",
    { budget: "required_unsupported", temperature: "required_hot" },
  ),
  makeCase(
    "creamy-not-dairy",
    "distinction",
    "I need a creamy drink without any dairy. Don't add sugar. Cold, please.",
    {
      creamy: "required_yes",
      dairy: "required_no",
      sweet: "required_no",
      temperature: "required_cold",
    },
  ),
  makeCase(
    "low-caffeine",
    "distinction",
    "A hot drink with no more than 50 mg of caffeine. I don't care about dairy or sweetness.",
    { temperature: "required_hot", caffeine: "required_low" },
  ),
  makeCase(
    "ambiguous",
    "ambiguity",
    "Something nice for a long afternoon. I'm not sure what I want.",
    {},
  ),
  makeCase(
    "coffee-soft",
    "soft-preference",
    "Ideally coffee flavor, but tea is okay. It must be cold and unsweetened.",
    {
      coffee: "preferred_yes",
      temperature: "required_cold",
      sweet: "required_no",
    },
  ),
  makeCase(
    "resolved-conflict",
    "revision",
    [
      "It must be hot and cold at the same time.",
      "That made no sense. Just cold, please, without any caffeine.",
    ],
    { temperature: "required_cold", caffeine: "required_no" },
  ),
  makeCase(
    "forget-sweet",
    "revision",
    [
      "Something hot, caffeinated and sweet with dairy milk.",
      "Actually I don't care about sweetness now. Keep the rest.",
    ],
    {
      temperature: "required_hot",
      caffeine: "required_yes",
      dairy: "required_yes",
    },
  ),
];
export const customerCases: Case[] = CUSTOMERS.map((c) => ({
  ...makeCase(
    `customer_${c.id}`,
    c.id === "ro" ? "inventory-conflict" : "customer-opening",
    c.opening,
    c.id === "mina"
      ? {
          temperature: "required_cold",
          creamy: "required_yes",
          dairy: "required_no",
          caffeine: "required_no",
          sweet: "required_yes",
          budget: "required_600",
        }
      : c.id === "eli"
        ? { coffee: "required_yes" }
        : {
            temperature: "required_cold",
            creamy: "required_yes",
            dairy: "required_no",
            budget: "required_500",
          },
    c.seed,
  ),
  customerId: c.id,
}));
// The clarifying conversation is authored before recording. Hidden goals never
// appear in a provider request. These are cumulative public transcripts only.
export const episodeCases: Case[] = [
  makeCase(
    "eli_answer_1",
    "conversation",
    [CUSTOMERS[1].opening, "Hot, please."],
    { coffee: "required_yes", temperature: "required_hot" },
    12,
  ),
  makeCase(
    "eli_answer_2",
    "conversation",
    [
      CUSTOMERS[1].opening,
      "Hot, please.",
      "No dairy or sugar, and I do want caffeine. My maximum is four dollars.",
    ],
    {
      coffee: "required_yes",
      temperature: "required_hot",
      dairy: "required_no",
      sweet: "required_no",
      caffeine: "required_yes",
      budget: "required_400",
    },
    12,
  ),
  makeCase(
    "mina_revision",
    "conversation",
    [
      CUSTOMERS[0].opening,
      "Actually, make it hot. Everything else stays the same.",
    ],
    {
      temperature: "required_hot",
      creamy: "required_yes",
      dairy: "required_no",
      caffeine: "required_no",
      sweet: "required_yes",
      budget: "required_600",
    },
  ),
];
export const CASES: Case[] = [
  ...customerCases,
  ...specialCases,
  ...episodeCases,
  ...partialCases,
];
export function comparePreferences(actual: Preferences, expected: Preferences) {
  const perField = Object.fromEntries(
    FIELDS.map((f) => [
      f,
      actual[f].status === expected[f].status &&
        actual[f].value === expected[f].value,
    ]),
  ) as Record<Field, boolean>;
  return { exact: Object.values(perField).every(Boolean), perField };
}
