# Prose studies: working notes

Append-only log of what was tried and learned.

## 2026-09-29

- Read the Decide README (rewording never flipped Jev in 40 tries; answer shape and splitting
  did), the recordings README (position/batching robustness on Tetris spots: reversed order
  moved judgements 0.027 on average, one-at-a-time 0.049), the checkable README (Jev strong on
  reading/judging, weak on counting and route-finding; calibration error 0.010 on judgement
  items) and the Banking77/CLINC robustness summary in `jev-experiments/README.md`.
- Chose one question per request for every variant, so no variant sees another variant's
  wording. Batching variants would contaminate them.
- Feasibility pilot (`pilot.ts`, 2 requests, excluded from analysis): the gateway accepts a
  plain-string state and an empty-object state. Both answered by host `typesafe-ai`, 270–282
  input tokens, $0.0000113–0.0000118 each, no busy replies. A plain yes/no answer comes back
  with two decimals (0.98, 0.66).
- Authored 20 truth items (10 true / 10 false), 10 debatable items, 16 choice items (right
  option at each position 4 times), 10 framing, 6 attribute framing, 12 anchoring, 8 decoy and
  10 Likert items; translated every truth item's question and prose facts into es, fr, de, zh,
  ja, hi, ar by hand. Values (numbers, times, dates, names, the password) stay verbatim, except
  Sydney's population, which zh/ja write as "500 万".
- Double negation "Is it not the case that not-X?" is ambiguous in English (a negative polar
  question can be read as biased towards not-X, Ladd 1981). Kept it, scored it with the logical
  reading, and flagged it; "Is it false that not-X?" is the unambiguous double negation.
- `numbersAsWords` leaves numbers inside codes alone (sunflower88, HB-44817) and reads clock
  times as "nine hundred" / "ten thirty".
- Wrote a fake always-right Jev into the tests: every variant must score 100% and every
  complementary pair sum to 1. It caught nothing, but it pins the polarity bookkeeping.
- Froze the protocol (commit e00acb3) and started `record.ts`: 2,626 requests. First requests
  came back at about 1.1 s each including the 700 ms gap, with no busy replies.
- Deviation 1 (07:13 UTC, 30 Sep, after 911 answers): a request whose only question is a Score
  the gateway rejects comes back as a thrown 502 `native_score_mismatch`, not as an answer with
  `rejected`. `record.ts` treated that as fatal and stopped. The protocol already says a
  rejected Score is final and excluded, so the recorder now logs it as `status: "rejected"` and
  moves on (never re-asks), and the one crashed attempt (dolphin, score-5-descending) got an
  appended reclassification row rather than a second ask. `analyze.ts` counts those rows as
  rejected, not busy, and now sums cost over every row (error rows carry cost too). No metric
  or rule changed.
- Run finished 08:00 UTC: 2,626 answered (1 rejected Score), 8 busy 503s, $0.0371 in total,
  hosts typesafe-ai 2,465 / digitalocean 160. The gzipped log (165 KB) gives byte-identical
  `results.md` to the raw log.
- First read of the results: form barely matters on items Jev knows; three items (refund dates,
  hotel multiplication, password length) are wrong under nearly every form. The failures that do
  come from form are the centre-embedded statement (read as asserting the claim), "Most people
  say no" (only pulls true claims down), and, among the psychology effects, decoy and attribute
  framing (large). There is no risky-choice framing effect, but the second-listed program is
  preferred.
- Wrote `explore.ts` for examples (post hoc, labelled so). It found that every invariance
  failure is on refund, hotel, password or cart, and that the heavy-typo flips come from
  destroyed key words ("every" → "edry").
- Realised the centre-embedded variant is confounded: as a yes/no, "The question … is whether
  X." is true whatever X is. Reported as such rather than as a pure syntax result.
- Calibration: 1,250 of 1,251 answers stated at ≥ 90% were right; the 60–80% band was 17–18%
  right, which is the wrong items asked in different ways.
