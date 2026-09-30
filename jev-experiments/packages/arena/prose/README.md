# Prose studies: the same decision, asked many ways

Jev takes a typed question and returns a calibrated distribution. These studies hold each
decision's content fixed and change only its form: the wording, the language, the layout of the
facts, the answer shape, and the framings that psychology and survey research know move people.
The aim is a map of what Jev is good at and what it isn't, measured against right answers where
they exist.

Earlier work in this repo found that rewording never flipped Jev's answer in 40 tries on Decide,
while answer shape and splitting did (`../src/decide/README.md`), and that reversing option
order barely moved Tetris spot judgements (`../recordings/README.md`). Those were small and
mostly unscored. This study covers 76 forms of the same question on 20 yes/no items with known
answers, plus debatable items, choices, and six classic effects from psychology.

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

## Results

Not yet recorded.
