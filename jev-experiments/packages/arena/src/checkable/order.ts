/**
 * Order items: a customer says what they want in their own words, and the café proposes a
 * drink shown as a short card. The customer's requirements are hidden structured facts; the
 * words are written from them in many phrasings, so answering is reading and judging, not
 * arithmetic. Code checks the drink against the requirements. At most one requirement is
 * broken, so "which one" always has a single answer.
 */
import { type Item } from "./items";
import { mulberry32 } from "../../../seeded/src/index";

type Drink = {
  name: string;
  milk: "whole milk" | "2% milk" | "oat milk" | "almond milk" | "no milk";
  caffeineMg: number;
  /** 0 unsweetened, 1 lightly sweet, 2 sweet. */
  sugar: 0 | 1 | 2;
  syrup: string | null;
  price: number;
  served: "hot" | "iced";
};

/** Hazelnut and almond count as tree nuts; nothing else on the menu does. */
const hasNuts = (d: Drink) => d.milk === "almond milk" || (d.syrup?.includes("hazelnut") ?? false);

const hasDairy = (d: Drink) => d.milk === "whole milk" || d.milk === "2% milk";

type Requirement =
  | { kind: "dairy"; label: string }
  | { kind: "caffeine"; max: number; label: string }
  | { kind: "budget"; max: number; label: string }
  | { kind: "temperature"; want: "hot" | "iced"; label: string }
  | { kind: "sweet"; max: 0 | 1; label: string }
  | { kind: "nuts"; label: string };

/** True when the drink satisfies the requirement. */
export function meets(d: Drink, r: Requirement) {
  switch (r.kind) {
    case "dairy":
      return !hasDairy(d);
    case "caffeine":
      return d.caffeineMg <= r.max;
    case "budget":
      return d.price <= r.max;
    case "temperature":
      return d.served === r.want;
    case "sweet":
      return d.sugar <= r.max;
    case "nuts":
      return !hasNuts(d);
  }
}

const BASES: Omit<Drink, "milk" | "syrup" | "price" | "served">[] = [
  { name: "latte", caffeineMg: 130, sugar: 0 },
  { name: "cappuccino", caffeineMg: 130, sugar: 0 },
  { name: "mocha", caffeineMg: 140, sugar: 2 },
  { name: "chai latte", caffeineMg: 50, sugar: 2 },
  { name: "matcha latte", caffeineMg: 70, sugar: 1 },
  { name: "decaf latte", caffeineMg: 5, sugar: 0 },
  { name: "hot chocolate", caffeineMg: 10, sugar: 2 },
  { name: "golden turmeric latte", caffeineMg: 0, sugar: 1 },
  { name: "cold brew", caffeineMg: 200, sugar: 0 },
  { name: "herbal peach tea", caffeineMg: 0, sugar: 1 },
  { name: "black tea", caffeineMg: 45, sugar: 0 },
  { name: "americano", caffeineMg: 150, sugar: 0 },
];

const MILKS: Drink["milk"][] = ["whole milk", "2% milk", "oat milk", "almond milk", "no milk"];

const SYRUPS = [null, null, "vanilla syrup", "hazelnut syrup", "caramel syrup", "honey"];

const pick = <T>(xs: readonly T[], random: () => number) => xs[Math.floor(random() * xs.length)];

function drink(random: () => number): Drink {
  const base = pick(BASES, random);
  const syrup = pick(SYRUPS, random);

  const plainMilk =
    base.name.includes("tea") || base.name === "americano" || base.name === "cold brew";

  const milk = plainMilk
    ? pick(["no milk", "no milk", "oat milk", "whole milk"] as const, random)
    : pick(MILKS, random);

  // Syrup sweetens an unsweetened drink by one step.
  const sugar: Drink["sugar"] = syrup && base.sugar === 0 ? 1 : base.sugar;
  const price = Math.round((3.25 + random() * 3.5) * 4) / 4;

  return { ...base, milk, syrup, sugar, price, served: random() < 0.5 ? "hot" : "iced" };
}

const money = (v: number, random: () => number) => {
  const forms = [`$${v.toFixed(2)}`, v % 1 === 0 ? `${v} bucks` : `$${v.toFixed(2)}`];

  return pick(forms, random);
};

const WORDS = new Map([
  [4, "four"],
  [5, "five"],
  [6, "six"],
]);

/** A requirement as a structured fact, and as something a customer would say. */
type Spoken = { r: Requirement; says: string };

/** One requirement, as structured fact and as something a customer would say. */
function requirement(kind: Requirement["kind"], random: () => number): Spoken {
  switch (kind) {
    case "dairy": {
      const says = pick(
        [
          "no dairy please",
          "I'm lactose intolerant",
          "dairy-free if you can",
          "no cow's milk, oat or almond is totally fine though",
          "dairy doesn't agree with me",
          "can't do milk, the regular kind anyway",
        ],
        random,
      );

      return { r: { kind: "dairy", label: "No dairy" }, says };
    }

    case "caffeine": {
      if (random() < 0.5) {
        const says = pick(
          [
            "I'm off caffeine this month",
            "nothing with caffeine, it's late",
            "caffeine-free please, doctor's orders",
            "zero caffeine, I want to sleep tonight",
          ],
          random,
        );

        return { r: { kind: "caffeine", max: 0, label: "No caffeine" }, says };
      }

      const says = pick(
        [
          "just a little caffeine, nothing strong",
          "go easy on the caffeine, like 50 mg tops",
          "a light pick-me-up, no big jolt of caffeine",
        ],
        random,
      );

      return { r: { kind: "caffeine", max: 50, label: "50 mg of caffeine or less" }, says };
    }

    case "budget": {
      const max = pick([4, 4.5, 5, 5.5, 6], random);

      const says = pick(
        [
          `keep it under ${money(max, random)}`,
          `I've only got ${money(max, random)} on me`,
          `nothing over ${money(max, random)}, I'm broke till Friday`,
          WORDS.has(max)
            ? `under ${WORDS.get(max)} dollars if possible`
            : `${money(max, random)} max`,
        ],
        random,
      );

      return { r: { kind: "budget", max, label: `${money(max, () => 0)} or less` }, says };
    }

    case "temperature": {
      const want = random() < 0.5 ? "hot" : "iced";

      const says =
        want === "hot"
          ? pick(
              [
                "it's freezing out, something warm",
                "I want something hot",
                "need to warm my hands up",
              ],
              random,
            )
          : pick(
              ["something cold, it's like 95 out", "iced, definitely", "I want it over ice"],
              random,
            );

      return {
        r: { kind: "temperature", want, label: want === "hot" ? "Served hot" : "Served iced" },
        says,
      };
    }

    case "sweet": {
      if (random() < 0.5) {
        const says = pick(
          ["no sugar at all", "unsweetened please", "zero sugar, I'm cutting it out"],
          random,
        );

        return { r: { kind: "sweet", max: 0, label: "No sugar" }, says };
      }

      const says = pick(
        ["not too sweet", "I don't like it super sugary", "a little sweet is fine, not a dessert"],
        random,
      );

      return { r: { kind: "sweet", max: 1, label: "Not too sweet" }, says };
    }

    case "nuts": {
      const says = pick(
        [
          "I have a tree nut allergy",
          "no nuts, I'm allergic",
          "careful, I'm allergic to almonds and hazelnuts",
        ],
        random,
      );

      return { r: { kind: "nuts", label: "No tree nuts" }, says };
    }
  }
}

const KINDS: Requirement["kind"][] = [
  "dairy",
  "caffeine",
  "budget",
  "temperature",
  "sweet",
  "nuts",
];

const OPENERS = ["Hi!", "Hey there!", "Morning.", "Hello.", "Quick one.", ""];

const RETRACTABLE_KINDS = ["caffeine", "sweet", "temperature", "budget"] as const;

/** Things a customer might say and then take back, so they no longer apply. */
const RETRACTABLE: Partial<Record<Requirement["kind"], { label: string; says: string[] }>> = {
  caffeine: {
    label: "No caffeine",
    says: [
      "I'd normally skip caffeine, but today I really need it",
      "I'm supposed to be off caffeine, but not today",
    ],
  },
  sweet: {
    label: "No sugar",
    says: [
      "I usually go no sugar, but it's my birthday, so whatever",
      "normally unsweetened, but treat me today",
    ],
  },
  temperature: {
    label: "Served iced",
    says: [
      "I was thinking iced, but honestly hot or cold is fine",
      "I said iced before, forget that, either is fine",
    ],
  },
  budget: {
    label: "$4.00 or less",
    says: [
      "I said under four bucks earlier, but my boss is paying now",
      "budget doesn't matter today, it's on the company card",
    ],
  },
};

const typo = (s: string, random: () => number) => {
  if (random() > 0.2 || s.length < 12) return s;
  const i = 3 + Math.floor(random() * (s.length - 6));

  return s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
};

const card = (d: Drink) => ({
  drink: `${d.served === "iced" ? "Iced " : ""}${d.name}`,
  milk: d.milk,
  syrup: d.syrup ?? "none",
  caffeine: `${d.caffeineMg} mg`,
  sweetness: ["unsweetened", "lightly sweet", "sweet"][d.sugar],
  price: `$${d.price.toFixed(2)}`,
  served: d.served,
});

export function orderItem(seed: number): Item | null {
  const random = mulberry32(seed * 31 + 7);
  const count = 1 + Math.floor(random() * 3);
  const kinds = [...KINDS].sort(() => random() - 0.5).slice(0, count);
  const reqs = kinds.map((k) => requirement(k, random));
  const d = drink(random);
  const broken = reqs.filter((x) => !meets(d, x.r));

  // "Which requirement does it break?" needs a single answer.
  if (broken.length > 1) return null;

  // Sometimes the customer states a requirement and takes it back; it no longer applies.
  const free = RETRACTABLE_KINDS.filter((k) => !kinds.includes(k));

  const back = random() < 0.25 && free.length ? RETRACTABLE[pick(free, random)] : undefined;
  const retracted = back ? { label: back.label, says: pick(back.says, random) } : null;
  const opener = pick(OPENERS, random);
  const parts = reqs.map((x) => typo(x.says, random));

  if (retracted) parts.splice(Math.floor(random() * (parts.length + 1)), 0, retracted.says);

  const sentence = (p: string) => `${p.charAt(0).toUpperCase()}${p.slice(1)}`;
  const customer = [opener, ...parts.map((p) => `${sentence(p)}.`)].filter(Boolean).join(" ");

  // Options: every requirement mentioned (the retracted one too, so reading it is the test) and "none".
  const labels = [...reqs.map((x) => x.r.label), ...(retracted ? [retracted.label] : [])];

  const criteria = Object.fromEntries([
    ...labels.map((label, i) => [`r${i + 1}`, label]),
    ["none", "None, it meets everything the customer still wants"],
  ]);

  const brokenKey = broken.length ? `r${reqs.indexOf(broken[0]) + 1}` : "none";

  const questions: Item["questions"] = {
    meets_all: {
      type: "noul",
      instructions: "This drink meets everything the customer still wants.",
    },
    breaks: { type: "choice", instructions: "Which request does this drink break?", criteria },
  };

  const truth: Item["truth"] = { meets_all: broken.length === 0, breaks: brokenKey };
  const check = reqs[Math.floor(random() * reqs.length)];

  questions.meets_one = {
    type: "noul",
    instructions: `The drink satisfies this request of the customer's: "${check.r.label}".`,
  };
  truth.meets_one = meets(d, check.r);

  return {
    id: `order-${seed}`,
    kind: "order",
    seed,
    difficulty: (retracted ? 1 : 0) + (count >= 3 ? 1 : 0),
    state: {
      task: "A café customer said what they want, and the barista proposes the drink on the card. Judge the drink against what the customer still wants.",
      customer,
      proposed: card(d),
    },
    questions,
    truth,
  };
}
