# One-box phrase set

`phrases.json` holds 200 short phrases, written from an American point of view, for the "one text box that becomes the right card" experiment. The experiment is based on [anishfn/shapeshift](https://github.com/anishfn/shapeshift). Each phrase has an expected card intent. Ambiguous phrases also list the other intents that are fair answers. Each phrase carries only the signals it clearly settles. The set scores several classifiers (a large model, a keyword/regex classifier and a local open model) against the same answers. `phrases.ts` validates the file (`schema: "one-box.phrases/1"`).

## How it was written

- A Claude subagent wrote it on 2026-09-24, replacing an earlier set that was not US-focused. Nikhil still needs to review it.
- The only source for definitions was `src/lib/jev/questions.ts`: the 20 intent options (19 cards plus `none`) and the criteria text for each signal. The author did not open the keyword rules (`mock.ts`), the tests, `useDemoScript.ts`, the components or anything under `upstream/`, and ran no classifier or model. So the phrases and labels owe nothing to the systems being scored.
- The phrases were written by hand. A script checked the counts, unique ids and texts, enum values, word counts and the dev/heldout split.
- Ids are in shuffled order (fixed seed), so they are not grouped by intent.

## Setting

The phrases describe everyday American life:

- **Money:** USD amounts, Venmo, tips and sales tax.
- **Dates and times:** US date order (10/12, "the 1st", 5/9) and 12-hour times.
- **Units:** imperial (miles, °F, lbs, oz, cups, quarts, gallons, pints, feet/inches, yards).
- **Places and holidays:** US spellings, US holidays (Thanksgiving, 4th of July, Memorial Day, Labor Day, Super Bowl Sunday), US time zones and cities (ET/PT/CT/MT, NYC, LA, Chicago, Denver, Phoenix, Honolulu).
- **Stores and services:** Target, Costco, Trader Joe's, CVS, DoorDash, Uber, Amtrak, Southwest, Greyhound, Hulu.
- **Routines:** school and work (PTO, 401k, open enrollment, soccer practice, carpool, field trip forms).

Other currencies (€, £) and metric units show up only in adversarial phrases. The one exception is "10k in 55 min, pace per mile?", which is ambiguous, because "10k" is how Americans name the race.

## Rules

- **Size:** exactly 200 phrases. Each of the 19 card intents has at least 7 `plain` phrases. `none` is never the expected intent, because every phrase is a finished input.
- **Kinds:**
  - `plain`: one clear intent.
  - `ambiguous`: more than one reading is defensible, and `acceptable` lists the other intents that also count as correct.
  - `adversarial`: misleading keywords ("remind me why…", "red flag", "gray area", "split pea soup", "patience timer", "convert the garage"), mixed currencies, a long pasted note, typos, emoji, a lowercase run-on, numbers that look like clock times but aren't ("john 3:16", "Southwest 2417", "1145 after tip", race times) and metric input.
- **acceptable and note:** non-ambiguous phrases have an empty `acceptable`. Every non-plain phrase has a one-line `note` saying what makes it hard.
- **signals:** a signal is included only when the finished phrase clearly settles it, so a missing signal means "don't score", not "unspecified".
  - Enum keys and options match `questions.ts` exactly.
  - `isQuestion`, `recurring`, `hasExplicitOptions` and `isShoppingList` are booleans.
  - `urgency` is 0, 1 or 2, an index into its levels.
  - Some `split` phrases also carry `expenseCategory` when they say what the money was for.
  - `transport: "unspecified"` appears once, on a travel phrase that clearly names no transport.
- **Style:** 2 to 37 words (mean 6.8), in terse, chatty, lowercase, all-caps and typo'd styles, with no duplicates.
- **Privacy:** no real personal data. Names are first names only, emails use `example.com`-style domains, and phone numbers are 555 numbers.
- **Split:** 50 phrases are `heldout`: 2 plain per intent (38), 7 ambiguous and 5 adversarial. Every intent and every kind appears in both splits.

## Counts

| kind        | dev | heldout | total |
| ----------- | --- | ------- | ----- |
| plain       | 112 | 38      | 150   |
| ambiguous   | 23  | 7       | 30    |
| adversarial | 15  | 5       | 20    |
| total       | 150 | 50      | 200   |

| intent    | total | plain | ambiguous | adversarial | heldout |
| --------- | ----- | ----- | --------- | ----------- | ------- |
| event     | 14    | 8     | 5         | 1           | 6       |
| reminder  | 13    | 8     | 3         | 2           | 3       |
| todo      | 10    | 8     | 0         | 2           | 2       |
| timer     | 8     | 8     | 0         | 0           | 2       |
| habit     | 12    | 8     | 4         | 0           | 2       |
| color     | 8     | 8     | 0         | 0           | 2       |
| split     | 12    | 8     | 3         | 1           | 3       |
| expense   | 11    | 8     | 0         | 3           | 3       |
| convert   | 9     | 8     | 0         | 1           | 2       |
| calc      | 9     | 8     | 1         | 0           | 2       |
| travel    | 10    | 8     | 1         | 1           | 3       |
| poll      | 10    | 8     | 2         | 0           | 2       |
| contact   | 9     | 8     | 1         | 0           | 2       |
| link      | 9     | 8     | 1         | 0           | 2       |
| countdown | 10    | 8     | 2         | 0           | 2       |
| timezone  | 10    | 8     | 2         | 0           | 2       |
| random    | 8     | 7     | 1         | 0           | 2       |
| goal      | 12    | 8     | 3         | 1           | 5       |
| note      | 16    | 7     | 1         | 8           | 3       |

Signal labels by key: recurring 21, isQuestion 20, expenseCategory 19, hasExplicitOptions 13, eventMode 11, isShoppingList 10, transport 9, timerKind 8, tone 7, colorMood 6, tripType 6, urgency 2.

## Choices to review

- Most adversarial phrases (8 of 20) resolve to `note`, because "keyword bait that is really just a thought" is the most common trap.
- `colorMood` is left out for bare hex and rgb values, where picking a mood would be a guess.
- "Venmo Sarah $25" is labeled `reminder`, with `expense`, `split` and `todo` also accepted. It is a payment instruction, and no card fits it cleanly.
