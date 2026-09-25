# Shapeshift phrase set

`phrases.json` is a benchmark of 200 short phrases for the "one text box that becomes the right card" experiment, based on [anishfn/shapeshift](https://github.com/anishfn/shapeshift). Each phrase has an expected card intent, the intents that are also fair (ambiguous phrases only), and the signals the phrase clearly settles. It exists to score several classifiers (a large model, a keyword/regex classifier, a tiny model) against the same answers.

## How it was authored

- Written by a Claude subagent on 2026-09-24. Nikhil still needs to review it.
- The only source for definitions was `src/lib/jev/questions.ts`: the 20 intent options (19 cards plus `none`) and the signal questions with their criteria text.
- The author did not read the keyword rules (`src/lib/jev/mock.ts`), the tests (`src/lib/__tests__`), the demo script (`src/hooks/useDemoScript.ts`) or `src/components`, and ran no classifier or model. The phrases and labels don't come from any system being scored.
- Written by hand, then checked with a script for counts, unique ids and texts, valid enum values, word counts and split stratification.

## Rules

- Exactly 200 phrases. Every one of the 19 card intents has at least 7 `plain` phrases. `none` is never the expected intent, because each phrase is a finished input.
- `kind`:
  - `plain`: one clear intent.
  - `ambiguous`: more than one reading is defensible. `acceptable` lists the other intents that should also count as correct.
  - `adversarial`: misleading keywords, e.g. "remind me why…", "red flag", "split pea soup", figurative "timer". Also mixed currencies (₹, €, £, $), long pastes, typos, emoji, lowercase run-ons, British spellings, and numbers that look like times but aren't ("chapter 3:16", "BA 1130", "1800 rupees").
- Non-ambiguous phrases have an empty `acceptable`. Non-plain phrases carry a one-line `note` saying what makes them hard.
- `signals` holds only what the finished phrase clearly determines. Everything else is left out, so a missing signal means "don't score it", not "unspecified".
  - Enum keys and options match `questions.ts` exactly: `eventMode`, `transport`, `tripType`, `expenseCategory`, `colorMood`, `timerKind`, `tone`.
  - `isQuestion`, `recurring`, `hasExplicitOptions` and `isShoppingList` are booleans. `urgency` is the index 0, 1 or 2 into its levels.
  - `expenseCategory` also appears on some `split` phrases where the phrase names what the money was for.
  - `transport: "unspecified"` is used once, where a travel phrase clearly names no mode of transport.
- Phrases run from 2 to 37 words (mean 6.7) and mix terse, chatty, lowercase and typo'd styles. There are no duplicates. No real personal data appears: first names only, `example.com`-style domains, 555 numbers.
- `split`: 50 phrases are `heldout`. That is 2 plain phrases per intent (38), 7 ambiguous and 5 adversarial, so every intent and every kind appears in both splits.

## Counts

| kind        | dev | heldout | total |
| ----------- | --- | ------- | ----- |
| plain       | 112 | 38      | 150   |
| ambiguous   | 23  | 7       | 30    |
| adversarial | 15  | 5       | 20    |
| total       | 150 | 50      | 200   |

| intent    | total | plain | ambiguous | adversarial | heldout |
| --------- | ----- | ----- | --------- | ----------- | ------- |
| event     | 14    | 8     | 5         | 1           | 4       |
| reminder  | 12    | 8     | 2         | 2           | 3       |
| todo      | 10    | 8     | 0         | 2           | 2       |
| timer     | 8     | 8     | 0         | 0           | 2       |
| habit     | 12    | 8     | 4         | 0           | 2       |
| color     | 9     | 8     | 0         | 1           | 2       |
| split     | 12    | 8     | 3         | 1           | 4       |
| expense   | 12    | 8     | 0         | 4           | 3       |
| convert   | 9     | 8     | 1         | 0           | 2       |
| calc      | 9     | 8     | 1         | 0           | 2       |
| travel    | 10    | 8     | 1         | 1           | 3       |
| poll      | 10    | 8     | 2         | 0           | 2       |
| contact   | 9     | 8     | 1         | 0           | 2       |
| link      | 9     | 8     | 1         | 0           | 3       |
| countdown | 10    | 8     | 2         | 0           | 4       |
| timezone  | 10    | 8     | 2         | 0           | 3       |
| random    | 8     | 7     | 1         | 0           | 2       |
| goal      | 11    | 8     | 3         | 0           | 2       |
| note      | 16    | 7     | 1         | 8           | 3       |

Signal labels by key: expenseCategory 20, recurring 20, isQuestion 20, hasExplicitOptions 13, eventMode 11, tone 10, isShoppingList 10, transport 10, timerKind 8, colorMood 7, tripType 6, urgency 2.

## Known choices to review

- Most adversarial phrases (8 of 20) resolve to `note`, since "keyword bait that is really just a thought" is the most common trap.
- The set treats currency conversion ("50 usd in inr") as ambiguous between `convert` and `calc`, because the `convert` criterion says "unit of measurement".
- `colorMood` is left out for bare hex and rgb values, where warm/vivid or cool/dark would be a guess.
- Phrases are grouped by intent in id order. Shuffle before showing them to anything that could pick up on order.
