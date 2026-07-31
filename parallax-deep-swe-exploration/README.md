# DeepSWE (`/tmp/parallax-deep-swe`) — structure & verifier analysis

Investigation of the Datacurve [DeepSWE](https://deepswe.datacurve.ai/) benchmark checkout at `/tmp/parallax-deep-swe` (mirror of [datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe)).

## Repository layout

| Path | Role |
|------|------|
| `/tmp/parallax-deep-swe/README.md` | Benchmark overview, Pier quickstart |
| `/tmp/parallax-deep-swe/PROVENANCE.md` | Per-task upstream repo + license table (113 rows) |
| `/tmp/parallax-deep-swe/LICENSE` | Apache-2.0 on Datacurve harness/specs only |
| `/tmp/parallax-deep-swe/tasks/manifest.json` | ID mapping + display labels (source: swe-bench-ultra) |
| `/tmp/parallax-deep-swe/tasks/manifest.schema.json` | JSON schema for manifest (dataset const `deep-swe`; manifest uses `deep-swe-1-1`) |
| `/tmp/parallax-deep-swe/tasks/dataset.toml` | Harbor registry dataset `datacurve/deep-swe-1-1` with content digests |
| `/tmp/parallax-deep-swe/tasks/<task-id>/` | One Harbor-format task (113 total) |

## Task tuple schema

Each task is a self-contained Harbor task (schema_version `1.3` in `task.toml`).

### Representative metadata (`task.toml`)

```toml
schema_version = "1.3"
artifacts = ["/logs/artifacts/model.patch"]

[task]
name = "datacurve/ytt-jsonpath-query-api"

[metadata]
ext_id = "kh77w0w2z8qs6m904k2hs9eg058325j8"      # swe-bench-ultra origin ID
task_id = "ytt-jsonpath-query-api"                 # public filesystem / CLI ID
display_title = "Add JSONPath query APIs..."
display_description = "Add orderedmap and Starlark..."
original_title = "JSONPath Query Engine"
category = "feature_request"                       # 106/113; also bugfix(4), enhancement(3)
language = "go"                                    # go 34, python 34, ts 35, rust 5, js 5
repository_url = "https://github.com/carvel-dev/ytt"
base_commit_hash = "452382821dd9dae7cc36995960656bb94dc47212"

[verifier]
network_mode = "no-network"
environment_mode = "separate"                      # all 113 tasks
timeout_sec = 1800.0

[agent]
network_mode = "no-network"
timeout_sec = 5400.0

[environment]
docker_image = "public.ecr.aws/d3j8x8q7/swe-bench-202605:kh77w0w2z8qs6m904k2hs9eg058325j8-v1.1"
cpus = 2
memory_mb = 8192
storage_mb = 20480
```

### Prompt format (`instruction.md`)

- Markdown specification of required behavior (APIs, edge cases, error formats).
- All 113 tasks end with: `IMPORTANT: Please work on this in a new branch from main and commit everything when you are done.`
- Agent never sees `tests/test.patch`, `tests/config.json`, or `solution/`.

### Repository / base commit

| Field | Location | Example |
|-------|----------|---------|
| `base_commit_hash` | `task.toml` `[metadata]` | `452382821dd9...` |
| `base_commit` | `tests/config.json` | same hash |
| `BASE_SHA` | `environment/Dockerfile` `ARG` | same hash |
| git diff base | `pre_artifacts.sh` | `git diff --binary <base> HEAD` → `model.patch` |

Agent environment: repo cloned at `BASE_SHA`, default branch rewound, origin removed, future history GC'd (`environment/Dockerfile`).

### Environment & containers

**Agent container** — prebuilt ECR image per task (`environment.docker_image`), reproducible via `environment/Dockerfile` (clone + deps + tooling).

**Verifier container (v1.1 separate mode)** — built from `tests/Dockerfile`:

```dockerfile
FROM public.ecr.aws/d3j8x8q7/swe-bench-202605:<ext_id>-v1.1
COPY test.sh test.patch grader.py config.json /tests/
```

Harbor/Pier transfers `/logs/artifacts/model.patch` from agent env into verifier env; verifier runs `/tests/test.sh` in pristine `/app`.

### Verifier placement & flow

```
Agent phase (ECR agent image)
  └─ agent edits /app, commits
  └─ pre_artifacts.sh → /logs/artifacts/model.patch

Verifier phase (tests/Dockerfile image)
  └─ grader.py prepare
       ├─ reset+apply model.patch (per-file to base_commit)
       └─ reset+apply test.patch (hidden tests)
  └─ test.sh middle: run base suite + new (f2p) suite → CTRF/JUnit reports
  └─ grader.py grade: whitelist f2p/p2p node IDs → reward.json
```

Shared grader (`tests/grader.py`, ~362 lines, identical in all tasks):
- **Binary reward**: 1 iff all f2p pass AND no p2p fail AND |f2p| > 0
- **f2p_node_ids**: fail-to-pass tests (avg ~52, range 2–254)
- **p2p_node_ids**: pass-to-pass regression tests (avg ~2047, max 66265 for sqlite-utils)
- **grade.format**: `ctrf` (78 tasks) or `junit` (35 tasks)

Outputs under `/logs/verifier/`: `reward.json`, `ctrf.json`, `run.log`, `test-stdout.txt`, `reports/`.

### Reference solution

- `solution/solution.patch` — reference code change (not used at grade time)
- `solution/solve.sh` — applies patch, commits on `feature/solution` branch
- Oracle agent (`pier run --agent oracle`) uses solution for sanity checks

### Task IDs & split metadata

| ID type | Format | Where |
|---------|--------|-------|
| `ext_id` | `kh[0-9a-z]+` | task.toml, ECR tag, manifest |
| `task_id` | kebab-case ≤56 chars | directory name, manifest, Pier `-p` path |
| Harbor name | `datacurve/<task-id>` | task.toml `[task].name`, dataset.toml |

**No train/val/test split** in repo. Subset selection:

```bash
pier run -p /tmp/parallax-deep-swe/tasks --n-tasks 10 --sample-seed 0
pier run -p /tmp/parallax-deep-swe/tasks/ytt-jsonpath-query-api --agent oracle -e docker
```

`manifest.json` records provenance from `swe-bench-ultra` and AI-generated display labels (`label_generation` points to private `/tmp/wide-research-deep-swe/...` paths).

### Licensing / access

- Repo harness: Apache-2.0
- Upstream code: per-project licenses in `PROVENANCE.md` (all permissive)
- Apache-2.0 does **not** relicense upstream
- Agent + verifier: `network_mode = "no-network"`
- **Private/missing artifacts**: 113 prebuilt ECR images; swe-bench-ultra source tasks; label-generation run artifacts; `tools/verifier/` canonical copy (not shipped)

## Selecting & executing a verifier

### Via Pier (recommended)

```bash
uv tool install datacurve-pier   # >=0.3.0

# Oracle sanity check (expect reward 1)
pier run -p /tmp/parallax-deep-swe/tasks/ytt-jsonpath-query-api --agent oracle -e docker -y

# NOP baseline (expect reward 0)
pier run -p /tmp/parallax-deep-swe/tasks/ytt-jsonpath-query-api --agent nop -e docker -y

# Filter dataset
pier run -p /tmp/parallax-deep-swe/tasks -i ytt-jsonpath-query-api --agent oracle
```

Results: `jobs/<timestamp>/<trial_id>/verifier/reward.json`

### Manual Docker (requires daemon + ECR pull)

```bash
TASK=/tmp/parallax-deep-swe/tasks/ytt-jsonpath-query-api
docker build -t deepswe-verifier "$TASK/tests"
mkdir -p /tmp/logs/{artifacts,verifier}
# Empty patch = grade pristine base (reward 0)
touch /tmp/logs/artifacts/model.patch
docker run --rm \
  -v /tmp/logs/artifacts:/logs/artifacts \
  -v /tmp/logs/verifier:/logs/verifier \
  deepswe-verifier /tests/test.sh
cat /tmp/logs/verifier/reward.json
```

For oracle patch: copy `solution/solution.patch` content into `model.patch` (or run agent phase first).

## Perturbation taxonomy (reuse original verifier?)

| Component | Reuse verifier? | Notes |
|-----------|-----------------|-------|
| `display_title`, `display_description` | Yes | Cosmetic only |
| `task_id` (rename) | Yes | Update paths/registry references |
| `[agent]/[verifier] timeouts`, CPU/RAM | Yes | If suites still complete |
| `instruction.md` paraphrase (semantically exact) | Maybe | Risky: hidden tests may encode details omitted in paraphrase |
| `instruction.md` substantive edit | **No** | Changes spec vs. what f2p tests enforce |
| `base_commit_hash` / `base_commit` | **No** | Different code state; p2p/f2p lists invalid |
| `repository_url` / upstream repo | **No** | New task |
| `ext_id` / ECR image tag | **No** | Tied 1:1 to frozen snapshot |
| `tests/test.patch` | **No** | Defines graded behavior |
| `tests/config.json` f2p/p2p lists | **No** | Derived from oracle-vs-nop at this commit |
| `tests/test.sh` middle section | **No** | Test commands, tags, adapters |
| `grade.format`, `grade.reports`, `node_id` | **No** | Must match runner output |
| `environment/Dockerfile` | **No** | Unless producing identical `/app` tree |
| `pre_artifacts.sh` | **No** | Hardcodes base commit |
| `solution/solution.patch` | N/A at grade | Needed for oracle; multiple valid patches OK if behavior matches |

## Are 10 variants per task defensible?

**Technically:** You can fork a task directory 10 times, but each variant that changes spec, commit, or tests needs a full re-derivation of `test.patch`, `config.json` whitelists (oracle-vs-nop differential), and likely a new ECR image.

**Scientifically:** Generating 10 prompt paraphrases per task while reusing the same verifier is **not** defensible as 10 independent benchmark items — metrics would be highly correlated (same repo, commit, tests, difficulty). At best this measures prompt robustness as a secondary analysis.

**Defensible expansion** requires 10 distinct, oracle-validated engineering tasks (different features/commits/specs), each with its own hidden tests — i.e., 10× authoring cost, not automated tuple perturbation.

## Language / category summary

- Languages: TypeScript 35, Go 34, Python 34, Rust 5, JavaScript 5
- Categories: feature_request 106, bugfix 4, enhancement 3
- Grade formats: CTRF 78, JUnit 35
