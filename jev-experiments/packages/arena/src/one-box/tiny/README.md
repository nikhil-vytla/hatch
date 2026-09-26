# Tiny model (One box contestant)

A small classifier that answers One box's 14 questions in about 0.01 ms per prefix, in process.
It is **distilled from Jev's outputs**: it learns to copy Jev's recorded top answers. That is a
research-preview comparison, which the user accepted for benchmarks; it is not a Jev
replacement and not trained on any authored label.

## Model

The repo's existing tiny-classifier recipe (`src/jev_lab/teach.py`): one shared TF-IDF
vocabulary (word unigrams and bigrams, sublinear TF, L2 normalisation, 3,000 terms) and one
`LogisticRegression(C=4)` head per question. Choice questions are multiclass over their
options; yes/no questions are two classes (the answer is P(yes)); the two 0–2 scores are three
classes (the answer is the expected level, confidence the top probability). Weights are rounded
to 4 decimals.

| File              | Size    | What                                                                         |
| ----------------- | ------- | ---------------------------------------------------------------------------- |
| `vectorizer.json` | 98 KB   | vocabulary and IDF                                                           |
| `heads.json`      | 1.48 MB | 14 heads                                                                     |
| `parity.json`     | 334 KB  | 200 dev prefixes and the exported model's probabilities, computed in sklearn |
| `training.json`   | small   | counts and training accuracy                                                 |

`../tiny.ts` runs it in TypeScript with the same tokenisation as sklearn; `../tiny.test.ts`
requires the sklearn probabilities to within 1e-9 on the parity sample.

## Data and the held-out rule

Training rows are Jev's recorded answers (`recordings/one-box.jsonl.gz`) for every prefix of a
**development** phrase, labelled with Jev's top option per question. Any prefix that is also a
prefix of a held-out phrase is excluded (1,502 keys, mostly short shared starts like "bu"), so
no held-out text is ever seen. That leaves 4,164 training prefixes from 150 phrases.

Training accuracy against Jev's labels: intent 95.2%, readiness 93.1%, isQuestion 98.8%,
recurring 97.0%, urgency 97.8%, tone 98.7%, eventMode 99.2%, transport 99.0%, tripType 98.5%,
expenseCategory 97.2%, colorMood 94.1%, timerKind 96.0%, hasExplicitOptions 98.4%,
isShoppingList 97.1%.

## How well it generalises

The committed model trained on every development prefix, so replaying it on development
phrases is in-sample (its box ends on the right card for 95.3% of them). The honest estimate
is five-fold cross-validation over development phrases (`scripts/one-box-tiny-cv.ts`): each
phrase is replayed with a model that never saw any of its prefixes. Out of fold, the box ends
on the right card for **26.7%** of development phrases (38.7% for the full phrase alone), with
0.13 wrong commits and 1.90 visible changes per phrase. About 4,000 prefixes from 120 phrases
is not enough for word features to generalise to new phrasings; the model is often unsure, so
the calm rules keep waiting rather than commit.

## Reproduce

```sh
bun packages/arena/scripts/one-box-tiny-data.ts
uv run --no-project --with scikit-learn==1.9.1 --with numpy==2.5.3 \
  python packages/arena/scripts/train-one-box-tiny.py
bun packages/arena/scripts/record-one-box-tiny.ts      # recordings/one-box.tiny.jsonl.gz
uv run --no-project --with scikit-learn==1.9.1 --with numpy==2.5.3 \
  python packages/arena/scripts/train-one-box-tiny.py --cv
bun packages/arena/scripts/one-box-tiny-cv.ts          # out-of-fold dev estimate
```

Training is deterministic: rerunning reproduces `vectorizer.json` and `heads.json` byte for byte.
The recording holds every prefix of all 200 phrases (predictions only), numbers rounded to 4
decimals, latency recorded as 1 ms (the measured median is 0.008 ms for all 14 heads).
