# Prototype: access-driven layer decomposition

Answers one question with running code: given the file accesses an agent
makes while completing a task inside a sandbox, how should the environment
image's layers be decomposed for delivery? No container runtime, no paid
platform; requirements are Python 3.12, sudo, strace, and network access to
a public registry.

## Pipeline

```bash
# 1. Pull and extract an image, recording the file->layer ownership map
python3 oci_pull.py python:3.12-slim --out ./image

# 2. Add a synthetic dependency layer (numpy + pandas), as env images have
./make_deps_layer.sh

# 3. Trace stand-in agent tasks in a chroot under strace
for t in task_csv_report task_grep_fix task_sqlite_query \
         task_numpy_solve task_pandas_pipeline; do ./trace_task.sh $t; done

# 4. Join traces against layer ownership, emit per-task access profiles
python3 analyze.py task_csv_report task_grep_fix task_sqlite_query \
    task_numpy_solve task_pandas_pipeline

# 5. Repack into hot/warm/cold tiers, evaluate prefetch policies
python3 repack.py task_csv_report task_grep_fix task_sqlite_query \
    task_numpy_solve task_pandas_pipeline
```

Results land in [results/](results/), headline tables in
[results/summary.md](results/summary.md). Committed results are from a real
run on 2026-08-03; the pulled image, extracted rootfs, raw traces, and
repacked tars are gitignored as regenerable.

## Drag-and-drop task synthesis

[synthesize/](synthesize/) prototypes the non-technical-user flow: n
dropped files plus a one-line description become a content-addressed task
bundle (manifest with digests, deterministic seed setup script, grader stub
with the reward contract, and the synthesis prompt an LLM step would
receive). `./synthesize/demo.sh` builds two bundles that share a seed file
and shows the store deduplicating it.
