/**
 * Decide: everyday calls a decision classifier makes, asked blind. A visitor picks first, then
 * sees how other visitors split, how each model chose, and how Jev moves when the same call is
 * set up differently: other wording, another answer shape, more context, or split into small
 * questions that code combines. Some calls have an answer fixed by how they were written (a
 * stated policy decides them); most are genuinely debatable.
 *
 * Every setup is data: the exact request a model is sent, and a combine rule that maps its
 * answers onto the visitor's options. The page shows both, so "how was this asked?" has a
 * literal answer.
 */
import type { WireQuestion } from "../checkable/items";

export type Option = { id: string; label: string };

/** How a setup's answers become a distribution over the visitor's options. */
export type Combine =
  /** One choice question whose keys are the option ids. */
  | { rule: "choice"; question: string }
  /** One yes/no: P(yes) goes to `yes`, the rest to the other option. */
  | { rule: "yes"; question: string; yes: string }
  /** One 0–2 score: each level's probability goes to that level's option. */
  | { rule: "score"; question: string; levels: string[] }
  /** One yes/no per option, renormalised. */
  | { rule: "each"; questions: Record<string, string> }
  /** Several yes/no questions: `yes` only when every one is yes (probabilities multiplied). */
  | { rule: "all"; questions: string[]; yes: string }
  /** Several yes/no questions: `yes` when any one is yes. */
  | { rule: "any"; questions: string[]; yes: string };

export type SetupGroup = "wording" | "shape" | "context" | "split";

export type Setup = {
  id: string;
  group: SetupGroup;
  label: string;
  /** Whether the request's state includes the decision's extra context. */
  withContext: boolean;
  questions: Record<string, WireQuestion>;
  combine: Combine;
};

export type Decision = {
  id: string;
  /** The question the visitor sees. */
  ask: string;
  state: Record<string, string>;
  /** Facts a real system might also have; only the context setup sends them. */
  context?: Record<string, string>;
  options: Option[];
  /** Present when a stated rule in the state decides the call. */
  truth?: { option: string; why: string };
  setups: Setup[];
};

/** A compact authoring form; `build` expands it into setups. */
type Spec = {
  id: string;
  ask: string;
  state: Record<string, string>;
  context?: Record<string, string>;
  /** Option id → label, and the criterion a model is given for it. */
  options: Record<string, [label: string, criterion: string]>;
  truth?: { option: string; why: string };
  /** The neutral instruction for the base choice question. */
  neutral: string;
  /** A wording that leans toward the first option, and a terse one. */
  leading: string;
  terse: string;
  /** For two options: a yes/no that asks about the first option. */
  yesNo?: string;
  /** For two options: a 0–2 score from the first option (0) to the second (2). */
  score?: { instructions: string; levels: [string, string, string] };
  /** Small yes/no questions that together mean the first option. */
  split?: { rule: "all" | "any"; questions: Record<string, string> };
};

function build(s: Spec): Decision {
  const ids = Object.keys(s.options);
  const [first, second] = ids;

  if (!second) throw new Error(`${s.id} needs at least two options`);

  const criteria = Object.fromEntries(ids.map((k) => [k, s.options[k][1]]));

  const choice = (instructions: string): WireQuestion => ({
    type: "choice",
    instructions,
    criteria,
  });

  const base = { rule: "choice", question: "call" } as const;

  const setups: Setup[] = [
    {
      id: "neutral",
      group: "wording",
      label: "Neutral wording",
      withContext: false,
      questions: { call: choice(s.neutral) },
      combine: base,
    },
    {
      id: "leading",
      group: "wording",
      label: "Leading wording",
      withContext: false,
      questions: { call: choice(s.leading) },
      combine: base,
    },
    {
      id: "terse",
      group: "wording",
      label: "Terse wording",
      withContext: false,
      questions: { call: choice(s.terse) },
      combine: base,
    },
  ];

  if (ids.length === 2 && s.yesNo)
    setups.push({
      id: "yes-no",
      group: "shape",
      label: "Asked as yes/no",
      withContext: false,
      questions: { call: { type: "noul", instructions: s.yesNo } },
      combine: { rule: "yes", question: "call", yes: first },
    });

  if (ids.length === 2 && s.score)
    setups.push({
      id: "score",
      group: "shape",
      label: "Asked as a 0–2 score",
      withContext: false,
      questions: {
        call: { type: "score", instructions: s.score.instructions, criteria: [...s.score.levels] },
      },
      // The middle level is a shrug: split it evenly.
      combine: { rule: "score", question: "call", levels: [first, "", second] },
    });

  if (ids.length > 2)
    setups.push({
      id: "each",
      group: "shape",
      label: "One yes/no per option",
      withContext: false,
      questions: Object.fromEntries(
        ids.map((k) => [
          k,
          { type: "noul", instructions: `"${s.neutral}" The answer is: ${s.options[k][1]}.` },
        ]),
      ),
      combine: { rule: "each", questions: Object.fromEntries(ids.map((k) => [k, k])) },
    });

  if (s.context)
    setups.push({
      id: "context",
      group: "context",
      label: "With more context",
      withContext: true,
      questions: { call: choice(s.neutral) },
      combine: base,
    });

  if (s.split)
    setups.push({
      id: "split",
      group: "split",
      label: `Split into ${Object.keys(s.split.questions).length} small questions`,
      withContext: false,
      questions: Object.fromEntries(
        Object.entries(s.split.questions).map(([k, instructions]) => [
          k,
          { type: "noul", instructions },
        ]),
      ),
      combine: { rule: s.split.rule, questions: Object.keys(s.split.questions), yes: first },
    });

  const decision: Decision = {
    id: s.id,
    ask: s.ask,
    state: s.state,
    options: ids.map((id) => ({ id, label: s.options[id][0] })),
    setups,
  };

  if (s.context) decision.context = s.context;

  if (s.truth) decision.truth = s.truth;

  return decision;
}

const SPECS: Spec[] = [
  {
    id: "deck-request",
    ask: "Does this email need a reply today?",
    state: {
      from: "Priya (design lead)",
      subject: "deck",
      body: "hey, can you send me the deck when you get a sec?",
    },
    context: { sender_calendar: "Priya presents to the board at 4 pm today", your_time: "1:30 pm" },
    options: {
      today: ["Today", "It needs a reply today"],
      later: ["It can wait", "It can wait until tomorrow or later"],
    },
    neutral: "Does this email need a reply today?",
    leading: "The sender is waiting on you. Does this email need a reply today?",
    terse: "Reply today?",
    yesNo: "This email needs a reply today.",
    score: {
      instructions: "How soon does this email need a reply?",
      levels: ["Today", "Within a couple of days", "Whenever"],
    },
    split: {
      rule: "any",
      questions: {
        deadline: "The email states or implies a deadline today.",
        blocking: "The sender is blocked until you reply.",
      },
    },
  },
  {
    id: "hot-dog",
    ask: "Is a hot dog a sandwich?",
    state: { item: "hot dog", description: "a sausage in a split bun, sometimes with toppings" },
    options: {
      yes: ["Sandwich", "It is a sandwich"],
      no: ["Not a sandwich", "It is its own thing, not a sandwich"],
    },
    neutral: "Is this food a sandwich?",
    leading: "A sandwich is a filling between bread. Is this food a sandwich?",
    terse: "Sandwich?",
    yesNo: "This food is a sandwich.",
    score: {
      instructions: "How much of a sandwich is this?",
      levels: ["Clearly a sandwich", "Sort of", "Not a sandwich"],
    },
    split: {
      rule: "all",
      questions: {
        bread: "The filling is held in bread.",
        eaten: "People eat it the way they eat a sandwich.",
        called: "People would call it a sandwich when ordering.",
      },
    },
  },
  {
    id: "lunch-note",
    ask: "Someone typed this into their phone. What should it become?",
    state: { typed: "lunch w/ sam fri?" },
    context: {
      calendar_friday: "free 12–2",
      messages_with_sam: "last message 3 weeks ago: 'we should get lunch sometime'",
    },
    options: {
      event: ["Calendar event", "A calendar event on Friday"],
      reminder: ["Reminder", "A reminder to ask Sam about lunch"],
    },
    neutral: "What should this typed note become?",
    leading: "The note names a day and a meal. What should this typed note become?",
    terse: "Event or reminder?",
    yesNo: "This note should become a calendar event.",
    score: {
      instructions: "How settled is the plan in this note?",
      levels: ["Settled: put it on the calendar", "Unclear", "Not settled: remind me to ask"],
    },
    split: {
      rule: "all",
      questions: {
        day: "The note names a specific day.",
        agreed: "The note reads as already agreed rather than a question.",
      },
    },
  },
  {
    id: "refund-policy",
    ask: "Under this policy, should the refund be approved?",
    state: {
      policy:
        "Refund if the request is within 30 days of delivery and the item is unopened. Otherwise offer store credit.",
      delivered: "September 1",
      requested: "September 28",
      customer: "Opened it once to check the colour, then resealed the box. Want my money back.",
    },
    options: {
      refund: ["Refund", "Approve the refund"],
      credit: ["Store credit", "Offer store credit instead"],
    },
    truth: {
      option: "credit",
      why: "The request is within 30 days, but the item was opened, so the policy says store credit.",
    },
    neutral: "Under the policy, should the refund be approved?",
    leading: "The customer is within 30 days. Under the policy, should the refund be approved?",
    terse: "Refund?",
    yesNo: "Under the policy, the refund should be approved.",
    score: {
      instructions: "Under the policy, what should the customer get?",
      levels: ["Refund", "Borderline", "Store credit"],
    },
    split: {
      rule: "all",
      questions: {
        window: "The request is within 30 days of delivery.",
        unopened: "The item is unopened.",
      },
    },
  },
  {
    id: "slack-ping",
    ask: "Should this notification interrupt you?",
    state: {
      app: "Slack",
      channel: "#general",
      message: "@here the coffee machine on 3 is fixed!",
    },
    context: { you: "in a focus block until 3 pm", floor: "you sit on floor 3" },
    options: { interrupt: ["Interrupt", "Show it now"], hold: ["Hold it", "Hold it for later"] },
    neutral: "Should this notification interrupt the user now?",
    leading: "It was sent with @here. Should this notification interrupt the user now?",
    terse: "Interrupt?",
    yesNo: "This notification should interrupt the user now.",
    score: {
      instructions: "How urgent is this notification?",
      levels: ["Urgent", "Somewhat", "Not at all"],
    },
    split: {
      rule: "any",
      questions: {
        action: "The message asks the user to do something soon.",
        personal: "The message is addressed to the user personally.",
      },
    },
  },
  {
    id: "bug-severity",
    ask: "How bad is this bug?",
    state: {
      report: "Checkout button does nothing on Safari 15. Works on Chrome.",
      affected: "Safari 15 users",
    },
    context: { traffic_share: "Safari 15 is 0.4% of checkout traffic", workaround: "none" },
    options: {
      blocker: ["Fix now", "A blocker: fix now"],
      normal: ["Next sprint", "Normal: schedule it"],
      minor: ["Backlog", "Minor: backlog"],
    },
    neutral: "How severe is this bug?",
    leading: "Customers cannot pay. How severe is this bug?",
    terse: "Severity?",
    split: {
      rule: "all",
      questions: { money: "The bug stops customers paying.", many: "The bug affects many users." },
    },
  },
  {
    id: "sarcasm",
    ask: "Is this review positive?",
    state: {
      product: "wireless earbuds",
      stars: "4",
      review: "Great, the left one died after a week. Love that for me.",
    },
    options: {
      positive: ["Positive", "The reviewer is happy with the product"],
      negative: ["Negative", "The reviewer is unhappy with the product"],
    },
    neutral: "Is this review positive or negative?",
    leading: "The review gave 4 stars. Is this review positive or negative?",
    terse: "Positive?",
    yesNo: "This review is positive.",
    score: {
      instructions: "How does the reviewer feel about the product?",
      levels: ["Happy", "Mixed", "Unhappy"],
    },
    split: {
      rule: "all",
      questions: {
        stars: "The star rating is high.",
        words: "The words say the product works well.",
      },
    },
  },
  {
    id: "route-policy",
    ask: "Which team gets this message? The first rule that applies wins.",
    state: {
      rules:
        "1. Anything mentioning a charge or invoice goes to Billing. 2. Anything about logging in goes to Accounts. 3. Everything else goes to Support.",
      message: "I can't log in to see my invoice from last month.",
    },
    options: {
      billing: ["Billing", "Billing"],
      accounts: ["Accounts", "Accounts"],
      support: ["Support", "Support"],
    },
    truth: { option: "billing", why: "It mentions an invoice, so rule 1 applies before rule 2." },
    neutral: "Under these rules, which team gets this message?",
    leading: "The customer cannot log in. Under these rules, which team gets this message?",
    terse: "Team?",
    split: {
      rule: "all",
      questions: {
        invoice: "The message mentions a charge or invoice.",
        first: "The rule about charges or invoices comes first.",
      },
    },
  },
  {
    id: "dinner-split",
    ask: "Is this a fair way to split the bill?",
    state: {
      plan: "Split evenly, 4 ways",
      orders: "Alex $62 (steak, 2 wines), Bo $18, Cam $21, Dee $19",
      total_with_tip: "$144",
    },
    context: { group: "close friends who eat out every week and take turns ordering big" },
    options: {
      fair: ["Fair", "Splitting evenly is fair here"],
      unfair: ["Not fair", "Each should pay closer to what they ordered"],
    },
    neutral: "Is the plan a fair way to split this bill?",
    leading: "Splitting evenly is simple and common. Is the plan a fair way to split this bill?",
    terse: "Fair?",
    yesNo: "Splitting this bill evenly is fair.",
    score: {
      instructions: "How fair is splitting this bill evenly?",
      levels: ["Fair", "Debatable", "Unfair"],
    },
    split: {
      rule: "all",
      questions: {
        close: "The orders are close in price.",
        agreed: "The group agreed to split evenly beforehand.",
      },
    },
  },
  {
    id: "plant",
    ask: "Should the plant app tell you to water today?",
    state: {
      plant: "snake plant",
      last_watered: "12 days ago",
      soil_sensor: "slightly damp",
      season: "autumn",
    },
    options: {
      water: ["Water today", "Remind the owner to water today"],
      wait: ["Wait", "Don't remind yet"],
    },
    neutral: "Should the app remind the owner to water this plant today?",
    leading: "It has been 12 days. Should the app remind the owner to water this plant today?",
    terse: "Water?",
    yesNo: "The app should remind the owner to water this plant today.",
    score: {
      instructions: "How much does this plant need water today?",
      levels: ["Needs it", "Could go either way", "Doesn't need it"],
    },
    split: {
      rule: "all",
      questions: {
        dry: "The soil is dry.",
        due: "The usual watering interval for this plant has passed.",
      },
    },
  },
  {
    id: "login-alert",
    ask: "Should this sign-in be blocked?",
    state: {
      account: "maria@",
      sign_in_from: "Lisbon, Portugal",
      device: "new iPhone",
      usual_location: "Toronto, Canada",
      time: "03:12 Toronto time",
    },
    context: { maria_calendar: "Out of office: Portugal trip, Sep 25 – Oct 5" },
    options: {
      block: ["Block it", "Block and ask Maria to confirm"],
      allow: ["Allow it", "Allow the sign-in"],
    },
    neutral: "Should this sign-in be blocked?",
    leading: "New country, new device, middle of the night. Should this sign-in be blocked?",
    terse: "Block?",
    yesNo: "This sign-in should be blocked.",
    score: {
      instructions: "How suspicious is this sign-in?",
      levels: ["Very", "Somewhat", "Not at all"],
    },
    split: {
      rule: "any",
      questions: {
        place: "The sign-in comes from an unusual place.",
        device: "The sign-in comes from an unfamiliar device.",
      },
    },
  },
  {
    id: "code-review",
    ask: "Should this review comment block the merge?",
    state: {
      comment: "nit: this variable name `d` is a bit unclear, maybe `delayMs`?",
      pr: "adds retry with backoff to the uploader",
    },
    options: {
      block: ["Block", "Request changes before merge"],
      approve: ["Approve", "Approve; fix it or not"],
    },
    neutral: "Should this review comment block the merge?",
    leading: "Unclear names cause bugs later. Should this review comment block the merge?",
    terse: "Block?",
    yesNo: "This review comment should block the merge.",
    score: {
      instructions: "How serious is this review comment?",
      levels: ["Must fix before merge", "Should fix", "Optional"],
    },
    split: {
      rule: "any",
      questions: {
        bug: "The comment points out a bug.",
        nit: "The comment is marked as required rather than a nit.",
      },
    },
  },
  {
    id: "meeting",
    ask: "Could this meeting have been an email?",
    state: {
      title: "Q4 planning sync",
      invitees: "9",
      length: "60 min",
      agenda: "Walk through the Q4 roadmap doc (already shared)",
    },
    options: {
      email: ["An email", "It could have been an email"],
      meeting: ["A meeting", "It needs a meeting"],
    },
    neutral: "Could this meeting have been an email?",
    leading: "The doc was already shared. Could this meeting have been an email?",
    terse: "Email instead?",
    yesNo: "This meeting could have been an email.",
    score: {
      instructions: "How much does this need to be a meeting?",
      levels: ["Not at all", "Somewhat", "Very much"],
    },
    split: {
      rule: "all",
      questions: {
        oneway: "The agenda is mostly sharing information one way.",
        written: "The information already exists in writing.",
      },
    },
  },
  {
    id: "expense",
    ask: "Which category is this expense?",
    state: {
      merchant: "Uber Eats",
      amount: "$38.40",
      time: "21:40",
      note: "team deadline, 3 people",
    },
    options: {
      meals: ["Team meals", "Team meals"],
      travel: ["Travel", "Travel"],
      personal: ["Personal", "Personal, not claimable"],
    },
    neutral: "Which category is this expense?",
    leading: "It is a late-night food order. Which category is this expense?",
    terse: "Category?",
    split: {
      rule: "all",
      questions: {
        food: "The expense is food.",
        team: "The expense was for work with colleagues.",
      },
    },
  },
  {
    id: "cafe-order",
    ask: "Does this drink meet everything the customer asked for?",
    state: {
      customer: "Large oat latte, extra hot. Actually make that iced. No sugar please.",
      drink: "large oat latte, iced, one pump vanilla",
    },
    options: {
      yes: ["Meets it", "It meets every request"],
      no: ["Misses something", "It misses a request"],
    },
    truth: {
      option: "no",
      why: "The customer asked for no sugar and the drink has vanilla syrup.",
    },
    neutral: "Does this drink meet everything the customer still wants?",
    leading:
      "It is a large iced oat latte, as asked. Does this drink meet everything the customer still wants?",
    terse: "Meets the order?",
    yesNo: "This drink meets everything the customer still wants.",
    score: {
      instructions: "How well does this drink match the order?",
      levels: ["Exactly", "Close", "Wrong"],
    },
    split: {
      rule: "all",
      questions: {
        size: "The size and milk match the order.",
        temp: "The temperature matches the customer's final request.",
        sugar: "The drink has no added sugar.",
      },
    },
  },
  {
    id: "birthday-text",
    ask: "What tone should this reply take?",
    state: {
      from: "your manager",
      message: "happy birthday!! 🎉 hope you're taking it easy today",
      you: "working on a launch",
    },
    options: {
      warm: ["Warm and personal", "Warm and personal"],
      brief: ["Brief thanks", "A brief, polite thanks"],
      work: ["Pivot to work", "Thanks, then an update on the launch"],
    },
    neutral: "What tone should the reply to this message take?",
    leading: "It is from your manager. What tone should the reply to this message take?",
    terse: "Tone?",
  },
  {
    id: "spam",
    ask: "Is this spam?",
    state: {
      from: "noreply@linkedin-mail.info",
      subject: "You appeared in 14 searches this week",
      body: "See who's looking at your profile → bit.ly/3xQ",
    },
    options: { spam: ["Spam", "Spam or phishing"], real: ["Real", "A genuine notification"] },
    neutral: "Is this email spam?",
    leading: "It looks like a LinkedIn notification. Is this email spam?",
    terse: "Spam?",
    yesNo: "This email is spam.",
    score: {
      instructions: "How likely is this email to be spam?",
      levels: ["Very likely", "Maybe", "Unlikely"],
    },
    split: {
      rule: "any",
      questions: {
        domain: "The sender's domain is not the company's real domain.",
        link: "The link hides where it goes.",
      },
    },
  },
  {
    id: "overtime",
    ask: "Under this policy, is this shift paid overtime?",
    state: {
      policy:
        "Hours over 40 in a Monday–Sunday week are overtime. Paid holidays count as hours worked.",
      week: "Mon holiday (8h paid), Tue 9h, Wed 9h, Thu 8h, Fri 8h",
      question: "Is any of Friday's shift overtime?",
    },
    options: {
      yes: ["Some overtime", "Part of Friday is overtime"],
      no: ["No overtime", "None of Friday is overtime"],
    },
    truth: {
      option: "yes",
      why: "8 + 9 + 9 + 8 = 34 hours before Friday, so Friday's last 2 hours pass 40.",
    },
    neutral: "Under the policy, is any of Friday's shift overtime?",
    leading: "Friday was a normal 8-hour day. Under the policy, is any of Friday's shift overtime?",
    terse: "Overtime Friday?",
    yesNo: "Under the policy, some of Friday's shift is overtime.",
    score: {
      instructions: "Under the policy, how much of Friday is overtime?",
      levels: ["Some of it", "Unclear", "None"],
    },
    split: {
      rule: "all",
      questions: {
        holiday: "The holiday counts toward the 40 hours.",
        over: "The hours before Friday plus Friday's hours exceed 40.",
      },
    },
  },
  {
    id: "kid-screen",
    ask: "Should the parental control allow this?",
    state: {
      child_age: "9",
      request: "30 more minutes of Minecraft",
      time: "7:45 pm on a Saturday",
      used_today: "1h 50m of a 2h limit",
    },
    options: { allow: ["Allow", "Allow the extra time"], deny: ["Deny", "Deny the request"] },
    neutral: "Should the parental control allow this request?",
    leading: "It's Saturday night. Should the parental control allow this request?",
    terse: "Allow?",
    yesNo: "The parental control should allow this request.",
    score: {
      instructions: "How reasonable is this request?",
      levels: ["Reasonable", "Borderline", "Unreasonable"],
    },
    split: {
      rule: "all",
      questions: {
        weekend: "It is a weekend.",
        limit: "Allowing it keeps the child within the daily limit.",
      },
    },
  },
  {
    id: "moderation",
    ask: "Should this comment be removed?",
    state: {
      site: "a cooking forum",
      comment: "This recipe is a crime against pasta. Whoever wrote it should be arrested 😂",
    },
    options: { remove: ["Remove", "Remove the comment"], keep: ["Keep", "Keep the comment"] },
    neutral: "Should this comment be removed under ordinary community rules?",
    leading:
      "The comment says someone should be arrested. Should this comment be removed under ordinary community rules?",
    terse: "Remove?",
    yesNo: "This comment should be removed.",
    score: {
      instructions: "How harmful is this comment?",
      levels: ["Harmful", "Borderline", "Harmless"],
    },
    split: {
      rule: "any",
      questions: {
        threat: "The comment threatens someone.",
        insult: "The comment insults a person rather than the recipe.",
      },
    },
  },
];

export const DECK: Decision[] = SPECS.map(build);

export const decisionIds = DECK.map((d) => d.id);

/** The request a setup sends: the decision's state, plus its context if the setup asks for it. */
export const requestFor = (d: Decision, s: Setup) => ({
  state: s.withContext && d.context ? { ...d.state, ...d.context } : d.state,
  questions: s.questions,
});
