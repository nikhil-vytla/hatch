DeepSWE at `/tmp/parallax-deep-swe` is Datacurve's 113-task Harbor-format benchmark ([deep-swe repo](https://github.com/datacurve-ai/deep-swe), [Pier runner](https://github.com/datacurve-ai/pier)) derived from swe-bench-ultra instances identified by `kh…` ext_ids. Each task under `tasks/<task-id>/` bundles `task.toml` metadata (repo URL, `base_commit_hash`, ECR `docker_image`), an `instruction.md` prompt, agent `environment/Dockerfile`, separate verifier assets in `tests/` (shared `grader.py`, task-specific `test.sh`/`test.patch`/`config.json`), and held-out `solution/` patches graded only via behavioral f2p/p2p test whitelists—not reference diffs.

- **Run verifier**: `pier run -p /tmp/parallax-deep-swe/tasks/<task-id> --agent oracle -e docker`
- **No train/test split** in-repo; use `--n-tasks` + `--sample-seed` for subsets
- **10 prompt variants/task reusing verifiers**: not scientifically independent; spec/test changes need new oracle-derived whitelists and images
