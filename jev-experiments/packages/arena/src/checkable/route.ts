/**
 * Route items: a team's written routing policy and one incoming customer message. The message
 * is written from hidden facts (what it's about, any amount, whether the customer is upset);
 * the policy's rules are checked in order and the first that applies wins. Code applies the
 * rules to the facts; answering means reading the message and the policy, including which
 * rule takes precedence.
 */
import { rng, type Item } from "./items";

type Topic = "refund" | "security" | "outage" | "shipping" | "access" | "feature" | "billing";

type Facts = { topic: Topic; amount: number | null; upset: boolean };

type Team = "Billing" | "Security" | "Support" | "On-call" | "Shipping" | "Accounts" | "Product";

type Rule = { id: string; text: string; team: Team; applies: (f: Facts) => boolean };

const pick = <T>(xs: readonly T[], random: () => number) => xs[Math.floor(random() * xs.length)];

export function rulePool(threshold: number): Rule[] {
  return [
    {
      id: "security",
      text: "Security reports (phishing, a hacked account, a leaked password) go to Security.",
      team: "Security",
      applies: (f) => f.topic === "security",
    },
    {
      id: "big-refund",
      text: `Refund requests over $${threshold} go to Billing.`,
      team: "Billing",
      applies: (f) => f.topic === "refund" && (f.amount ?? 0) > threshold,
    },
    {
      id: "upset-outage",
      text: "If the customer is upset and the service is down for them, page On-call.",
      team: "On-call",
      applies: (f) => f.topic === "outage" && f.upset,
    },
    {
      id: "shipping",
      text: "Late, missing or damaged deliveries go to Shipping.",
      team: "Shipping",
      applies: (f) => f.topic === "shipping",
    },
    {
      id: "access",
      text: "Trouble logging in or resetting a password goes to Accounts, unless it's a security report.",
      team: "Accounts",
      applies: (f) => f.topic === "access",
    },
    {
      id: "feature",
      text: "Feature ideas and requests go to Product.",
      team: "Product",
      applies: (f) => f.topic === "feature",
    },
    {
      id: "billing",
      text: "Questions about a charge or an invoice go to Billing.",
      team: "Billing",
      // A charge nobody recognizes after a hacked account is also a question about a charge.
      applies: (f) => f.topic === "billing" || (f.topic === "security" && f.amount !== null),
    },
  ];
}

const DEFAULT: Rule = {
  id: "default",
  text: "Everything else goes to Support.",
  team: "Support",
  applies: () => true,
};

/** The first rule that applies wins. */
export function route(rules: Rule[], f: Facts) {
  return (rules.find((r) => r.applies(f)) ?? DEFAULT).team;
}

const NAMES = [
  "Maria",
  "Jake",
  "Priya",
  "Tom",
  "Keisha",
  "Luis",
  "Dana",
  "Chris",
  "Aiden",
  "Grace",
];

const cash = (v: number, random: () => number) =>
  pick(
    [`$${v}`, `${v} dollars`, `$${v}.00`, v >= 1000 ? `$${v.toLocaleString("en-US")}` : `$${v}`],
    random,
  );

const UPSET = [
  "This is ridiculous.",
  "I'm honestly furious right now.",
  "Third time I'm writing about this!!",
  "Really not happy.",
  "Can someone PLEASE fix this.",
];

const CALM = [
  "No rush, thanks!",
  "Thanks for your help.",
  "Appreciate it.",
  "Whenever you get a chance.",
  "",
];

/** A message written from the facts, without naming them. */
function message(f: Facts, random: () => number) {
  const amount = f.amount === null ? "" : cash(f.amount, random);

  const body: Record<Topic, string[]> = {
    refund: [
      `I returned the jacket two weeks ago and still haven't gotten my ${amount} back.`,
      `Please refund the ${amount} for the annual plan, I canceled on day two.`,
      `You charged me ${amount} for a class that got canceled. I'd like that money back.`,
    ],
    // With an amount, the message is also about a charge; without one, it mentions no money.
    security: f.amount
      ? [
          `Someone logged into my account from Ohio and bought stuff for ${amount}. I didn't do this.`,
          `My password showed up in some leak and now there's a ${amount} charge I don't recognize.`,
        ]
      : [
          "I got an email that looks exactly like yours asking for my password. Is that you?",
          "Somebody changed my account email and I didn't do it. I think I got hacked.",
        ],
    outage: [
      "Your site has been down for me all morning, I can't get anything done.",
      "The app just shows a spinning wheel and never loads.",
      "Nothing loads since about 9am, is something broken on your end?",
    ],
    shipping: [
      "Tracking says delivered but there's nothing on my porch.",
      "My order was supposed to arrive Tuesday and it's Friday now.",
      "The box showed up crushed and the lamp inside is broken.",
    ],
    access: [
      "The reset-password link keeps saying it expired.",
      "I can't sign in, it says my email isn't recognized but I've used it for years.",
      "Locked out after too many tries, how do I get back in?",
    ],
    feature: [
      "Would love a dark mode, my eyes hurt at night.",
      "Any chance you could add a way to export to CSV?",
      "It'd be great if I could share a list with my wife.",
    ],
    billing: [
      `What's this ${amount} charge on my statement from last week?`,
      `My invoice says ${amount} but I thought the plan was cheaper.`,
      "Can you send me a copy of my last invoice for my taxes?",
    ],
  };

  const mood = f.upset ? pick(UPSET, random) : pick(CALM, random);

  const lines = [`Hi, it's ${pick(NAMES, random)}.`, pick(body[f.topic], random), mood].filter(
    Boolean,
  );

  return lines.join(" ");
}

/** Weighted towards the topics where rule order and thresholds decide the answer. */
const TOPICS: Topic[] = [
  ...(["refund", "refund", "refund", "security", "security", "security"] as const),
  ...(["outage", "outage", "outage", "billing", "billing"] as const),
  ...(["shipping", "access", "feature"] as const),
];

export function routeItem(seed: number): Item {
  const random = rng(seed * 53 + 11);
  const threshold = pick([50, 100, 150, 200], random);
  const topic = pick(TOPICS, random);

  // Amounts near the threshold make "over $X" a real reading question; exactly $X is not over.
  const amount =
    topic === "refund" || topic === "billing" || (topic === "security" && random() < 0.7)
      ? pick([threshold - 25, threshold, threshold + 1, threshold + 40, threshold * 3, 20], random)
      : null;

  const facts: Facts = { topic, amount, upset: random() < 0.45 };

  // Three to five rules, always including the one about this message's topic where there is one.
  const pool = rulePool(threshold);

  const relevant = pool.filter(
    (r) =>
      r.applies({ ...facts, upset: true, amount: facts.amount ?? null }) ||
      r.applies({ ...facts, upset: true, amount: threshold * 10 }),
  );

  const others = pool.filter((r) => !relevant.includes(r)).sort(() => random() - 0.5);
  const count = 3 + Math.floor(random() * 3);
  const chosen = [...relevant, ...others].slice(0, count).sort(() => random() - 0.5);
  const team = route(chosen, facts);
  const teams = [...new Set([...chosen.map((r) => r.team), "Support"])];

  const policy = [
    ...chosen.map((r, i) => `${i + 1}. ${r.text}`),
    `${chosen.length + 1}. ${DEFAULT.text}`,
  ];

  const hard =
    (facts.topic === "security" && facts.amount !== null) ||
    (facts.amount !== null && Math.abs(facts.amount - threshold) <= 1) ||
    (facts.topic === "outage" && !facts.upset);

  return {
    id: `route-${seed}`,
    kind: "route",
    seed,
    difficulty: hard ? 2 : 0,
    state: {
      task: "Route the customer's message using the team's policy. Rules are checked in order; the first one that applies wins. Messages sent to Security or On-call need a person to look at them today.",
      policy,
      message: message(facts, random),
    },
    questions: {
      team: {
        type: "choice",
        instructions: "Which team should get this message?",
        criteria: Object.fromEntries(teams.map((t) => [t, t])),
      },
      today: {
        type: "noul",
        instructions: "This message needs a person to look at it today.",
      },
    },
    truth: { team, today: team === "Security" || team === "On-call" },
  };
}
