# Prose studies: the same decision, asked many ways

Jev takes a typed question and returns a calibrated distribution. These studies hold each
decision's content fixed and change only its form: the wording, the language, the layout of the
facts, the answer shape, and the framings that psychology and survey research know move people.
The aim is a map of what Jev is good at and what it isn't, measured against right answers where
they exist.

Earlier work in this repo found that rewording never flipped Jev's answer in 40 tries on Decide,
while answer shape and splitting did (`../src/decide/README.md`), and that reversing option
order barely moved Tetris spot judgements (`../recordings/README.md`). Those were small and
mostly unscored. This study asks each of 20 yes/no items with known answers in 78 ways (75 forms, the
canonical question and two repeats), plus debatable items, choices, and five classic studies from psychology.

## Protocol (frozen before the first recording)

Everything in this section, `items.ts`, `translations.ts`, `text.ts`, `variants.ts`,
`metrics.ts` and `analyze.ts` was committed before any study request was sent. The only earlier
calls were two feasibility requests (`pilot.ts`, `recordings/pilot.jsonl`: does the gateway
accept a string state and an empty state? It does). They are excluded from every analysis.
Anything changed after recording starts is listed under "Deviations" with the reason.

### Conduct

- One question per request, so no variant sees another variant's wording. 2,626 requests.
- Recorder `record.ts`, copied from `scripts/record-decide.ts`: seeded shuffled order over all
  studies (seed 20260929, so time-of-day drift is spread over every family), one request at a
  time, 700 ms gap, 429/503/network failures waited out with backoff doubling from 2 s to 30 s,
  every attempt appended to `recordings/prose.jsonl`, resumable. Weak answers are never re-asked.
  A Score the gateway rejects stays rejected and is excluded (counted in the results).
- Budget: stops before reported cost would pass $1.00 or successful requests 5,000 (pilot
  included). Expected cost is about $0.04 (about 330 input tokens per request at $0.042 per
  million).
- Logged per answer: answers, input tokens, cost, host (`servedBy`), generation id, service
  latency, a hash of the exact request.
- Truths never leave the job objects; a test checks no request contains them.

### Items

| Study | Items | Content | Variants per item | Requests |
| --- | --- | --- | --- | --- |
| Yes/no with a right answer | 20 (10 true, 10 false) | Facts plus a claim: thresholds, dates, arithmetic, times, exceptions, quantifiers, comparison, units, character counting, common knowledge | 78 | 1,560 |
| Debatable yes/no | 10 | Category boundaries (hot dog, cereal), etiquette, borderline policy, triage, sentiment, promotion | 49 | 490 |
| Choice with a right answer | 16 | 4 options; the right one authored at each position 4 times; 2 extra wrong options each | 21 | 336 |
| Risky-choice framing | 10 | Tversky & Kahneman's "Asian disease" and nine isomorphs | 4 | 40 |
| Attribute framing | 6 | "75% lean" vs "25% fat" and five like it | 2 | 12 |
| Anchoring | 12 | Estimates with known answers in 6 bins (Gandhi's age at death, Nile length, …) | 5 | 60 |
| Decoy (asymmetric dominance) | 8 | Two options that trade off, plus a decoy dominated by one | 6 | 48 |
| Likert opinions | 10 | Debatable statements and their reversals | 8 | 80 |

All items and every translation were written by hand for this study; no other model was used.
Each truth item's answer follows from the stated facts, or from common knowledge for "dolphin"
and "capital".

### Variation families

Yes/no items (with or without a right answer). The canonical form is the item's natural
question, e.g. "Is the parcel within the standard shipping weight limit?", with the facts as a
JSON object.

| Family | Variants | Grounding |
| --- | --- | --- |
| baseline | canonical, repeat-1, repeat-2 (noise floor) | |
| sentence-form | declarative ("The parcel is within …."), "Is it true that …?", "True or false: …", imperative "Determine whether …", tag question "…, right?", "Answer yes or no: …", "Answer no or yes: …" | Question form and response-order effects in surveys (Schuman & Presser 1981) |
| lexical-syntax | other voice (passive ↔ active), synonyms, centre-embedded clause | Lexical substitution and invariance tests (Ribeiro et al. 2020, CheckList); embedding difficulty (Gibson 1998) |
| length | terse, verbose | |
| register | formal, legal, casual, child-directed | |
| hedge-intensifier | "I might be wrong, but is it perhaps …", "Is it absolutely, definitely, 100% true …" | |
| noise | typos at 5% and 20% of letters (seeded), ALL CAPS, lowercase without punctuation | Belinkov & Bisk 2018 |
| negation | "Is it false that X?", "Is it true that not-X?", declarative not-X (all inverted); "Is it false that not-X?", "Is it not the case that not-X?" (double negation); "Isn't it true that X?" (negative polar question) | Kassner & Schütze 2020; Hosseini et al. 2021; Truong et al. 2023; Ladd 1981 on "isn't it" questions |
| suggestion | "… Most people say yes." / "… no."; "An expert has said that X / not-X. Is the expert right?" | Loftus & Palmer 1974; sycophancy (Sharma et al. 2023) |
| acquiescence | "Do you agree that X?" / "… not-X?" | Schuman & Presser 1981; Krosnick 1991; Tjuatja et al. 2024 |
| presupposition | "Given that X / not-X, confirm: is that correct?" (a false premise on half the items) | Loaded questions (Loftus 1975) |
| stakes-persona | "This is very important to my career." (Li et al. 2023, EmotionPrompt); answer as a strict auditor / a lenient friend | |
| answer-shape | choice yes/no, choice no/yes, choice between the two statements (both orders), 5-level score ascending and descending, yes/no with true/false criteria | Decide's shape result |

Truth items only (they have facts with values):

| Family | Variants | Grounding |
| --- | --- | --- |
| representation | prose, markdown table, bullets, `key="value"` lines, CSV, JSON array of `{field, value}`, XML, snake_case keys, JSON as a string, nested object, facts inside the instructions with an empty state | Formatting sensitivity (Sclar et al. 2023) |
| context | facts shuffled, 5 irrelevant facts interleaved, a ~420-word irrelevant background paragraph first, numbers written as words (dates, times, money, percentages) | Shi et al. 2023 (irrelevant context); Liu et al. 2023 (long context) |
| language-question | the question in Spanish, French, German, Chinese, Japanese, Hindi, Arabic; facts stay English JSON | Mixed-language input |
| language-full | question and facts (as prose) in the same seven languages | Compared against English prose facts |

Choice items: canonical (semantic keys, labels as criteria), 2 repeats; right option moved to
position 1, 2, 3, 4 and all options reversed (Zheng et al. 2023; Pezeshkpour & Hruschka 2023);
keys as letters, numbers, opaque ids, the label itself, verbose criteria; two options, six
options, "None of the above" added; imperative wording, 20% typos, Spanish and Chinese
instructions; one yes/no per option, renormalised.

Psychology studies:

- Risky-choice framing: the sure option ("200 of 600 will be saved" / "400 will die") against
  the gamble, in both frames and both option orders. People choose the sure option more in the
  gain frame (Tversky & Kahneman 1981); LLMs often reproduce this (Binz & Schulz 2023).
- Attribute framing: a 5-level quality rating of the same fact framed positively or negatively
  (Levin & Gaeth 1988).
- Anchoring: no anchor; an irrelevant "randomly drawn ticket number" in the state, low or high;
  a comparative question first ("higher or lower than 9 / 140?"), low or high (Tversky &
  Kahneman 1974; Strack & Mussweiler 1997, whose Gandhi anchors are used).
- Decoy: A and B trade off two attributes; a third option is worse than A on both, or worse than
  B on both; both option orders (Huber, Payne & Puto 1982).
- Likert: 5-point ascending and descending, 3-point, 7-point, endpoints-only labels, the reversed
  statement, and yes/no agree for the statement and its reversal.

### Metrics

For a yes/no item, every variant is read as P(claim): the yes probability, flipped for inverted
wordings; P(the "yes" or claim option) for choices; for 5-level scores, P(probably or definitely
yes) + half of P(unsure). With a right answer, P(right) = P(claim) if the claim is true, else
1 − P(claim).

- Accuracy: 1 if P(right) > 0.5, 0.5 at exactly 0.5, else 0 (choices: argmax, ties shared).
- Mean P(right).
- Δ P(right) vs canonical: paired per item, mean with a 95% percentile bootstrap interval over
  items (10,000 draws, fixed seeds).
- Flips: items whose answer is on the other side of 0.5 from the same item's canonical answer
  (choices: the top option changed).
- Shift: |P(claim) − P(claim, canonical)|, which is total variation distance for a yes/no;
  choices use total variation over the four options when the option set is the same.
- Complementary pairs: for X and not-X asked separately, P(yes|X) + P(yes|not-X) − 1. It is 0
  for a consistent answerer; positive is a yes bias (acquiescence), negative a no bias.
- Calibration: expected calibration error over 10 equal-width bins of max(P, 1 − P), across every
  yes/no answer with a right answer.
- Psychology effects: framing = P(sure | gain) − P(sure | loss), each averaged over both orders;
  attribute framing = expected rating positive − negative; anchoring = expected bin high − low
  anchor; decoy = A's share of {A, B} with the A-decoy − with the B-decoy; Likert acquiescence =
  agreement(statement) + agreement(reversal) − 1. Each with a bootstrap interval over items and a
  count of items in the human direction.

### Hypotheses and decision rules

Stated before recording, with the predicted direction.

1. Surface rewording (sentence form, register, synonyms, voice, length, hedges) leaves accuracy
   within 5 points of canonical and flips at most as often as the repeats. From Decide.
2. Explicit negation breaks invariance: on at least 20% of items, |P(yes|X) + P(yes|not-X) − 1|
   exceeds 0.2 for at least one inverted form. Double negation is worse than single negation.
3. Suggestion ("most people say …", "an expert said …") moves P(yes) towards the suggestion, more
   on debatable items than on items with a right answer.
4. Agree/disagree wording shows a yes bias (positive complementary sum).
5. Heavy typos (20%) lower P(right); light typos (5%), caps and missing punctuation do not.
6. Layouts that keep facts as labelled pairs (JSON, table, bullets, key=value, XML) match
   canonical; CSV, a JSON string, numbers as words and the long background lower P(right).
7. The question in another language costs little for Spanish, French and German and more for
   Hindi and Arabic; translating the facts too costs more than the question alone.
8. Answer shape matters more than wording (from Decide): choice and score forms flip more items
   than the sentence-form family.
9. Choices show a position bias: P(right) differs between the right option listed first and
   last; letters or numbers as keys lower accuracy against semantic keys.
10. Classic effects appear in the human direction: framing, attribute framing, anchoring
    (comparative more than irrelevant), and decoy.
11. Calibration error across all variants stays below 0.10.

Decision rules:

- A variant helps or hurts when its 95% interval for Δ P(right) excludes 0. With about 75
  variants on 20 items, about 4 will do so by chance, so a finding needs the interval to exclude
  0 and |Δ| ≥ 0.05 and at least 3 flips, or the same direction across most of a family.
- The noise floor is the two repeats: their flips and shifts. A family "moves Jev" when its flip
  rate is at least three times the repeats' flip rate.
- An invariance failure is a complementary pair off by more than 0.2 on one item.
- A psychology effect is present when the interval excludes 0 in the human direction, absent when
  the interval lies within ±0.05, and inconclusive otherwise.
- Accuracy numbers on 20 items move in steps of 5 points; read them with the intervals.

### Files

- `items.ts`, `translations.ts`: content. `text.ts`: typos, numbers as words, layouts.
- `variants.ts`: every item × variant as the exact request and how to read its answer.
- `metrics.ts`, `analyze.ts`: the analysis; `results.md` and `results.json` are generated.
- `record.ts`: the recorder. `pilot.ts`: the two feasibility requests.
- `prose.test.ts`: counts, validity, text helpers, metrics, and the whole analysis run on a fake
  Jev that always leans the right way (every variant must score 100%, every pair sum to 1).

Run from the repository root:

```sh
bun test jev-experiments/packages/arena/prose
bun jev-experiments/packages/arena/prose/record.ts
bun jev-experiments/packages/arena/prose/analyze.ts
```

### Sources

- Belinkov, Y. & Bisk, Y. (2018). Synthetic and natural noise both break neural machine
  translation. ICLR.
- Binz, M. & Schulz, E. (2023). Using cognitive psychology to understand GPT-3. PNAS 120(6).
- Gibson, E. (1998). Linguistic complexity: locality of syntactic dependencies. Cognition 68.
- Hosseini, A. et al. (2021). Understanding by understanding not: modeling negation in language
  models. NAACL.
- Huber, J., Payne, J. W. & Puto, C. (1982). Adding asymmetrically dominated alternatives.
  Journal of Consumer Research 9(1).
- Kassner, N. & Schütze, H. (2020). Negated and misprimed probes for pretrained language models.
  ACL.
- Krosnick, J. A. (1991). Response strategies for coping with the cognitive demands of attitude
  measures in surveys. Applied Cognitive Psychology 5(3).
- Ladd, D. R. (1981). A first look at the semantics and pragmatics of negative questions and tag
  questions. CLS 17.
- Levin, I. P. & Gaeth, G. J. (1988). How consumers are affected by the framing of attribute
  information before and after consuming the product. Journal of Consumer Research 15(3).
- Li, C. et al. (2023). Large language models understand and can be enhanced by emotional
  stimuli (EmotionPrompt). arXiv:2307.11760.
- Liu, N. F. et al. (2023). Lost in the middle: how language models use long contexts. TACL.
- Loftus, E. F. & Palmer, J. C. (1974). Reconstruction of automobile destruction. Journal of
  Verbal Learning and Verbal Behavior 13(5). Loftus, E. F. (1975). Leading questions and the
  eyewitness report. Cognitive Psychology 7(4).
- Pezeshkpour, P. & Hruschka, E. (2023). Large language models sensitivity to the order of
  options in multiple-choice questions. arXiv:2308.11483.
- Ribeiro, M. T. et al. (2020). Beyond accuracy: behavioral testing of NLP models with CheckList.
  ACL.
- Schuman, H. & Presser, S. (1981). Questions and Answers in Attitude Surveys. Academic Press.
- Sclar, M. et al. (2023). Quantifying language models' sensitivity to spurious features in
  prompt design. arXiv:2310.11324 (ICLR 2024).
- Sharma, M. et al. (2023). Towards understanding sycophancy in language models.
  arXiv:2310.13548.
- Shi, F. et al. (2023). Large language models can be easily distracted by irrelevant context.
  ICML.
- Strack, F. & Mussweiler, T. (1997). Explaining the enigmatic anchoring effect. JPSP 73(3).
- Tjuatja, L. et al. (2024). Do LLMs exhibit human-like response biases? A case study in survey
  design. TACL.
- Truong, T. H. et al. (2023). Language models are not naysayers: an analysis of language models
  on negation benchmarks. *SEM.
- Tversky, A. & Kahneman, D. (1974). Judgment under uncertainty: heuristics and biases. Science
  185. Tversky, A. & Kahneman, D. (1981). The framing of decisions and the psychology of choice.
  Science 211.
- Zheng, C. et al. (2023). Large language models are not robust multiple choice selectors.
  arXiv:2309.03882 (ICLR 2024).

## What was run

30 Sep 2026, 06:57–08:00 UTC, through the Vercel AI Gateway as `typesafe-ai/jev` (build not
named; see `../recordings/README.md`). All 2,626 requests answered: 2,625 answers plus one
Score the gateway rejected (dolphin, 5-level descending), excluded as the protocol says. 2,634
attempts; 8 were 503 busy replies, waited out. Hosts: `typesafe-ai` 2,465, `digitalocean` 160.
Service latency p50 249 ms, p90 389 ms. Cost as reported by the gateway: $0.0371 for 882,391
input tokens, pilot included (2,628 successful requests). Budget limits were $1.00 and 5,000
requests.

Every table below comes from `analyze.ts`, as frozen, and is copied from `results.md`, which has
all 170-odd rows. Numbers marked "exploratory" come from `explore.ts`, written after the run
to find examples; they don't change any frozen metric.

## Results

### The short version

Jev is good at:

- Ignoring surface form. On 20 yes/no items with right answers, 7 sentence forms × 20 items
  flipped nothing (0 of 140). Each register, voice, synonym, length, hedge, persona, stakes and
  noise variant flipped at most 1 of 20 items. The two repeats moved answers 0.007 on average,
  and most wording families moved them 0.01–0.03.
- Layout. Eleven layouts of the same facts (prose, table, bullets, `key=value`, CSV, JSON
  array, XML, snake_case keys, JSON in a string, nested, facts in the instructions) flipped 2 of
  220 answers, both toward the right answer. Shuffled facts, distractors, a 420-word irrelevant
  paragraph and numbers written as words lowered P(right) by at most 0.02.
- Language. The question in Spanish, French, German, Chinese, Japanese, Hindi or Arabic, with or
  without translated facts, flipped 2 of 280 answers. Hindi and Arabic questions lower P(right)
  by 0.03 and 0.02, well below any flip.
- Negation, when it knows the answer. "Is it false that …", "Is it true that not …" and a
  negated statement kept 90–95% accuracy. On the 17 items Jev gets right, P(yes|X) and
  P(yes|not-X) sum to within 0.2 of 1 on every pair but two (both on "cart").
- Option order and labels in choices. Moving the right option from first to last, reversing
  the options, or relabelling them as letters, numbers or random ids changed no top answer on
  16 items.
- Knowing when it knows. 1,251 of the 1,559 scored yes/no answers were stated at 90% or more,
  and 1,250 of them were right.

Jev is not good at:

- The same three items, however they are asked. It says a refund 39 days after purchase fits
  a 30-day window (right under 5 of 78 forms), that 3 nights at $210 fit a $600 budget (4 of
  78), and that `sunflower88` has at least 12 characters (17 of 78, mostly near 0.5). Those are
  date arithmetic, multiplication and character counting. The one choice it misses is also a
  date: "2026-10-01 is a Thursday; what day is 2026-10-05?" gets Tuesday at 0.84. Form doesn't
  cause these errors and rewording doesn't fix them.
- Statements that describe a question instead of asking it. "The question that the facts that
  are listed above bear on is whether or not, all things considered, X." moved P(right) by −0.23
  [−0.34, −0.13] and pushed false claims towards yes (mean +0.38 on false items, exploratory):
  "the driver is old enough to rent a car" went from 0.03 to 0.88. A yes/no returns P(true) of
  its instructions, and this sentence is literally true whatever X is, so the result depends on
  how Jev reads the sentence. It reads it as asserting X. On debatable items the same form raised
  P(claim) by +0.29 and flipped 5 of 10.
- "Most people say no." Adding it to the question lowered P(right) by −0.20 [−0.30, −0.09] and
  flipped 5 of 20. It works only on true claims (mean P(claim) −0.37 on true items, +0.02 on
  false ones, exploratory): "Is Madrid warmer than Oslo today? Most people say no." went from
  0.99 to 0.48 with 27 °C against 12 °C in the facts. "Most people say yes" did nothing to items
  with a right answer (−0.02 and +0.03), but did raise debatable ones (+0.10 [+0.05, +0.16]).
- Consistency where it is unsure. Invariance failures sit almost entirely on the items it gets
  wrong. For "password", P(yes) for the claim and for its negation both came out above 0.5 under
  five of six pairings (sums 1.24–1.36). On uncertain items, negated and suggestive forms push
  answers towards "no".
- The decoy effect, strongly. Adding a third option that is worse than A on both attributes
  raises A's share of {A, B} against a decoy for B by +0.47 [+0.38, +0.56], in all 8 scenarios.
  "Rent $1,200, 45-minute commute" gets 7% of the pair next to a decoy for the other
  apartment and 68% next to its own decoy. People show the same bias
  (Huber et al. 1982). Jev shows it much more strongly than the typical human study.
- Attribute framing. The same fact framed positively gets a higher rating by +1.04 levels of 5
  [+0.30, +1.92], in 5 of 6 items. "Makes 40% of her shots" scores 2.97 of 4; "misses 60%" 0.15.
- Option position in two-option framing questions, which is new. In the Asian-disease questions
  the option listed second is preferred: P(sure) is 0.13 [0.06, 0.19] lower when the sure option
  is listed first. The option labelled "Program B" got 0.56 on average.

### Hypotheses

| # | Prediction | Result |
| --- | --- | --- |
| 1 | Surface rewording within 5 points, flips at noise level | Supported, except the centre-embedded sentence (see above). |
| 2 | Negation breaks invariance on ≥ 20% of items; double worse than single | Borderline: 4 of 20 items have a pair off by > 0.2, 3 of them items Jev already gets wrong. Double negation is slightly worse (Δ −0.03 and −0.05, CIs exclude 0, no flips); single negation is no worse than the question. |
| 3 | Suggestion moves P(yes), more on debatable items | Mixed. "Most say no" hurts items with a right answer (5 flips); "most say yes" moves only debatable ones; "an expert said" moves neither. |
| 4 | Agree/disagree shows a yes bias | Not found. Truth items +0.016 [−0.013, +0.049]; debatable items lean no, −0.065 [−0.11, −0.01]. |
| 5 | Heavy typos hurt, light ones don't | Supported, small: 20% typos −0.08 [−0.18, −0.01], 1 flip. The damage comes when a key word is destroyed ("Js edry teamm mejebr cmpltdd te traoning?" lost "every" and went from 0.01 to 0.83). 5% typos, caps, lowercase: no change. |
| 6 | CSV, JSON string, numbers as words, long background hurt | Rejected. No layout or context variant lowers P(right) by more than 0.02. |
| 7 | Other languages cost little for es/fr/de, more for hi/ar; full translation costs more | Direction right, size negligible: Hindi −0.03, Arabic −0.02, others within ±0.01. Full translation costs no more. |
| 8 | Answer shape moves Jev more than wording | Partly. Shapes flip 1 of 139 truth answers but make Jev more confident (+0.03 to +0.05 P(right), all six CIs exclude 0). On debatable items they move P(claim) 0.15 on average against 0.03 for sentence forms, with 2 flips in 70. |
| 9 | Position bias in choices; letters/numbers lower accuracy | Rejected. Right option first − last: −0.027 [−0.056, −0.004], a slight preference for last. Labels: no change. |
| 10 | Framing, attribute framing, anchoring, decoy in the human direction | Risky-choice framing: absent or inconclusive, −0.06 [−0.13, +0.02], 2 of 10 in the human direction. Attribute framing: present. Anchoring: an irrelevant ticket number shifts estimates +0.06 levels [+0.02, +0.12] (10 of 12), present but tiny, and every estimate stays in the right bin; the comparative anchor is absent (−0.003 [−0.03, +0.03]). Decoy: present and large. |
| 11 | Calibration error < 0.10 | Met narrowly, 0.097, but the shape matters more than the number (below). |

### Yes/no with a right answer, by family

Accuracy is over 20 items (10 true, 10 false); the canonical form is 85% (17 of 20). Flip rate
counts item × variant cells whose answer landed on the other side of 0.5 from the same item's
canonical answer.

| Family | Cells | Accuracy | Flip rate | Mean shift |
| --- | --- | --- | --- | --- |
| baseline (2 repeats) | 40 | 85% | 0% | 0.007 |
| sentence-form | 140 | 85% | 0% | 0.012 |
| lexical-syntax | 60 | 83% | 8% | 0.086 |
| length | 40 | 89% | 5% | 0.025 |
| register | 80 | 86% | 1% | 0.018 |
| hedge-intensifier | 40 | 88% | 3% | 0.030 |
| noise | 80 | 84% | 1% | 0.035 |
| negation | 120 | 90% | 5% | 0.045 |
| suggestion | 80 | 91% | 11% | 0.102 |
| acquiescence | 40 | 89% | 5% | 0.035 |
| presupposition | 40 | 88% | 3% | 0.036 |
| stakes-persona | 60 | 85% | 0% | 0.022 |
| answer-shape | 139 | 86% | 1% | 0.028 |
| representation | 220 | 86% | 1% | 0.021 |
| context | 80 | 89% | 4% | 0.033 |
| language-question | 140 | 86% | 1% | 0.023 |
| language-full | 140 | 86% | 1% | 0.026 |

Accuracy above 85% in a family is not an improvement from form. On the three items Jev gets
wrong it sits near 0.5, so a form that nudges those answers towards "no" crosses 0.5 and scores
as right. Look at mean P(right) and the flip counts per variant in `results.md`.

Variants that pass the pre-registered bar (CI excludes 0, |Δ| ≥ 0.05, at least 3 flips):
centre-embedded (−0.228, 3 flips) and "most people say no" (−0.198, 5 flips). Variants with a
CI that excludes 0 but too small to count: heavy typos (−0.078, 1 flip), "is it not the case
that not-X" (−0.054, 0 flips), "is it false that not-X" (−0.033), "most say yes" (−0.025), extra
distractor fields (−0.019), lenient persona (−0.016), "given that X" (−0.007), Hindi (−0.031),
Arabic (−0.019) and Japanese (−0.011) questions; and on the helpful side, the six choice and score
shapes (+0.026 to +0.045). With about 75 comparisons, about 4 would exclude 0 by chance.

### Complementary pairs (truth items)

P(yes | X) + P(yes | not-X) − 1, where 0 is consistent.

| Pair | Mean [95% CI] | Pairs off by > 0.2 |
| --- | --- | --- |
| question / "is it false that" | +0.042 [+0.002, +0.092] | 2 |
| "is it true that X" / "… not-X" | +0.026 [+0.002, +0.054] | 0 |
| statement / negated statement | +0.037 [+0.005, +0.076] | 1 |
| "do you agree that X" / "… not-X" | +0.016 [−0.013, +0.049] | 1 |
| "an expert said X" / "… not-X" | +0.036 [−0.001, +0.081] | 3 |
| "given that X, confirm" / "… not-X" | +0.045 [+0.006, +0.089] | 3 |

Every failure (exploratory) is on refund, hotel, password or cart. Worst: password, "Does the
proposed password meet the rule?" 0.56 and "Is it false that the proposed password meets the
rule?" 0.80, a sum of 1.36. Cart is the one the model gets right: "Given that the three items
together do not fit within the budget, confirm: is that correct?" got 0.28 against 0.95 for the
positive form; with a false premise, Jev half accepts it. On debatable items the pairs lean the
other way (−0.08 for "is it true that X / not-X"), so there is no general yes bias.

### Calibration

| Stated confidence | Answers | Accuracy |
| --- | --- | --- |
| 50–60% | 81 | 31% |
| 60–70% | 89 | 17% |
| 70–80% | 89 | 18% |
| 80–90% | 49 | 84% |
| 90–100% | 1,251 | 99.9% (1,250) |

The calibration error is 0.097. That comes from a split between answers Jev is sure of, which
are right 1,250 times in 1,251, and a middle band (60–80%) that is mostly the three wrong items asked in
different ways. Over this set, "confidence ≥ 0.9" was a near-perfect filter, and 60–80% meant
"probably wrong". That comes from 20 items, three of them wrong, so it describes these items,
not a general law.

### Choices (16 items)

Canonical accuracy 94% (15 of 16; the miss is the weekday). No position, reversal, label,
imperative, typo, Spanish or Chinese variant changed a top answer. Two options raised P(right)
+0.07, six options lowered it −0.04 [−0.11, −0.003] and cost one item. Asking one yes/no per
option and renormalising kept the same top answers but lowered P(right) by −0.125 [−0.20,
−0.07]. The four yes/no answers per item summed to 1.10 on average (0.66 to 2.12, exploratory),
so they are not a distribution until code normalises them.

### Debatable yes/no (10 items)

Without a right answer, the useful numbers are shifts. The repeats moved P(claim) 0.008–0.015.

| Variant | Δ P(claim) [95% CI] | Flips of 10 |
| --- | --- | --- |
| "Is it absolutely, definitely, 100% true that …" | −0.293 [−0.367, −0.215] | 5 |
| centre-embedded statement | +0.288 [+0.192, +0.381] | 5 |
| "I might be wrong, but is it perhaps …" | +0.073 [+0.047, +0.099] | 0 |
| "Is it not the case that not-X" | +0.103 [+0.021, +0.178] | 1 |
| "… Most people say yes." | +0.100 [+0.046, +0.155] | 1 |
| "… Most people say no." | −0.006 [−0.124, +0.129] | 6 |
| lenient friend persona | +0.059 [−0.045, +0.166] | 4 |
| choice between the two statements | −0.082 [−0.193, +0.043] | 1 |
| 5-level score | +0.095 [−0.011, +0.195] | 0 |

Hedges and intensifiers barely touch items with a right answer but move debatable items a lot,
and in a sensible direction: a claim that must be "100% true" is harder to accept. "Most people
say no" moved debatable items towards 0.5 from both sides, which flips 6 of 10 without shifting
the mean.

### Psychology studies

| Effect | Measure | Result | Human direction |
| --- | --- | --- | --- |
| Risky-choice framing | P(sure), gain − loss | −0.060 [−0.130, +0.015] | 2 of 10 |
| Option order in those questions | P(sure) listed first − second | −0.127 [−0.189, −0.061] | |
| Attribute framing | rating, positive − negative (0–4) | +1.04 [+0.30, +1.92] | 5 of 6 |
| Anchoring, irrelevant number | expected bin, high − low | +0.061 [+0.015, +0.117] | 10 of 12 |
| Anchoring, comparative question | expected bin, high − low | −0.003 [−0.031, +0.026] | 4 of 12 |
| Decoy (attraction) | A's share, A-decoy − B-decoy | +0.473 [+0.381, +0.555] | 8 of 8 |
| Decoy option order | A's share, A listed first − last | +0.173 [+0.087, +0.257] | |
| Likert direction | 5-point descending − ascending | −0.018 [−0.023, −0.014] | |
| Likert acquiescence, 5-point | agree + agree(reversed) − 1 | +0.040 [+0.023, +0.064] | |
| Likert acquiescence, yes/no | same | −0.100 [−0.155, −0.036] | |

Jev picked the decoy itself 4–9% of the time. Anchoring questions were all answered in the
right bin (all 60), so anchors only nudge its confidence. Framing shows no gain/loss effect,
but a preference for whichever program is listed second. The two orders were
counterbalanced, so that preference doesn't bias the framing estimate, but it does add noise.

## Limitations

- 20 items with right answers, 16 choices, 10 debatable items: accuracy moves in 5- or
  6-point steps and intervals are wide. The three wrong items dominate the invariance and
  calibration results; a different item set would move them.
- One answer per item × variant. The repeats show Jev is nearly deterministic (0.007 mean
  shift), so the flips are about form, not sampling. It is still one draw per form.
- The centre-embedded variant is confounded: as a yes/no, the sentence is true whatever X is.
  It shows that Jev reads such sentences as asserting X. It does not isolate syntactic
  complexity. A real garden-path or embedded question would need its own test.
- The hedge, intensifier and persona forms change the meaning somewhat ("perhaps", "100%
  true"). On debatable items their shifts can be correct behaviour, not bias.
- Translations are one author's, without back-translation; Hindi and Arabic are the likeliest
  to read unnaturally, which may be part of their small drop.
- The Likert reversals are not exact negations ("fine" vs "rude" for texting), so their
  acquiescence numbers include content differences.
- Framing isomorphs share one template; ten scenarios are not ten independent replications of
  Tversky and Kahneman.
- Gateway build unknown and two hosts served answers (`digitalocean` 6%); host was not
  balanced across variants beyond the shuffled order.

## Deviations from the frozen protocol

- After 911 answers the recorder stopped on a rejected Score. A request whose only question is a
  Score the gateway rejects comes back as a thrown 502, which `record.ts` treated as fatal.
  The recorder now logs it as `status: "rejected"` and moves on without asking again, as the
  protocol requires; the one affected attempt got an appended reclassification row. `analyze.ts`
  counts those rows as rejected, not busy, and sums cost over every row. No metric or rule
  changed. See `NOTES.md`.
- `explore.ts` was added after the run for examples; it is labelled exploratory throughout.

## Recordings

- `explore.ts`: the post-hoc example look-ups.
- `recordings/prose.jsonl.gz` (165 KB): every attempt, append-only. The raw `.jsonl` is
  gitignored; `analyze.ts` reads either and gives identical output.
- `recordings/pilot.jsonl`: the two feasibility requests.
- `results.md`, `results.json`: generated by `analyze.ts`.
