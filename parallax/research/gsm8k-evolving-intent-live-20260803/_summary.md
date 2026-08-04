# Summary

Parallax's oldest open gap is closed: the GSM8K Evolving Intent pipeline had
never been run against a real provider, and now it has, over 144 source tasks ×
3 arms × 3 trials against [Claude Haiku
4.5](https://www.anthropic.com/claude/haiku) through the HUD gateway for $10.96
in metered tokens, with zero run failures across 1,296 graded episodes.
Presenting the same verifiable task through an evolving intent trajectory rather
than a single fully-revealed turn cost 10.9 accuracy points (95% bootstrap CI
6.0 to 16.0, clustered by source); because all three arms ran, that gap splits
into 8.6 points from multi-turn presentation alone and 2.3 points from intent
evolution on top of it, the latter spanning zero. The more valuable output was
the defect list: going live broke five things the 124-test offline suite could
not reach, three of which would have silently invalidated the whole experiment,
all because scripted test agents satisfy contracts that real models do not. The
three-arm design is being retired in favour of base versus evolved, since the
matched control produced the widest interval and smallest estimate in the study
for roughly 45% of the episode budget — a tradeoff that also gives up the
decomposition above.

- Nothing ever told a real model about the `FINAL_ANSWER:` submission contract
  the [native grader](https://github.com/openai/grade-school-math) requires;
  Haiku answered in Markdown prose, so every episode in every arm would have
  graded `invalid`.
- Construction prompts never stated their JSON schema, and the GSM8K parser had
  no Markdown-fence tolerance that `swebench.py` had already learned to need.
  After both fixes, 0 of 834 construction attempts were rejected.
- `load_gsm8k` cannot load the official GSM8K test split at all: 14 of 1,319
  sealed answers use a thousands separator. Left unfixed on purpose, since
  loosening it would change grading authority semantics; those rows are declared
  out of population.
- Trial seeds are recorded but not causally wired. The gateway accepts an
  OpenAI-style `seed` and silently ignores it (measured: same seed, different
  completions), so trials are temperature-1.0 samples rather than reproducible
  replicates. Temperature was verified causal before the design was frozen.
- Two defects were in this work's own code, both invisible without a live run: a
  resume path that crashed on first use under Pydantic strict mode, and a
  source-clustered bootstrap whose interval depended on evidence row order.
