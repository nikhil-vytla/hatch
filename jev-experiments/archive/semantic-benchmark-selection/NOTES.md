# Semantic benchmark selection

- User wants a replacement for IFEval after concluding that approximating executable validators is not a compelling Jev use case.
- Desired experiment: a small Qwen writer generates candidates, Jev selects according to a semantic brief, and independent evaluation measures useful improvement.
- Research will compare public benchmarks for semantic requirements, response selection, human preferences, reproducibility, content suitability, and overlap with the existing JudgeBench experiment.
- Considered WritingBench, FollowBench, WildBench, SummEval, and RewardBench 2. The user chose RewardBench 2, so the implementation uses its supplied candidates rather than generating new Qwen answers. See `../rewardbench2/` for the selected method and results.
