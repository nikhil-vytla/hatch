# IFEval benchmark and content review

- Requested: audit benchmark prompts and generated language for offensive content; show external dataset provenance in the UI; replace experiment 28 with IFEval-only evaluation, ideally the full dataset; identify the Qwen generator and judge; use GPT-5.6 Sol subagents for independent judging instead of the Gemini reference.
- Starting with repository instructions, current published data, and the local generation/evaluation pipeline.

- User paused implementation to clarify the experiment's purpose. Jev selects among Qwen candidates; IFEval provides executable scoring. Gemini was a reference writer, not a judge, and an LLM judge is unnecessary for IFEval's formal metrics.
- Checked the pinned IFEval source for determinism. Most checks use counts, regexes, parsing, and tokenization. Language checks and English casing checks call `langdetect.detect`, which is nondeterministic without `DetectorFactory.seed`.
- The current lab wrapper does not set that langdetect seed. A constructor audit across all 541 pinned cases found two random fallback calls: cases 1122 and 1129 supply `#` and `!` respectively to the letter-frequency checker, which accepts only ASCII letters and replaces either punctuation character with a random letter. An initial audit script also mishandled parameterless checkers returning None; correcting that script left just these two findings.
- Practical experiment implication: code-based selection is an essential baseline where executable checks are available. Jev's useful distinction would be semantic criteria that those checks do not cover, or predicting checks when no executable verifier is available at runtime.
