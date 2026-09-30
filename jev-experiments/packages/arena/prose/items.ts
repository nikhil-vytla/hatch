/**
 * Prose studies: the content that stays fixed while the form varies.
 *
 * Every item is authored once. `variants.ts` turns each item into dozens of requests that ask
 * the same thing in other words, languages, layouts or answer shapes. Where an item has a right
 * answer it follows from the stated facts (or common knowledge) and is written in `truth`;
 * truths are never sent.
 */

export type Fact = [label: string, value: string];

/** A yes/no decision about stated facts. `claim` and `claimNeg` are lower-case clauses. */
export type ClaimItem = {
  id: string;
  kind: string;
  /** Absent for the ambiguous items. */
  truth?: boolean;
  facts: Fact[];
  /** The same facts as sentences, values kept verbatim. */
  prose: string;
  /** Irrelevant facts for the distractor variant. */
  distractors: Fact[];
  question: string;
  claim: string;
  claimNeg: string;
  /** The question with the other voice (passive ↔ active). */
  voice: string;
  /** The question with synonyms swapped in. */
  synonym: string;
  terse: string;
};

export const TRUTH_ITEMS: ClaimItem[] = [
  {
    id: "parcel",
    kind: "threshold",
    truth: true,
    facts: [
      ["Parcel weight", "3.2 kg"],
      ["Destination", "Leeds"],
      ["Standard shipping weight limit", "5 kg"],
    ],
    prose:
      "The parcel weighs 3.2 kg and is going to Leeds. Standard shipping accepts parcels up to 5 kg.",
    distractors: [
      ["Sender", "Harlow Books Ltd"],
      ["Tracking code", "HB-44817"],
      ["Packaging", "cardboard box"],
      ["Insured value", "£60"],
      ["Label printed", "yes"],
    ],
    question: "Is the parcel within the standard shipping weight limit?",
    claim: "the parcel is within the standard shipping weight limit",
    claimNeg: "the parcel is not within the standard shipping weight limit",
    voice: "Is the parcel's weight permitted by the standard shipping limit?",
    synonym: "Does the package fall under the weight cap for regular delivery?",
    terse: "Parcel under standard weight limit?",
  },
  {
    id: "refund",
    kind: "dates",
    truth: false,
    facts: [
      ["Purchase date", "2026-08-02"],
      ["Refund request date", "2026-09-10"],
      ["Refund window", "30 days from purchase"],
      ["Item condition", "unopened"],
    ],
    prose:
      "The customer bought the item on 2026-08-02 and asked for a refund on 2026-09-10. The item is unopened. Refunds are allowed within 30 days from purchase.",
    distractors: [
      ["Order number", "A-20931"],
      ["Payment method", "card"],
      ["Store branch", "Riverside"],
      ["Customer since", "2019"],
      ["Loyalty tier", "Silver"],
    ],
    question: "Is the customer eligible for a refund?",
    claim: "the customer is eligible for a refund",
    claimNeg: "the customer is not eligible for a refund",
    voice: "Can a refund be granted to the customer under the policy?",
    synonym: "Does the buyer qualify to get their money back?",
    terse: "Refund eligible?",
  },
  {
    id: "rental",
    kind: "threshold",
    truth: false,
    facts: [
      ["Driver age", "23"],
      ["Minimum age to rent a car", "25"],
      ["Years with a driving licence", "5"],
    ],
    prose:
      "The driver is 23 and has had a driving licence for 5 years. The minimum age to rent a car is 25.",
    distractors: [
      ["Pickup location", "Airport Terminal 2"],
      ["Car class", "compact"],
      ["Rental length", "4 days"],
      ["Insurance", "basic"],
      ["Loyalty number", "88213"],
    ],
    question: "Is the driver old enough to rent a car?",
    claim: "the driver is old enough to rent a car",
    claimNeg: "the driver is not old enough to rent a car",
    voice: "Can a car be rented by the driver, given the minimum age?",
    synonym: "Does the motorist meet the age requirement for hiring a vehicle?",
    terse: "Driver meets rental age?",
  },
  {
    id: "cart",
    kind: "arithmetic",
    truth: true,
    facts: [
      ["Laptop stand", "$45"],
      ["Keyboard", "$79"],
      ["Mouse", "$32"],
      ["Budget", "$160"],
    ],
    prose:
      "The cart holds a laptop stand for $45, a keyboard for $79 and a mouse for $32. The budget is $160.",
    distractors: [
      ["Shipping", "free"],
      ["Store", "TechMart"],
      ["Order ID", "55-0192"],
      ["Warranty", "1 year"],
      ["Coupon", "none"],
    ],
    question: "Do the three items together fit within the budget?",
    claim: "the three items together fit within the budget",
    claimNeg: "the three items together do not fit within the budget",
    voice: "Is the total cost of the three items covered by the budget?",
    synonym: "Is the combined price of the three products affordable on this spending limit?",
    terse: "Items within budget?",
  },
  {
    id: "hotel",
    kind: "arithmetic",
    truth: false,
    facts: [
      ["Nightly rate", "$210"],
      ["Number of nights", "3"],
      ["Hotel budget for the trip", "$600"],
    ],
    prose: "The hotel costs $210 per night for 3 nights. The hotel budget for the trip is $600.",
    distractors: [
      ["City", "Lisbon"],
      ["Room type", "double"],
      ["Breakfast", "included"],
      ["Check-in", "15:00"],
      ["Booking reference", "LX7730"],
    ],
    question: "Does the hotel stay fit within the budget?",
    claim: "the hotel stay fits within the budget",
    claimNeg: "the hotel stay does not fit within the budget",
    voice: "Is the cost of the hotel stay covered by the budget?",
    synonym: "Can the lodging be paid for without going over the spending limit?",
    terse: "Hotel within budget?",
  },
  {
    id: "meetings",
    kind: "time",
    truth: true,
    facts: [
      ["Meeting A", "14:00 to 15:00"],
      ["Meeting B", "14:30 to 15:30"],
      ["Day of both meetings", "Tuesday"],
    ],
    prose: "Meeting A runs from 14:00 to 15:00 and Meeting B from 14:30 to 15:30, both on Tuesday.",
    distractors: [
      ["Meeting A organiser", "Priya"],
      ["Meeting B organiser", "Tom"],
      ["Meeting A topic", "budget review"],
      ["Meeting B topic", "hiring"],
      ["Video link", "yes"],
    ],
    question: "Do the two meetings overlap?",
    claim: "the two meetings overlap",
    claimNeg: "the two meetings do not overlap",
    voice: "Is part of Meeting B's time taken up by Meeting A?",
    synonym: "Do the two appointments clash?",
    terse: "Meetings overlap?",
  },
  {
    id: "deadline",
    kind: "time",
    truth: false,
    facts: [
      ["Deadline", "Friday 17:00"],
      ["Submitted by", "the design team"],
      ["Submission time", "Friday 18:00"],
    ],
    prose: "The deadline is Friday 17:00. The design team submitted the task on Friday 18:00.",
    distractors: [
      ["Task", "Q3 report"],
      ["Pages", "14"],
      ["Reviewer", "Dana"],
      ["Format", "PDF"],
      ["Priority", "medium"],
    ],
    question: "Was the task submitted before the deadline?",
    claim: "the task was submitted before the deadline",
    claimNeg: "the task was not submitted before the deadline",
    voice: "Did the design team submit the task before the deadline?",
    synonym: "Was the assignment handed in ahead of the cutoff?",
    terse: "Submitted on time?",
  },
  {
    id: "weather",
    kind: "comparison",
    truth: true,
    facts: [
      ["Oslo high today", "12 °C"],
      ["Madrid high today", "27 °C"],
    ],
    prose: "Today's high is 12 °C in Oslo and 27 °C in Madrid.",
    distractors: [
      ["Oslo humidity", "70%"],
      ["Madrid wind", "8 km/h"],
      ["Oslo sunrise", "07:12"],
      ["Madrid UV index", "5"],
      ["Forecast source", "MetNet"],
    ],
    question: "Is Madrid warmer than Oslo today?",
    claim: "Madrid is warmer than Oslo today",
    claimNeg: "Madrid is not warmer than Oslo today",
    voice: "Is a higher temperature being recorded in Madrid than in Oslo today?",
    synonym: "Is it hotter in Madrid than in Oslo today?",
    terse: "Madrid warmer than Oslo?",
  },
  {
    id: "guide-dog",
    kind: "exception",
    truth: true,
    facts: [
      ["Cafe policy", "No dogs allowed, except guide dogs"],
      ["Visitor", "arrives with her guide dog"],
    ],
    prose: "The cafe's policy is: no dogs allowed, except guide dogs. A visitor arrives with her guide dog.",
    distractors: [
      ["Cafe name", "Bean There"],
      ["Opening time", "07:00"],
      ["Visitor's order", "flat white"],
      ["Table number", "6"],
      ["Weather", "sunny"],
    ],
    question: "Is the visitor's dog allowed in the cafe?",
    claim: "the visitor's dog is allowed in the cafe",
    claimNeg: "the visitor's dog is not allowed in the cafe",
    voice: "Does the cafe allow the visitor's dog in?",
    synonym: "Is the guest's dog permitted inside the coffee shop?",
    terse: "Dog allowed?",
  },
  {
    id: "delivery",
    kind: "exception",
    truth: false,
    facts: [
      ["Delivery policy", "Free delivery on orders over $50, except furniture"],
      ["Order", "one sofa"],
      ["Order total", "$400"],
    ],
    prose:
      "The delivery policy is: free delivery on orders over $50, except furniture. The order is one sofa, and the order total is $400.",
    distractors: [
      ["Colour", "grey"],
      ["Customer city", "Denver"],
      ["Order day", "Monday"],
      ["Payment", "card"],
      ["Assembly required", "no"],
    ],
    question: "Does the order get free delivery?",
    claim: "the order gets free delivery",
    claimNeg: "the order does not get free delivery",
    voice: "Will free delivery be applied to the order?",
    synonym: "Does this purchase qualify for complimentary shipping?",
    terse: "Free delivery?",
  },
  {
    id: "training",
    kind: "quantifier",
    truth: false,
    facts: [
      ["Ana", "training complete"],
      ["Ben", "training complete"],
      ["Chen", "training pending"],
      ["Dita", "training complete"],
    ],
    prose:
      "The team is Ana, Ben, Chen and Dita. Ana, Ben and Dita have completed the training; Chen's training is pending.",
    distractors: [
      ["Team name", "Platform"],
      ["Manager", "Rui"],
      ["Course length", "2 hours"],
      ["Course topic", "data privacy"],
      ["Office", "Berlin"],
    ],
    question: "Has every team member completed the training?",
    claim: "every team member has completed the training",
    claimNeg: "not every team member has completed the training",
    voice: "Has the training been completed by every team member?",
    synonym: "Has each person on the team finished the course?",
    terse: "Whole team trained?",
  },
  {
    id: "batches",
    kind: "quantifier",
    truth: true,
    facts: [
      ["Batch 1", "pass"],
      ["Batch 2", "fail"],
      ["Batch 3", "pass"],
    ],
    prose: "Three batches were tested. Batch 1 passed, batch 2 failed and batch 3 passed.",
    distractors: [
      ["Product", "bottled water"],
      ["Lab", "Northside"],
      ["Tester", "K. Obi"],
      ["Test type", "pH"],
      ["Test date", "2026-09-01"],
    ],
    question: "Did at least one batch fail the test?",
    claim: "at least one batch failed the test",
    claimNeg: "no batch failed the test",
    voice: "Was a failing result given to at least one batch?",
    synonym: "Did any of the lots flunk the inspection?",
    terse: "Any batch failed?",
  },
  {
    id: "dolphin",
    kind: "knowledge",
    truth: true,
    facts: [
      ["Animal", "dolphin"],
      ["Habitat", "ocean"],
      ["Diet", "fish"],
    ],
    prose: "The animal is a dolphin. It lives in the ocean and eats fish.",
    distractors: [
      ["Observed near", "the Azores"],
      ["Group size", "12"],
      ["Observer", "Dr. Lind"],
      ["Time of sighting", "06:40"],
      ["Water temperature", "19 °C"],
    ],
    question: "Is the animal a mammal?",
    claim: "the animal is a mammal",
    claimNeg: "the animal is not a mammal",
    voice: "Is the animal classified by biologists as a mammal?",
    synonym: "Does the creature belong to the mammals?",
    terse: "Mammal?",
  },
  {
    id: "capital",
    kind: "knowledge",
    truth: false,
    facts: [
      ["City", "Sydney"],
      ["Country", "Australia"],
      ["Population", "about 5 million"],
    ],
    prose: "The city is Sydney, in Australia. About 5 million people live there.",
    distractors: [
      ["Famous landmark", "the Opera House"],
      ["Time zone", "AEST"],
      ["Airport code", "SYD"],
      ["Harbour", "yes"],
      ["Founded", "1788"],
    ],
    question: "Is the city the capital of its country?",
    claim: "the city is the capital of its country",
    claimNeg: "the city is not the capital of its country",
    voice: "Is the city recognised by its country as the capital?",
    synonym: "Is this city its nation's seat of government?",
    terse: "Capital city?",
  },
  {
    id: "race",
    kind: "comparison",
    truth: true,
    facts: [
      ["Race", "10 km"],
      ["Kim's finish time", "41:10"],
      ["Lee's finish time", "39:55"],
      ["Mo's finish time", "42:30"],
    ],
    prose: "In a 10 km race, Kim finished in 41:10, Lee in 39:55 and Mo in 42:30.",
    distractors: [
      ["Weather", "cool"],
      ["Course city", "Bristol"],
      ["Kim's bib number", "204"],
      ["Lee's bib number", "318"],
      ["Start time", "09:00"],
    ],
    question: "Did Lee finish ahead of Kim?",
    claim: "Lee finished ahead of Kim",
    claimNeg: "Lee did not finish ahead of Kim",
    voice: "Was Kim beaten by Lee?",
    synonym: "Did Lee cross the line before Kim?",
    terse: "Lee beat Kim?",
  },
  {
    id: "survey",
    kind: "arithmetic",
    truth: false,
    facts: [
      ["Respondents", "400"],
      ["Respondents who said yes", "180"],
    ],
    prose: "The survey had 400 respondents, and 180 of them said yes.",
    distractors: [
      ["Survey topic", "a new park"],
      ["Conducted by", "the City Council"],
      ["Method", "online"],
      ["Month", "June"],
      ["Margin of error", "5%"],
    ],
    question: "Did a majority of respondents say yes?",
    claim: "a majority of respondents said yes",
    claimNeg: "a majority of respondents did not say yes",
    voice: "Was yes said by a majority of respondents?",
    synonym: "Did more than half of those surveyed answer yes?",
    terse: "Majority yes?",
  },
  {
    id: "shelf",
    kind: "units",
    truth: true,
    facts: [
      ["Shelf length", "2 m"],
      ["Total width of the books", "150 cm"],
    ],
    prose: "The shelf is 2 m long. Side by side, the books are 150 cm wide in total.",
    distractors: [
      ["Shelf material", "oak"],
      ["Number of books", "23"],
      ["Room", "study"],
      ["Shelf colour", "white"],
      ["Installed", "last spring"],
    ],
    question: "Do the books fit on the shelf side by side?",
    claim: "the books fit on the shelf side by side",
    claimNeg: "the books do not fit on the shelf side by side",
    voice: "Can the books be fitted on the shelf side by side?",
    synonym: "Is there enough room on the shelf for the books in a row?",
    terse: "Books fit shelf?",
  },
  {
    id: "password",
    kind: "counting",
    truth: false,
    facts: [
      ["Password rule", "at least 12 characters, including a number"],
      ["Proposed password", "sunflower88"],
    ],
    prose:
      "The password rule is: at least 12 characters, including a number. The proposed password is sunflower88.",
    distractors: [
      ["Username", "jkim"],
      ["Account type", "staff"],
      ["Last changed", "2025-11-03"],
      ["Two-factor", "enabled"],
      ["System", "HR portal"],
    ],
    question: "Does the proposed password meet the rule?",
    claim: "the proposed password meets the rule",
    claimNeg: "the proposed password does not meet the rule",
    voice: "Is the rule satisfied by the proposed password?",
    synonym: "Does the suggested passphrase satisfy the requirement?",
    terse: "Password valid?",
  },
  {
    id: "store",
    kind: "time",
    truth: true,
    facts: [
      ["Store hours", "Monday to Saturday 09:00 to 18:00, closed Sunday"],
      ["Visit time", "Saturday 10:30"],
    ],
    prose:
      "The store is open Monday to Saturday 09:00 to 18:00 and closed Sunday. The visit is on Saturday 10:30.",
    distractors: [
      ["Store name", "Corner Hardware"],
      ["Address", "12 Elm Street"],
      ["Parking", "available"],
      ["Manager", "Lou"],
      ["Founded", "1998"],
    ],
    question: "Is the store open at the time of the visit?",
    claim: "the store is open at the time of the visit",
    claimNeg: "the store is not open at the time of the visit",
    voice: "Is the store kept open at the time of the visit?",
    synonym: "Will the shop be trading when the customer arrives?",
    terse: "Open then?",
  },
  {
    id: "stock",
    kind: "threshold",
    truth: false,
    facts: [
      ["Units in stock", "14"],
      ["Units ordered", "20"],
      ["Backorders allowed", "no"],
    ],
    prose: "There are 14 units in stock and 20 units ordered. Backorders are not allowed.",
    distractors: [
      ["SKU", "TB-220"],
      ["Warehouse", "Leeds"],
      ["Supplier", "Norrin"],
      ["Unit price", "$12"],
      ["Aisle", "7"],
    ],
    question: "Can the order be filled from current stock?",
    claim: "the order can be filled from current stock",
    claimNeg: "the order cannot be filled from current stock",
    voice: "Can the warehouse fill the order from current stock?",
    synonym: "Is there enough inventory on hand to fulfil the purchase?",
    terse: "Stock covers order?",
  },
];

/** Debatable calls: no right answer, so only shifts and invariances are measured. */
export const AMBIGUOUS_ITEMS: ClaimItem[] = [
  {
    id: "hot-dog",
    kind: "category",
    facts: [["Food", "a hot dog: a sausage served in a split bun"]],
    prose: "The food is a hot dog: a sausage served in a split bun.",
    distractors: [],
    question: "Is a hot dog a sandwich?",
    claim: "a hot dog is a sandwich",
    claimNeg: "a hot dog is not a sandwich",
    voice: "Is a hot dog classed as a sandwich?",
    synonym: "Does a hot dog count as a sub?",
    terse: "Hot dog = sandwich?",
  },
  {
    id: "cereal",
    kind: "category",
    facts: [["Food", "breakfast cereal in a bowl of cold milk"]],
    prose: "The food is breakfast cereal in a bowl of cold milk.",
    distractors: [],
    question: "Is cereal with milk a soup?",
    claim: "cereal with milk is a soup",
    claimNeg: "cereal with milk is not a soup",
    voice: "Should cereal with milk be classed as a soup?",
    synonym: "Does cereal in milk count as a broth?",
    terse: "Cereal = soup?",
  },
  {
    id: "late-guest",
    kind: "etiquette",
    facts: [
      ["Event", "a dinner party at a friend's home, starting at 19:00"],
      ["Guest arrival", "19:20, without sending a message"],
    ],
    prose:
      "The event is a dinner party at a friend's home, starting at 19:00. The guest arrived at 19:20, without sending a message.",
    distractors: [],
    question: "Was the guest rude?",
    claim: "the guest was rude",
    claimNeg: "the guest was not rude",
    voice: "Was the host treated rudely by the guest?",
    synonym: "Was the guest impolite?",
    terse: "Guest rude?",
  },
  {
    id: "late-refund",
    kind: "policy",
    facts: [
      ["Purchase", "headphones, 32 days ago"],
      ["Refund window", "30 days"],
      ["Customer", "has shopped here for 6 years"],
      ["Item condition", "unopened"],
    ],
    prose:
      "The customer bought headphones 32 days ago; the refund window is 30 days. The customer has shopped here for 6 years, and the item is unopened.",
    distractors: [],
    question: "Should the store give the refund?",
    claim: "the store should give the refund",
    claimNeg: "the store should not give the refund",
    voice: "Should the refund be given by the store?",
    synonym: "Ought the shop to hand the money back?",
    terse: "Refund it?",
  },
  {
    id: "escalate",
    kind: "triage",
    facts: [
      [
        "Support ticket",
        "App crashes sometimes when I upload big photos. Annoying, but I can work around it.",
      ],
    ],
    prose:
      "A support ticket says: App crashes sometimes when I upload big photos. Annoying, but I can work around it.",
    distractors: [],
    question: "Should the ticket be escalated to engineering?",
    claim: "the ticket should be escalated to engineering",
    claimNeg: "the ticket should not be escalated to engineering",
    voice: "Should support escalate the ticket to engineering?",
    synonym: "Ought the request to be passed up to the developers?",
    terse: "Escalate?",
  },
  {
    id: "remote-work",
    kind: "policy",
    facts: [
      ["Request", "work from home 3 days a week"],
      ["Role", "accountant"],
      ["Team", "works in the office every day"],
    ],
    prose:
      "An accountant asks to work from home 3 days a week. The rest of the team works in the office every day.",
    distractors: [],
    question: "Should the manager approve the request?",
    claim: "the manager should approve the request",
    claimNeg: "the manager should not approve the request",
    voice: "Should the request be approved by the manager?",
    synonym: "Ought the boss to grant the request?",
    terse: "Approve?",
  },
  {
    id: "no-tip",
    kind: "etiquette",
    facts: [
      ["Service", "slow but friendly"],
      ["Bill", "$80, at a restaurant in the United States"],
    ],
    prose: "At a restaurant in the United States the service was slow but friendly. The bill was $80.",
    distractors: [],
    question: "Is leaving no tip acceptable?",
    claim: "leaving no tip is acceptable",
    claimNeg: "leaving no tip is not acceptable",
    voice: "Can leaving no tip be accepted?",
    synonym: "Is it okay to skip the gratuity?",
    terse: "No tip OK?",
  },
  {
    id: "renewal-email",
    kind: "triage",
    facts: [
      ["Email", "Hi! Your subscription renews tomorrow. Click here to manage it."],
      ["Sender", "an address at an unfamiliar domain"],
    ],
    prose:
      "An email from an address at an unfamiliar domain says: Hi! Your subscription renews tomorrow. Click here to manage it.",
    distractors: [],
    question: "Is the email spam?",
    claim: "the email is spam",
    claimNeg: "the email is not spam",
    voice: "Should the email be classed as spam?",
    synonym: "Is the message junk mail?",
    terse: "Spam?",
  },
  {
    id: "meh-review",
    kind: "sentiment",
    facts: [["Review", "The food was fine, nothing special. Service was quick."]],
    prose: "A review says: The food was fine, nothing special. Service was quick.",
    distractors: [],
    question: "Is the review positive?",
    claim: "the review is positive",
    claimNeg: "the review is not positive",
    voice: "Is the restaurant reviewed positively?",
    synonym: "Is the write-up favourable?",
    terse: "Positive?",
  },
  {
    id: "promotion",
    kind: "judgement",
    facts: [
      ["Performance", "exceeded every sales target this year"],
      ["Conduct", "often late to team meetings"],
    ],
    prose:
      "The employee exceeded every sales target this year and is often late to team meetings.",
    distractors: [],
    question: "Does the employee deserve a promotion?",
    claim: "the employee deserves a promotion",
    claimNeg: "the employee does not deserve a promotion",
    voice: "Should a promotion be given to the employee?",
    synonym: "Has the worker earned a step up?",
    terse: "Promote?",
  },
];

export type ChoiceOption = [key: string, label: string];

/** A choice with a right answer. Options are in authored order; `extras` are also wrong. */
export type ChoiceItem = {
  id: string;
  state: Record<string, string>;
  instructions: string;
  imperative: string;
  options: ChoiceOption[];
  extras: ChoiceOption[];
  correct: string;
  es: string;
  zh: string;
};

export const CHOICE_ITEMS: ChoiceItem[] = [
  {
    id: "north",
    state: { Topic: "cities of Europe and Africa" },
    instructions: "Which of these cities is furthest north?",
    imperative: "Pick the city that is furthest north.",
    options: [
      ["madrid", "Madrid"],
      ["oslo", "Oslo"],
      ["rome", "Rome"],
      ["cairo", "Cairo"],
    ],
    extras: [
      ["athens", "Athens"],
      ["lisbon", "Lisbon"],
    ],
    correct: "oslo",
    es: "¿Cuál de estas ciudades está más al norte?",
    zh: "这些城市中哪一个最靠北？",
  },
  {
    id: "plan",
    state: {
      "Team size": "10 users",
      "Basic plan": "$8 per user per month",
      "Pro plan": "$20 per month plus $5 per user",
      "Team plan": "$60 per month flat, up to 10 users",
      "Enterprise plan": "$100 per month flat",
      "Plus plan": "$12 per user per month",
      "Studio plan": "$95 per month flat",
    },
    instructions: "Which plan is cheapest per month for this team?",
    imperative: "Pick the plan that costs this team the least per month.",
    options: [
      ["basic", "Basic plan"],
      ["pro", "Pro plan"],
      ["team", "Team plan"],
      ["enterprise", "Enterprise plan"],
    ],
    extras: [
      ["plus", "Plus plan"],
      ["studio", "Studio plan"],
    ],
    correct: "team",
    es: "¿Qué plan es el más barato al mes para este equipo?",
    zh: "对这个团队来说，哪个方案每月最便宜？",
  },
  {
    id: "routing",
    state: {
      "Rule 1": "If the message mentions an invoice, send it to Billing.",
      "Rule 2": "If the message mentions a password, send it to Accounts.",
      "Rule 3": "Otherwise, send it to Support.",
      "How rules apply": "Rules are checked in order; the first rule that applies wins.",
      Message: "Hi, I forgot my password and now I can't log in to see my invoice.",
    },
    instructions: "Which team should the message go to?",
    imperative: "Pick the team the message should go to.",
    options: [
      ["accounts", "Accounts"],
      ["billing", "Billing"],
      ["support", "Support"],
      ["sales", "Sales"],
    ],
    extras: [
      ["security", "Security"],
      ["shipping", "Shipping"],
    ],
    correct: "billing",
    es: "¿A qué equipo debe ir el mensaje?",
    zh: "这条消息应该发给哪个团队？",
  },
  {
    id: "train",
    state: {
      "Northern Express": "departs 08:10, journey 55 minutes",
      Coastal: "departs 08:25, journey 30 minutes",
      "Valley Line": "departs 08:00, journey 70 minutes",
      "City Link": "departs 08:40, journey 22 minutes",
      "Harbour Shuttle": "departs 08:05, journey 65 minutes",
      "Airport Rail": "departs 08:30, journey 40 minutes",
    },
    instructions: "Which train arrives first?",
    imperative: "Pick the train that arrives first.",
    options: [
      ["northern", "Northern Express"],
      ["valley", "Valley Line"],
      ["city", "City Link"],
      ["coastal", "Coastal"],
    ],
    extras: [
      ["harbour", "Harbour Shuttle"],
      ["airport", "Airport Rail"],
    ],
    correct: "coastal",
    es: "¿Qué tren llega primero?",
    zh: "哪趟火车最先到达？",
  },
  {
    id: "allergy",
    state: {
      Guest: "allergic to nuts and to dairy",
      "Tomato soup": "tomato, basil, olive oil",
      "Pesto pasta": "pasta, basil, pine nuts, parmesan",
      "Mac and cheese": "pasta, cheddar, milk",
      "Almond cake": "almonds, flour, butter",
      "Cheese board": "brie, cheddar, crackers",
      "Walnut salad": "lettuce, walnuts, yoghurt dressing",
    },
    instructions: "Which dish can the guest safely eat?",
    imperative: "Pick the dish the guest can safely eat.",
    options: [
      ["soup", "Tomato soup"],
      ["pesto", "Pesto pasta"],
      ["mac", "Mac and cheese"],
      ["cake", "Almond cake"],
    ],
    extras: [
      ["cheese", "Cheese board"],
      ["salad", "Walnut salad"],
    ],
    correct: "soup",
    es: "¿Qué plato puede comer el invitado sin riesgo?",
    zh: "这位客人可以放心吃哪道菜？",
  },
  {
    id: "planet",
    state: { Topic: "the Solar System" },
    instructions: "Which of these planets is the largest?",
    imperative: "Pick the largest of these planets.",
    options: [
      ["mars", "Mars"],
      ["venus", "Venus"],
      ["jupiter", "Jupiter"],
      ["earth", "Earth"],
    ],
    extras: [
      ["mercury", "Mercury"],
      ["neptune", "Neptune"],
    ],
    correct: "jupiter",
    es: "¿Cuál de estos planetas es el más grande?",
    zh: "这些行星中哪一个最大？",
  },
  {
    id: "weekday",
    state: { "Known date": "2026-10-01 is a Thursday" },
    instructions: "What day of the week is 2026-10-05?",
    imperative: "Pick the day of the week that 2026-10-05 falls on.",
    options: [
      ["sunday", "Sunday"],
      ["tuesday", "Tuesday"],
      ["saturday", "Saturday"],
      ["monday", "Monday"],
    ],
    extras: [
      ["wednesday", "Wednesday"],
      ["friday", "Friday"],
    ],
    correct: "monday",
    es: "¿Qué día de la semana es el 2026-10-05?",
    zh: "2026-10-05 是星期几？",
  },
  {
    id: "spanish-dog",
    state: { Topic: "Spanish vocabulary" },
    instructions: "Which word means 'dog' in Spanish?",
    imperative: "Pick the Spanish word for 'dog'.",
    options: [
      ["perro", "perro"],
      ["gato", "gato"],
      ["pajaro", "pájaro"],
      ["caballo", "caballo"],
    ],
    extras: [
      ["vaca", "vaca"],
      ["pez", "pez"],
    ],
    correct: "perro",
    es: "¿Qué palabra significa 'dog' en español?",
    zh: "哪个词在西班牙语中是 'dog' 的意思？",
  },
  {
    id: "review",
    state: {
      Review:
        "I waited an hour and the soup was cold, but the staff apologised and gave us dessert for free.",
    },
    instructions: "What is the overall sentiment of the review?",
    imperative: "Pick the overall sentiment of the review.",
    options: [
      ["positive", "Entirely positive"],
      ["mixed", "Mixed: some complaints and some praise"],
      ["negative", "Entirely negative"],
      ["unrelated", "Not about the restaurant at all"],
    ],
    extras: [
      ["sarcastic", "Sarcastic praise"],
      ["spam", "Advertising spam"],
    ],
    correct: "mixed",
    es: "¿Cuál es el sentimiento general de la reseña?",
    zh: "这条评论的整体情感是什么？",
  },
  {
    id: "heaviest",
    state: {
      Flour: "1.2 kg",
      Sugar: "900 g",
      Rice: "1500 g",
      Oats: "1.4 kg",
      Salt: "500 g",
      Beans: "1.1 kg",
    },
    instructions: "Which bag is the heaviest?",
    imperative: "Pick the heaviest bag.",
    options: [
      ["flour", "Flour"],
      ["sugar", "Sugar"],
      ["rice", "Rice"],
      ["oats", "Oats"],
    ],
    extras: [
      ["salt", "Salt"],
      ["beans", "Beans"],
    ],
    correct: "rice",
    es: "¿Qué bolsa es la más pesada?",
    zh: "哪一袋最重？",
  },
  {
    id: "leave",
    state: {
      Policy:
        "Sick leave is paid when the employee provides a doctor's note. Without a note, sick days are unpaid.",
      Employee: "was ill for 3 days and provided a doctor's note",
    },
    instructions: "How should the 3 days be recorded?",
    imperative: "Pick how the 3 days should be recorded.",
    options: [
      ["unpaid", "Unpaid leave"],
      ["annual", "Annual leave"],
      ["absence", "Unauthorised absence"],
      ["paid-sick", "Paid sick leave"],
    ],
    extras: [
      ["parental", "Parental leave"],
      ["training", "Training days"],
    ],
    correct: "paid-sick",
    es: "¿Cómo deben registrarse los 3 días?",
    zh: "这3天应该如何记录？",
  },
  {
    id: "intent",
    state: { Message: "How do I change the delivery address on my order?" },
    instructions: "What does the customer want to do?",
    imperative: "Pick what the customer wants to do.",
    options: [
      ["address", "Update the delivery address"],
      ["cancel", "Cancel the order"],
      ["track", "Track the package"],
      ["refund", "Get a refund"],
    ],
    extras: [
      ["complain", "Complain about the service"],
      ["account", "Open a new account"],
    ],
    correct: "address",
    es: "¿Qué quiere hacer el cliente?",
    zh: "这位顾客想做什么？",
  },
  {
    id: "multiply",
    state: { Topic: "mental arithmetic" },
    instructions: "What is 17 × 3?",
    imperative: "Pick the value of 17 × 3.",
    options: [
      ["41", "41"],
      ["51", "51"],
      ["54", "54"],
      ["61", "61"],
    ],
    extras: [
      ["47", "47"],
      ["57", "57"],
    ],
    correct: "51",
    es: "¿Cuánto es 17 × 3?",
    zh: "17 × 3 等于多少？",
  },
  {
    id: "not-fruit",
    state: { Topic: "foods" },
    instructions: "Which of these is not a fruit?",
    imperative: "Pick the one that is not a fruit.",
    options: [
      ["apple", "Apple"],
      ["mango", "Mango"],
      ["carrot", "Carrot"],
      ["pear", "Pear"],
    ],
    extras: [
      ["plum", "Plum"],
      ["cherry", "Cherry"],
    ],
    correct: "carrot",
    es: "¿Cuál de estos no es una fruta?",
    zh: "以下哪一个不是水果？",
  },
  {
    id: "priority",
    state: {
      "Priority rules":
        "P1: an outage that affects all users. P2: an outage that affects some users. P3: anything else.",
      Report: "Checkout is down for every customer right now.",
    },
    instructions: "What priority should the report get?",
    imperative: "Pick the priority the report should get.",
    options: [
      ["p1", "P1"],
      ["p2", "P2"],
      ["p3", "P3"],
      ["unclear", "Not enough information to say"],
    ],
    extras: [
      ["p4", "P4"],
      ["p5", "P5"],
    ],
    correct: "p1",
    es: "¿Qué prioridad debe recibir el informe?",
    zh: "这份报告应该定为什么优先级？",
  },
  {
    id: "buses",
    state: { Buses: "3 buses with 40 seats each", Students: "130 students" },
    instructions: "Which statement is true?",
    imperative: "Pick the true statement.",
    options: [
      ["enough", "There are enough seats for everyone"],
      ["short20", "20 students have no seat"],
      ["short30", "30 students have no seat"],
      ["short10", "10 students have no seat"],
    ],
    extras: [
      ["short5", "5 students have no seat"],
      ["spare10", "There are 10 spare seats"],
    ],
    correct: "short10",
    es: "¿Qué afirmación es verdadera?",
    zh: "哪个说法是正确的？",
  },
];

/** Risky-choice framing (Tversky & Kahneman 1981): one third of N saved for sure, or a gamble. */
export type FramingItem = {
  id: string;
  context: string;
  n: number;
  unit: string;
  /** Verb phrases for the gain and loss frames, e.g. "will be saved" / "will die". */
  gain: string;
  loss: string;
  /** The loss frame's "nobody …" phrase, e.g. "nobody will die". */
  lossNone: string;
  question: string;
};

export const FRAMING_ITEMS: FramingItem[] = [
  {
    id: "disease",
    context:
      "A country is preparing for an unusual disease that is expected to kill 600 people. Two programs to combat it have been proposed.",
    n: 600,
    unit: "people",
    gain: "will be saved",
    loss: "will die",
    lossNone: "nobody will die",
    question: "Which program should be adopted?",
  },
  {
    id: "jobs",
    context:
      "A company must close plants, putting 6000 jobs at risk. Two restructuring plans have been proposed.",
    n: 6000,
    unit: "jobs",
    gain: "will be kept",
    loss: "will be lost",
    lossNone: "no jobs will be lost",
    question: "Which plan should the company adopt?",
  },
  {
    id: "crops",
    context: "A pest outbreak threatens 900 acres of crops. Two treatment plans have been proposed.",
    n: 900,
    unit: "acres",
    gain: "will be saved",
    loss: "will be destroyed",
    lossNone: "no acres will be destroyed",
    question: "Which treatment plan should be used?",
  },
  {
    id: "forest",
    context: "A wildfire threatens 1200 hectares of forest. Two firefighting strategies have been proposed.",
    n: 1200,
    unit: "hectares",
    gain: "will be saved",
    loss: "will burn",
    lossNone: "no hectares will burn",
    question: "Which strategy should the fire service choose?",
  },
  {
    id: "species",
    context:
      "A disease threatens the last 90 animals of an endangered species in a reserve. Two conservation plans have been proposed.",
    n: 90,
    unit: "animals",
    gain: "will be saved",
    loss: "will die",
    lossNone: "no animals will die",
    question: "Which conservation plan should the reserve adopt?",
  },
  {
    id: "patients",
    context:
      "A hospital faces a drug shortage affecting 300 patients who need treatment. Two allocation plans have been proposed.",
    n: 300,
    unit: "patients",
    gain: "will recover",
    loss: "will not recover",
    lossNone: "every patient will recover",
    question: "Which allocation plan should the hospital adopt?",
  },
  {
    id: "files",
    context:
      "A failing server holds 60 irreplaceable project files. Two recovery methods have been proposed.",
    n: 60,
    unit: "files",
    gain: "will be recovered",
    loss: "will be lost",
    lossNone: "no files will be lost",
    question: "Which recovery method should the team use?",
  },
  {
    id: "customers",
    context:
      "A service outage has put 3000 customers at risk of leaving. Two retention campaigns have been proposed.",
    n: 3000,
    unit: "customers",
    gain: "will be retained",
    loss: "will leave",
    lossNone: "no customers will leave",
    question: "Which campaign should the company run?",
  },
  {
    id: "homes",
    context: "A river flood threatens 450 homes. Two flood-defence plans have been proposed.",
    n: 450,
    unit: "homes",
    gain: "will be protected",
    loss: "will be flooded",
    lossNone: "no homes will be flooded",
    question: "Which flood-defence plan should the town adopt?",
  },
  {
    id: "savings",
    context:
      "A market crash threatens a fund's 3 million dollars of member savings. Two rescue strategies have been proposed.",
    n: 3,
    unit: "million dollars",
    gain: "will be preserved",
    loss: "will be lost",
    lossNone: "no money will be lost",
    question: "Which rescue strategy should the fund adopt?",
  },
];

/** Attribute framing (Levin & Gaeth 1988): the same fact stated as a positive or negative share. */
export type AttributeItem = {
  id: string;
  subject: string;
  positive: string;
  negative: string;
  question: string;
};

export const ATTRIBUTE_ITEMS: AttributeItem[] = [
  {
    id: "beef",
    subject: "A pack of ground beef",
    positive: "It is 75% lean.",
    negative: "It is 25% fat.",
    question: "How good is this ground beef?",
  },
  {
    id: "surgery",
    subject: "A surgery for a common heart condition",
    positive: "90% of patients survive the operation.",
    negative: "10% of patients die during the operation.",
    question: "How good an option is this surgery?",
  },
  {
    id: "shooter",
    subject: "A basketball player",
    positive: "She makes 40% of her shots.",
    negative: "She misses 60% of her shots.",
    question: "How good a shooter is this player?",
  },
  {
    id: "vaccine",
    subject: "A new vaccine",
    positive: "It protects 95% of people who receive it.",
    negative: "It fails to protect 5% of people who receive it.",
    question: "How good is this vaccine?",
  },
  {
    id: "student",
    subject: "A student's record this year",
    positive: "She passed 80% of her exams.",
    negative: "She failed 20% of her exams.",
    question: "How good is this student's record?",
  },
  {
    id: "airline",
    subject: "An airline",
    positive: "85% of its flights arrive on time.",
    negative: "15% of its flights arrive late.",
    question: "How good is this airline's punctuality?",
  },
];

/** Estimation with a known answer, for anchoring (Tversky & Kahneman 1974; Strack & Mussweiler 1997). */
export type AnchorItem = {
  id: string;
  question: string;
  levels: string[];
  /** Index of the level that holds the true value. */
  truth: number;
  value: string;
  low: string;
  high: string;
};

export const ANCHOR_ITEMS: AnchorItem[] = [
  {
    id: "africa",
    question: "How many countries are there in Africa?",
    levels: ["Fewer than 20", "20 to 39", "40 to 59", "60 to 79", "80 to 99", "100 or more"],
    truth: 2,
    value: "54",
    low: "10",
    high: "150",
  },
  {
    id: "bones",
    question: "How many bones are in the adult human body?",
    levels: ["Fewer than 100", "100 to 149", "150 to 199", "200 to 249", "250 to 299", "300 or more"],
    truth: 3,
    value: "206",
    low: "40",
    high: "600",
  },
  {
    id: "everest",
    question: "How tall is Mount Everest, in metres?",
    levels: [
      "Under 5,000 m",
      "5,000 to 6,999 m",
      "7,000 to 8,499 m",
      "8,500 to 9,999 m",
      "10,000 to 11,999 m",
      "12,000 m or more",
    ],
    truth: 3,
    value: "8,849 m",
    low: "1,500",
    high: "25,000",
  },
  {
    id: "telephone",
    question: "In what year was the telephone first patented?",
    levels: ["Before 1800", "1800 to 1849", "1850 to 1899", "1900 to 1949", "1950 to 1999", "2000 or later"],
    truth: 2,
    value: "1876",
    low: "1700",
    high: "1990",
  },
  {
    id: "nile",
    question: "How long is the river Nile, in kilometres?",
    levels: [
      "Under 2,000 km",
      "2,000 to 3,999 km",
      "4,000 to 5,999 km",
      "6,000 to 7,999 km",
      "8,000 to 9,999 km",
      "10,000 km or more",
    ],
    truth: 3,
    value: "about 6,650 km",
    low: "800",
    high: "20,000",
  },
  {
    id: "gandhi",
    question: "How old was Mahatma Gandhi when he died?",
    levels: ["Under 50", "50 to 59", "60 to 69", "70 to 79", "80 to 89", "90 or older"],
    truth: 3,
    value: "78",
    low: "9",
    high: "140",
  },
  {
    id: "mozart",
    question: "How old was Mozart when he died?",
    levels: ["Under 20", "20 to 29", "30 to 39", "40 to 49", "50 to 59", "60 or older"],
    truth: 2,
    value: "35",
    low: "5",
    high: "120",
  },
  {
    id: "piano",
    question: "How many keys does a standard piano have?",
    levels: ["Fewer than 40", "40 to 59", "60 to 79", "80 to 99", "100 to 119", "120 or more"],
    truth: 3,
    value: "88",
    low: "12",
    high: "300",
  },
  {
    id: "sound",
    question: "How fast does sound travel in air at room temperature, in metres per second?",
    levels: ["Under 100", "100 to 199", "200 to 299", "300 to 399", "400 to 499", "500 or more"],
    truth: 3,
    value: "343",
    low: "30",
    high: "3,000",
  },
  {
    id: "moon",
    question: "How far is the Moon from the Earth on average, in kilometres?",
    levels: [
      "Under 100,000 km",
      "100,000 to 199,999 km",
      "200,000 to 299,999 km",
      "300,000 to 399,999 km",
      "400,000 to 499,999 km",
      "500,000 km or more",
    ],
    truth: 3,
    value: "384,400 km",
    low: "5,000",
    high: "5,000,000",
  },
  {
    id: "eiffel",
    question: "In what year was the Eiffel Tower completed?",
    levels: ["Before 1800", "1800 to 1849", "1850 to 1899", "1900 to 1949", "1950 to 1999", "2000 or later"],
    truth: 2,
    value: "1889",
    low: "1650",
    high: "2010",
  },
  {
    id: "marathon",
    question: "How long is a marathon, in kilometres?",
    levels: ["Under 20 km", "20 to 29 km", "30 to 39 km", "40 to 49 km", "50 to 59 km", "60 km or more"],
    truth: 3,
    value: "42.195 km",
    low: "5",
    high: "150",
  },
];

/** Asymmetric dominance (Huber, Payne & Puto 1982): A and B trade off; a decoy is worse than one. */
export type DecoyItem = {
  id: string;
  context: string;
  question: string;
  a: string;
  b: string;
  /** Worse than A on both attributes. */
  aDecoy: string;
  /** Worse than B on both attributes. */
  bDecoy: string;
};

export const DECOY_ITEMS: DecoyItem[] = [
  {
    id: "apartment",
    context: "Someone is choosing an apartment. Rent and commute both matter to them.",
    question: "Which apartment should they choose?",
    a: "Rent $1,200 per month, 45-minute commute",
    b: "Rent $1,600 per month, 15-minute commute",
    aDecoy: "Rent $1,250 per month, 50-minute commute",
    bDecoy: "Rent $1,650 per month, 20-minute commute",
  },
  {
    id: "laptop",
    context: "Someone is buying a laptop. Price and battery life both matter to them.",
    question: "Which laptop should they buy?",
    a: "$700, 6 hours of battery",
    b: "$1,100, 14 hours of battery",
    aDecoy: "$750, 5 hours of battery",
    bDecoy: "$1,150, 12 hours of battery",
  },
  {
    id: "job",
    context: "Someone has job offers. Salary and commute both matter to them.",
    question: "Which job should they take?",
    a: "Salary $70,000, 60-minute commute",
    b: "Salary $55,000, 10-minute commute",
    aDecoy: "Salary $68,000, 65-minute commute",
    bDecoy: "Salary $53,000, 15-minute commute",
  },
  {
    id: "car",
    context: "Someone is buying a car. Price and fuel economy both matter to them.",
    question: "Which car should they buy?",
    a: "$22,000, 30 miles per gallon",
    b: "$28,000, 45 miles per gallon",
    aDecoy: "$23,000, 28 miles per gallon",
    bDecoy: "$29,000, 42 miles per gallon",
  },
  {
    id: "phone-plan",
    context: "Someone is picking a phone plan. Price and data allowance both matter to them.",
    question: "Which plan should they pick?",
    a: "$20 per month, 5 GB of data",
    b: "$45 per month, 50 GB of data",
    aDecoy: "$22 per month, 4 GB of data",
    bDecoy: "$48 per month, 40 GB of data",
  },
  {
    id: "restaurant",
    context: "Someone is picking a restaurant for dinner. Rating and distance both matter to them.",
    question: "Which restaurant should they go to?",
    a: "Rated 4.8 stars, 25 minutes away",
    b: "Rated 4.1 stars, 5 minutes away",
    aDecoy: "Rated 4.6 stars, 30 minutes away",
    bDecoy: "Rated 3.9 stars, 8 minutes away",
  },
  {
    id: "flight",
    context: "Someone is booking a flight. Price and travel time both matter to them.",
    question: "Which flight should they book?",
    a: "$180, 9 hours with one stop",
    b: "$420, 5 hours direct",
    aDecoy: "$200, 10 hours with one stop",
    bDecoy: "$450, 5.5 hours direct",
  },
  {
    id: "hotel",
    context: "Someone is booking a hotel. Price and guest rating both matter to them.",
    question: "Which hotel should they book?",
    a: "$90 per night, rated 3.5 stars",
    b: "$160 per night, rated 4.8 stars",
    aDecoy: "$100 per night, rated 3.2 stars",
    bDecoy: "$175 per night, rated 4.5 stars",
  },
];

/** Opinion statements and their reversals, for Likert direction and acquiescence. */
export type LikertItem = { id: string; statement: string; reversed: string };

export const LIKERT_ITEMS: LikertItem[] = [
  {
    id: "recline",
    statement: "Reclining your seat on a two-hour flight is acceptable.",
    reversed: "Reclining your seat on a two-hour flight is unacceptable.",
  },
  {
    id: "wfh",
    statement: "Working from home makes people more productive.",
    reversed: "Working from home makes people less productive.",
  },
  {
    id: "pineapple",
    statement: "Pineapple belongs on pizza.",
    reversed: "Pineapple does not belong on pizza.",
  },
  {
    id: "phones",
    statement: "Children under 12 should be allowed to have smartphones.",
    reversed: "Children under 12 should not be allowed to have smartphones.",
  },
  {
    id: "texting",
    statement: "Texting during dinner with friends is fine.",
    reversed: "Texting during dinner with friends is rude.",
  },
  {
    id: "tipping",
    statement: "Tipping at restaurants should be mandatory.",
    reversed: "Tipping at restaurants should be optional.",
  },
  {
    id: "meetings",
    statement: "Remote meetings are better than in-person meetings.",
    reversed: "Remote meetings are worse than in-person meetings.",
  },
  {
    id: "cars",
    statement: "Cities should ban cars from their centres.",
    reversed: "Cities should allow cars in their centres.",
  },
  {
    id: "four-day",
    statement: "A four-day work week would be good for the economy.",
    reversed: "A four-day work week would be bad for the economy.",
  },
  {
    id: "homework",
    statement: "Homework should be abolished in primary school.",
    reversed: "Homework should be kept in primary school.",
  },
];
