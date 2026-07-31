# Exploration notes — /tmp/parallax-deep-swe

## Source
- Path: `/tmp/parallax-deep-swe`
- Git remote: `https://github.com/datacurve-ai/deep-swe.git`
- HEAD: `e016041` (shallow clone, depth 1)
- Read-only exploration; nothing modified under `/tmp/parallax-deep-swe`

## Structure discovered
- 113 task directories under `tasks/<task-id>/`
- Dataset index files: `tasks/manifest.json`, `tasks/manifest.schema.json`, `tasks/dataset.toml`
- No `tools/` directory in published repo (referenced only in grader.py comments)

## Key files per task (Harbor v1.3 / DeepSWE v1.1)
```
task.toml              metadata + docker_image + base_commit_hash + verifier config
instruction.md         agent-facing prompt
pre_artifacts.sh       git diff base..HEAD -> /logs/artifacts/model.patch
environment/Dockerfile reproducible agent image build
tests/Dockerfile       verifier image (agent image + baked tests/)
tests/test.sh          shared frame + task-specific test runner middle
tests/grader.py        shared grading logic (identical MD5 across all 113 tasks)
tests/config.json      base_commit, f2p/p2p whitelists, grade config
tests/test.patch       hidden fail-to-pass tests (not visible to agent)
solution/solution.patch reference implementation
solution/solve.sh      oracle agent applies patch + commits
```

## Execution paths tried
- Installed `datacurve-pier` via `uv tool install datacurve-pier`
- Docker daemon not running in this VM (`Cannot connect to Docker daemon`)
- Could not pull ECR images or run live verifier

## Consistency checks
- `base_commit_hash` in task.toml == `base_commit` in tests/config.json == hash in pre_artifacts.sh (0 mismatches / 113)
- All 113 tasks: `verifier.environment_mode = "separate"`
- grader.py: single hash `5ad8ec80d0fd95fafcd24b5b6db479aa` across all tasks

## Split / variant metadata
- No train/val/test split files in repo
- Subset sampling via Pier: `--n-tasks N --sample-seed S`
- `manifest.json` maps swe-bench-ultra `ext_id` (kh...) to public `task_id`
- `dataset.toml` lists Harbor registry digests `datacurve/<task-id>`

## 10 variants assessment
- Prompt-only paraphrase while reusing verifier: not scientifically independent
- Any spec/test change requires new f2p/p2p derivation and likely new test.patch + solution.patch
- Legitimate expansion = fully re-authored tasks, not automated perturbation of existing tuple
