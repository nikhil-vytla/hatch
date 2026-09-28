# Decide

Twenty everyday calls a decision classifier makes (`deck.ts`), asked blind at `#/decide`. You
pick first. Then the page shows how other visitors split, how each model chose, and how the
same call moves when it is asked another way. Four calls have an answer fixed by a stated rule
(refund policy, routing rules, a café order, overtime); the rest are debatable.

Each decision has up to seven setups:

| Group        | Setups                                                             |
| ------------ | ------------------------------------------------------------------ |
| Wording      | neutral, leading (a fact that leans one way), terse                |
| Answer shape | yes/no or a 0–2 score (two options); one yes/no per option (three) |
| Context      | the neutral question with extra state a real system might have     |
| Split        | two or three small yes/no questions that code combines (all / any) |

A setup is data: the exact request, and a combine rule (`combine.ts`) that turns the answers
into a split over the visitor's options. The page shows both, plus every model's raw answers.

Contestants, recorded once and replayed (`recordings/decide*.jsonl`):

- Jev, through the gateway (`scripts/record-decide.ts`).
- Laya, local with MLX (`scripts/decide-export.ts`, then `scripts/record-decide-laya.py`).
- MobileBERT-MNLI, a zero-shot classifier (`nli.ts`, `scripts/record-decide-nli.ts`). The page
  can run the same code and model in the visitor's browser.

Visitor votes go to `/api/tally` (`tally.ts`): one vote per decision per visitor per day,
kept as per-option counts and today's salted visitor hashes, one JSON document per decision
in the private Vercel Blob store `jev-experiments-blob`. Writes are conditional on the
document's ETag and retried on conflict, so concurrent votes are not lost. Each vote is one
read and one write; Blob's Hobby allowance caps writes, and past it votes stop being counted
rather than being billed. Without a store the page leaves the tally out.

## First look (28 Sep 2026, Laya and MobileBERT)

Wording flips a model on a few calls, mostly the terse one. Answer shape flips more: Laya calls the refund "Refund 83%" when
asked to choose and "Store credit 84%" as a yes/no; MobileBERT calls "hot dog" a sandwich
(62%) when choosing and not one (100%) as a yes/no. Laya's 0–2 scores sit near 50% on almost
every call. On the four calls with an answer, asked plainly, Laya is right on 2 (route,
overtime) and MobileBERT on 2 (refund, overtime).
