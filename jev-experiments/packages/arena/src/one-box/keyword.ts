/**
 * Shapeshift's offline keyword classifier (MIT, see NOTICE.md), restated as a table of named
 * rules. It is a contestant, so its behaviour is frozen: rules and weights are upstream's,
 * never tuned on our phrases, and a test requires the same output as upstream on every prefix
 * of 429 phrases. Readiness is not reproduced (upstream derives it from its card parsers,
 * which this port leaves out); it reads as "just started" and is not scored.
 */
import {
  INTENTS,
  optionsOf,
  type Choice,
  type Intent,
  type Option,
  type Reading,
} from "./questions.js";

// ---------------------------------------------------------------- vocabulary

const DATE_WORDS =
  /\b(today|tonight|tomorrow|tmrw|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?|next week|this week|noon|midnight|morning|evening|\d{1,2}\s?(am|pm)|\d{1,2}:\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/;

const GATHER =
  /\b(dinner|lunch|breakfast|brunch|coffee|meeting|meet|call|sync|standup|party|drinks|date|catch ?up|interview|appointment|hangout|1:1|session with|with [a-z]+)\b/;

const UNIT =
  "(km|kms|kilomet(er|re)s?|mi|miles?|m|met(er|re)s?|cm|mm|ft|feet|foot|in|inch(es)?|yd|yards?|kg|kgs|kilos?|g|grams?|lbs?|pounds?|oz|ounces?|l|lit(er|re)s?|ml|gal(lons?)?|cups?|°?c|°?f|celsius|fahrenheit|kelvin|mph|kph|km/h)";

const CONVERT_FULL = new RegExp(`\\d\\s*${UNIT}\\s+(to|in|into|as)\\s+${UNIT}\\b`);

const CONVERT_PART = new RegExp(`\\d\\s*${UNIT}\\b`);

const COLOR_WORDS =
  /\b(red|crimson|scarlet|maroon|burgundy|pink|rose|coral|salmon|peach|orange|tangerine|amber|gold|yellow|mustard|lemon|cream|beige|sand|tan|brown|chocolate|olive|lime|green|sage|mint|emerald|forest|teal|turquoise|cyan|sky|blue|navy|cobalt|indigo|violet|purple|lavender|lilac|magenta|plum|grey|gray|slate|charcoal|black|white|ivory)(ish)?\b/;

const COLOR_WORD_AT_END = new RegExp(`${COLOR_WORDS.source}\\s*$`);

/** Specific references that only mean a color: "minecraft diamond", "tiffany blue", "ruby". */
const COLOR_REFERENCES = [
  "minecraft diamond",
  "minecraft grass",
  "minecraft emerald",
  "minecraft gold",
  "minecraft redstone",
  "tiffany blue",
  "tiffany",
  "barbie pink",
  "barbie",
  "spotify green",
  "coca cola red",
  "coke red",
  "netflix red",
  "facebook blue",
  "twitter blue",
  "instagram pink",
  "discord blurple",
  "blurple",
  "starbucks green",
  "ferrari red",
  "ikea blue",
  "ikea yellow",
  "mcdonalds yellow",
  "hermes orange",
  "klein blue",
  "millennial pink",
  "matrix green",
  "shrek green",
  "minion yellow",
  "pikachu yellow",
  "pikachu",
  "hulk green",
  "smurf blue",
  "barney purple",
  "diamond",
  "ruby",
  "sapphire",
  "amethyst",
  "jade",
  "topaz",
  "pearl",
  "onyx",
  "sky blue",
  "baby blue",
  "baby pink",
  "hot pink",
  "neon green",
  "electric blue",
  "midnight blue",
  "forest green",
  "blood red",
  "brick red",
  "royal blue",
  "powder blue",
  "army green",
  "hunter green",
  "burnt orange",
  "rose gold",
  "dusty rose",
  "off white",
  "off-white",
  "terracotta",
  "denim",
  "champagne",
  "copper",
  "bronze",
  "silver",
  "blush",
];

/** Zones and cities upstream's time zone card knows. */
const ZONES = [
  "pst",
  "pdt",
  "pt",
  "san francisco",
  "sf",
  "los angeles",
  "la",
  "seattle",
  "mst",
  "denver",
  "cst",
  "chicago",
  "est",
  "edt",
  "et",
  "new york",
  "nyc",
  "toronto",
  "utc",
  "gmt",
  "london",
  "bst",
  "cet",
  "paris",
  "berlin",
  "amsterdam",
  "dubai",
  "ist",
  "india",
  "mumbai",
  "delhi",
  "bangalore",
  "bengaluru",
  "singapore",
  "sgt",
  "hong kong",
  "tokyo",
  "jst",
  "seoul",
  "sydney",
  "aest",
  "auckland",
];

const longestFirst = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length);

/** A space or hyphen inside a phrase may be either, or missing: "off white", "off-white", "offwhite". */
const flexible = (phrase: string) =>
  phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[\\s-]?");

const COLOR_REFERENCE = new RegExp(
  `\\b(${longestFirst(COLOR_REFERENCES).map(flexible).join("|")})\\b`,
  "i",
);

const ZONE_WORD = new RegExp(`\\b(${longestFirst(ZONES).join("|")})\\b`, "g");

const CLOCK = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b|\b(noon|midnight)\b/;

// ---------------------------------------------------------------- intent rules

/** What a rule sees: the lowercased text and a few facts computed once. */
type Text = { t: string; words: string[]; num: boolean; zones: number; seps: number };

type Scores = Partial<Record<Intent, number>>;

/**
 * Each rule adds weight to one intent. Order matters only where a rule reads weights added
 * before it (none do) or where upstream used else-if (kept as one rule).
 */
const RULES: [Intent, (x: Text) => number][] = [
  [
    "link",
    ({ t }) =>
      /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|dev|io|app|org|net|co|ai|in|so)\b/.test(t) ? 6 : 0,
  ],
  ["color", ({ t }) => (/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b|rgba?\(/.test(t) ? 7 : 0)],
  ["color", ({ t }) => (/#[0-9a-f]{1,5}$/.test(t) ? 3 : 0)],
  ["color", ({ t }) => (COLOR_WORDS.test(t) ? 2.5 : 0)],
  ["color", ({ t }) => (COLOR_REFERENCE.test(t) ? 4.5 : 0)],
  ["color", ({ t }) => (/\b(colou?r|shade|hue) (of|like)\b/.test(t) ? 3 : 0)],
  ["color", ({ t }) => (COLOR_WORD_AT_END.test(t) ? 1.5 : 0)],
  ["color", ({ t }) => (/\b(colou?r|shade|hue|palette|tone of)\b/.test(t) ? 2 : 0)],
  ["contact", ({ t }) => (/[\w.+-]+@[\w-]+\.\w+/.test(t) ? 5 : 0)],
  ["contact", ({ t }) => (/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{3,5}/.test(t) ? 4 : 0)],
  ["reminder", ({ t }) => (/\b(remind|reminder|don'?t forget|remember to)\b/.test(t) ? 6 : 0)],
  ["split", ({ t, num }) => (/\b(split|divide|share)\b/.test(t) ? (num ? 5 : 3) : 0)],
  [
    "split",
    ({ t, num }) => (num && /\b(between|among)\s+(\d+|two|three|four|five|six)\b/.test(t) ? 2 : 0),
  ],
  ["expense", ({ t, num }) => (/\b(spent|paid|bought|cost|expense)\b/.test(t) ? (num ? 5 : 3) : 0)],
  ["expense", ({ t }) => (/^(₹|rs\.?|\$)\s?\d/.test(t) ? 2 : 0)],
  [
    "convert",
    ({ t, words }) =>
      CONVERT_FULL.test(t)
        ? 7
        : CONVERT_PART.test(t) &&
            !/\b(min|mins|minutes?|hours?|hrs?|sec|secs?)\b/.test(t) &&
            words.length <= 3
          ? 2
          : 0,
  ],
  ["convert", ({ t }) => (/\bconvert\b/.test(t) ? 3 : 0)],
  [
    "calc",
    ({ t }) => (/^[\d\s+\-*/x×÷^().,%]+$/.test(t) && /\d\s*[+\-*/x×÷^%]\s*[\d(]/.test(t) ? 7 : 0),
  ],
  ["calc", ({ t }) => (/\d\s*%\s*(of|off)\b/.test(t) ? 6 : 0)],
  ["calc", ({ t }) => (/\b(what'?s|calculate|compute)\b.*\d/.test(t) ? 3 : 0)],
  ["timer", ({ t }) => (/\b(timer|countdown|stopwatch|pomodoro)\b/.test(t) ? 6 : 0)],
  [
    "timer",
    ({ t }) =>
      /\b\d+\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/.test(t) ? 3 : 0,
  ],
  ["timer", ({ t }) => (/\b(focus|break|rest|nap|deep work)\b/.test(t) && /\d/.test(t) ? 2.5 : 0)],
  [
    "habit",
    ({ t }) =>
      /\b(every\s*day|daily|every (morning|night|evening)|each (day|morning)|\d\s*x\s*a\s*week|times a week|habit|weekly|every (mon|tue|wed|thu|fri|sat|sun))/.test(
        t,
      )
        ? 5
        : 0,
  ],
  [
    "travel",
    ({ t }) =>
      /\b(flight|fly|flying|trip|travel|vacation|holiday|train to|bus to|road ?trip|visit|getaway)\b/.test(
        t,
      )
        ? 5
        : 0,
  ],
  [
    "travel",
    ({ t }) =>
      /\bto [a-z]+/.test(t) && /\b(next weekend|this weekend|flight|trip)\b/.test(t) ? 1 : 0,
  ],
  [
    "poll",
    ({ t }) => (/\b(or|vs)\b/.test(t) && t.endsWith("?") ? 5.5 : /\b\w+ or \w+/.test(t) ? 2 : 0),
  ],
  ["poll", ({ t }) => (/\b(poll|vote)\b/.test(t) ? 3 : 0)],
  [
    "countdown",
    ({ t }) =>
      /\b(days?|weeks?|sleeps?)\s+(until|till|til|to go|left|before)\b|\bcount ?down\b|\bhow (many days|long) (until|till|til)\b/.test(
        t,
      )
        ? 6.5
        : 0,
  ],
  [
    "timezone",
    ({ t, zones }) =>
      zones >= 2 && (CLOCK.test(t) || /\b(in|to)\b/.test(t))
        ? 7
        : zones === 1 && (CLOCK.test(t) || /\btime\b/.test(t))
          ? 5.5
          : 0,
  ],
  [
    "random",
    ({ t }) =>
      /\b(roll|flip|toss)\b|\b\d*d\d+\b|\bcoin\b|\bdice\b|\bdie\b|\brandom\b|\b(pick|choose) (one|a random|for me)\b/.test(
        t,
      )
        ? 6.5
        : 0,
  ],
  [
    "goal",
    ({ t }) =>
      /\b\d[\d,]*\s*(of|\/|out of)\s*\d[\d,]*\b/.test(t) && /[a-z]{3,}/.test(t) ? 4.5 : 0,
  ],
  ["goal", ({ t }) => (/\b(goal|target)\b/.test(t) ? 3 : 0)],
  [
    "goal",
    ({ t }) =>
      /\b(done|so far|saved|completed|finished)\b/.test(t) && /\d/.test(t)
        ? (t.match(/\d+/g)?.length ?? 0) >= 2
          ? 5
          : 2.5
        : 0,
  ],
  [
    "todo",
    ({ t, seps }) =>
      seps >= 2 ? 4 : seps === 1 && /^(buy|get|todo|to do|groceries)\b/.test(t) ? 3 : 0,
  ],
  ["todo", ({ t }) => (/^(buy|get|pick up|grab)\b/.test(t) ? 2 : 0)],
  [
    "event",
    ({ t, words }) => (DATE_WORDS.test(t) ? (GATHER.test(t) || words.length <= 6 ? 2.5 : 1) : 0),
  ],
  ["event", ({ t }) => (GATHER.test(t) ? 3 : 0)],
  ["event", ({ t }) => (/\b(on|over|via) (zoom|meet|teams|facetime)\b/.test(t) ? 2 : 0)],
  [
    "note",
    ({ t }) =>
      /\b(i think|i feel|felt|feeling|thinking|wonder|realized|idea|thought|maybe we)\b/.test(t)
        ? 2
        : 0,
  ],
  [
    "note",
    ({ words }) => (words.length >= 8 ? 3 : words.length >= 5 ? 2.2 : words.length >= 3 ? 1 : 0),
  ],
  ["none", ({ t, words, num }) => (t.length < 3 ? 8 : words.length === 1 && !num ? 3 : 0.5)],
];

/**
 * When one intent is clearly signalled, others its criteria exclude are capped:
 * [intent, at least, [[capped intent, cap], …]].
 */
const EXCLUSIONS: [Intent, number, [Intent, number][]][] = [
  ["split", 5, [["calc", 1]]],
  ["convert", 7, [["calc", 1]]],
  [
    "reminder",
    6,
    [
      ["event", 2.5],
      ["habit", 2],
    ],
  ],
  ["habit", 5, [["event", 2]]],
  ["travel", 5, [["event", 2]]],
  ["poll", 5, [["event", 2]]],
  ["contact", 4, [["timer", 0]]],
  ["timer", 3, [["convert", 1]]],
  ["link", 6, [["note", 0]]],
  ["countdown", 6, [["event", 2]]],
  [
    "timezone",
    5.5,
    [
      ["event", 2],
      ["convert", 1],
      ["timer", 1],
    ],
  ],
  [
    "random",
    6,
    [
      ["poll", 2],
      ["calc", 1],
      ["convert", 1],
    ],
  ],
  ["goal", 4.5, [["calc", 1]]],
];

function intentScores(raw: string): Scores {
  const t = raw.toLowerCase().trim();

  const x: Text = {
    t,
    words: t.split(/\s+/).filter(Boolean),
    num: /\d/.test(t),
    zones: t.match(ZONE_WORD)?.length ?? 0,
    seps: (t.match(/,|\band\b|&|\n/g) ?? []).length,
  };

  const s: Scores = {};

  for (const [intent, rule] of RULES) {
    const w = rule(x);

    if (w) s[intent] = (s[intent] ?? 0) + w;
  }

  for (const [intent, atLeast, caps] of EXCLUSIONS)
    if ((s[intent] ?? 0) >= atLeast)
      for (const [capped, cap] of caps)
        // Upstream sets contact's timer to 0 and link's note to 0 outright; min() with 0 is the same.
        s[capped] = Math.min(s[capped] ?? 0, cap);

  return s;
}

function softmax(scores: Scores, temperature: number) {
  const exps = INTENTS.map((k) => Math.exp((scores[k] ?? 0) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);

  const out: Partial<Record<Intent, number>> = {};

  INTENTS.forEach((k, i) => (out[k] = exps[i] / sum));

  return out;
}

// ---------------------------------------------------------------- signals

/** The chosen option at `confidence`, the rest sharing what is left. */
function pick<T extends string>(options: T[], value: T, confidence: number): Choice<T> {
  const rest = (1 - confidence) / Math.max(1, options.length - 1);

  const probabilities: Partial<Record<T, number>> = {};

  for (const v of options) probabilities[v] = v === value ? confidence : rest;

  return { value, confidence, probabilities };
}

/** The first matching rule's option at 0.86, or the fallback at 0.74. */
const SIGNAL_RULES = {
  tone: {
    fallback: "neutral",
    rules: [
      [/\b(worried|stressed|anxious|ugh|deadline|panic|tired|frustrat)/, "stressed"],
      [/\b(can'?t wait|excited|yay|so pumped|!{1,}$)/, "excited"],
      [/\b(grateful|happy|love|thankful|glad|great)\b/, "positive"],
      [/\b(wonder|thinking about|realized|reflect|maybe|lately|i think)\b/, "reflective"],
    ],
  },
  eventMode: {
    fallback: "unspecified",
    rules: [
      [/\b(zoom|meet|teams|facetime|video|skype|discord)\b/, "video_call"],
      [/\b(phone|call|ring)\b/, "phone_call"],
      [/\b(dinner|lunch|breakfast|coffee|drinks|party|at [a-z]+)\b/, "in_person"],
    ],
  },
  transport: {
    fallback: "unspecified",
    rules: [
      [/\b(flight|fly|flying|plane|airport)\b/, "flight"],
      [/\b(train|rail)\b/, "train"],
      [/\b(bus|coach)\b/, "bus"],
      [/\b(drive|car|road ?trip)\b/, "car"],
    ],
  },
  tripType: {
    fallback: "unspecified",
    rules: [
      [/\b(work|business|conference|client|offsite|meeting)\b/, "work"],
      [/\b(vacation|holiday|beach|getaway|leisure|visit|weekend)\b/, "leisure"],
    ],
  },
  expenseCategory: {
    fallback: "other",
    rules: [
      [/\b(uber|ola|cab|taxi|fuel|petrol|metro|bus|train|auto|parking)\b/, "transport"],
      [
        /\b(food|lunch|dinner|breakfast|coffee|groceries|swiggy|zomato|pizza|restaurant|drinks)\b/,
        "food",
      ],
      [/\b(rent|electricity|wifi|internet|bill|recharge|netflix|spotify|subscription)\b/, "bills"],
      [/\b(movie|concert|game|tickets?|show)\b/, "entertainment"],
      [/\b(medicine|doctor|pharmacy|gym|hospital)\b/, "health"],
      [/\b(shoes|shirt|clothes|amazon|phone|laptop|headphones|gift)\b/, "shopping"],
    ],
  },
  colorMood: {
    fallback: "neutral",
    rules: [
      [/\b(pastel|soft|pale|baby|light)\b/, "pastel"],
      [/\b(dark|deep|midnight|navy)\b/, "dark"],
      [/\b(neon|vivid|bright|electric|hot)\b/, "vivid"],
      [/\b(warm|sunset|fire|red|orange|yellow|amber|coral|peach|gold)\b/, "warm"],
      [/\b(cool|ocean|sea|sky|blue|green|teal|purple|mint|ice)\b/, "cool"],
      [/\b(grey|gray|beige|sand|stone|neutral|cream)\b/, "neutral"],
    ],
  },
  timerKind: {
    fallback: "countdown",
    rules: [
      [/\b(focus|pomodoro|deep work|study|work)\b/, "focus"],
      [/\b(break|rest|nap|breather)\b/, "break"],
      [/\b(stopwatch|count up)\b/, "stopwatch"],
    ],
  },
} satisfies { [K in SignalId]: { fallback: Option<K>; rules: [RegExp, Option<K>][] } };

type SignalId =
  | "tone"
  | "eventMode"
  | "transport"
  | "tripType"
  | "expenseCategory"
  | "colorMood"
  | "timerKind";

function signal<K extends SignalId>(id: K, t: string): Choice<Option<K>> {
  // SAFETY: SIGNAL_RULES `satisfies` this shape for every signal id, so the entry for K has it.
  const { fallback, rules } = SIGNAL_RULES[id] as {
    fallback: Option<K>;
    rules: [RegExp, Option<K>][];
  };

  const hit = rules.find(([re]) => re.test(t));

  return hit ? pick(optionsOf(id), hit[1], 0.86) : pick(optionsOf(id), fallback, 0.74);
}

// ---------------------------------------------------------------- the classifier

export function keyword(text: string): Reading {
  const t = text.toLowerCase().trim();
  const neutral = t.length < 2;

  const probabilities: Partial<Record<Intent, number>> = neutral
    ? { none: 1 }
    : softmax(intentScores(t), 0.8);

  const top = neutral
    ? "none"
    : INTENTS.reduce((a, b) => ((probabilities[b] ?? 0) > (probabilities[a] ?? 0) ? b : a));

  const urgent = /\b(urgent|asap|immediately|right now|important|critical|!!)/.test(t);
  const soon = /\b(today|tonight|soon|by \d|deadline|tomorrow)\b/.test(t);

  const choose = <K extends SignalId>(id: K, fallbackWhenNeutral: Option<K>) =>
    neutral
      ? { value: fallbackWhenNeutral, confidence: 1, probabilities: { [fallbackWhenNeutral]: 1 } }
      : signal(id, t);

  return {
    intent: { value: top, confidence: probabilities[top] ?? 1, probabilities },
    readiness: { score: 0, confidence: 0 },
    isQuestion: neutral
      ? 0
      : /\?\s*$|^(what|why|how|when|where|who|should|could|would|is|are|do|does|can)\b/.test(t)
        ? 0.9
        : 0.06,
    recurring: neutral
      ? 0
      : /\b(every|daily|weekly|monthly|each (day|week|morning)|\dx a week|times a week|repeat)/.test(
            t,
          )
        ? 0.88
        : 0.08,
    urgency: neutral
      ? { score: 0, confidence: 1 }
      : { score: urgent ? 1.75 : soon ? 0.9 : 0.2, confidence: 0.8 },
    tone: choose("tone", "neutral"),
    eventMode: choose("eventMode", "unspecified"),
    transport: choose("transport", "unspecified"),
    tripType: choose("tripType", "unspecified"),
    expenseCategory: choose("expenseCategory", "other"),
    colorMood: choose("colorMood", "neutral"),
    timerKind: choose("timerKind", "countdown"),
    hasExplicitOptions: neutral ? 0 : /\b\w+\s+(or|vs)\s+\w+/.test(t) ? 0.9 : 0.05,
    isShoppingList: neutral
      ? 0
      : /\b(buy|get|groceries|shopping|milk|eggs|bread|coffee|pick up|order)\b/.test(t)
        ? 0.88
        : 0.1,
  };
}
