# IFEval review, paused at experiment design

Historical review: the user subsequently selected RewardBench 2. The [replacement report](../rewardbench2/README.md) describes the implemented experiment and integration of the content-audit findings below.

The user paused implementation to discuss what Jev is intended to do. The proposed experiment evaluates whether Jev can select a better response from four drafts written by Qwen3-0.6B, using IFEval's executable checks as independent scoring. Gemini previously generated a separate reference response; it was not the judge. No new model generation or application changes have been made during this review.

## Evaluator determinism

The pinned Google Research revision is `4700efb9afa54286b0e04473ba80a13e8461e25f`, containing 541 IFEval cases. Most checks use counting, matching, parsing, or tokenization. The implementation has two exceptions to a blanket claim of determinism:

- Language identification, including English casing checks, uses `langdetect`, whose documentation describes nondeterminism on short or ambiguous text without a fixed `DetectorFactory.seed`. The current lab wrapper does not set that seed.
- Instantiating each checker with the dataset's arguments found two calls to random fallback generation. Cases 1122 and 1129 supply `#` and `!` to the letter-frequency checker. Its constructor replaces these punctuation characters with randomly selected ASCII letters, so it checks a different requirement. Seeding alone would not repair that mismatch.

Sources: [pinned checker implementation](https://github.com/google-research/google-research/blob/4700efb9afa54286b0e04473ba80a13e8461e25f/instruction_following_eval/instructions.py), [langdetect reproducibility guidance](https://github.com/Mimino666/langdetect#basic-usage).

For a revised experiment, code-based selection should be a baseline wherever these executable checks are available. Jev's separate value would concern semantic requirements absent from those checks, or predicting outcomes where an executable verifier is unavailable at runtime. Any evaluator corrections should be disclosed separately from upstream scores.

## Content audit

The requested GPT-5.6 Sol subagent completed a separate [content audit](content-audit/README.md). Its results await integration and root-agent review; there have been no content removals or UI changes.
