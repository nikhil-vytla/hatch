# Asset feasibility for the four published adapters

Checked on 2026-08-02 against Microsoft Evolving Intent commit
[`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a).
The implementation is MIT licensed. Dataset and evaluator terms remain
separate.

At this pin, the repository commits evaluation ID lists but ignores
`intent_extraction/output/`, both retrospective expansion output directories,
`final_dataset/`, experiment results, logs, and dataset-specific data
directories. The four claimed generated source files named by the ID manifests
do not exist in the tree. The receipt checks that absence.

## GSM8K

- Public input: `openai/gsm8k`, main test split. The
  [dataset card](https://huggingface.co/datasets/openai/gsm8k) reports 1,319
  test rows and an MIT license. Upstream calls
  `load_dataset("gsm8k", "main")` without a dataset revision.
- Published upstream asset: 200 evaluation IDs and 200 runner task IDs are
  committed. Their exact blob and content hashes are in
  `fixtures/receipt.json`.
- Generated assets: extraction, argument counterfactuals, function
  predecessors, `final_dataset/gsm8k_final.json`, provider responses, rejected
  attempts, and paper result files are absent. Generic extraction and both
  expansion stages use model calls.
- Native verifier: the public row includes the answer, and upstream's math
  verifier normalizes and compares the final numeric answer. No private
  evaluator asset is needed for that narrow verdict.
- Reproducible now: public source rows, published ID membership, source
  algorithms, scheduler behavior, and final-answer equivalence can be
  reconstructed. The exact generated 200 conversations and paper scores
  cannot.
- Access and license: no credential is normally required. MIT covers the
  dataset and the pinned implementation, subject to their notices.

## BIRD-SQL

- Public input: BIRD publishes question, SQL, evidence, schemas, and database
  packages. The [project site](https://bird-bench.github.io/) describes 12,751
  pairs and 95 databases totaling about 33.4 GB. It states that the data is
  CC BY-SA 4.0.
- Published upstream asset: 100 evaluation IDs and runner task IDs are
  committed. The manifest mixes train and dev task IDs even though its top
  level `split` field says `train`; consumers must use per-row task IDs, not
  that summary field.
- Generated assets: selected-complex input, Stage 1 extraction,
  `argument_counterfactual.json`, predecessor output,
  `final_dataset/bird_sql_final.json`, and result files are absent.
- Native verifier: `evaluation/common/sql_evaluator.py` executes model and gold
  SQL against the selected SQLite database and compares result sets without
  row-order sensitivity. The default experiment path may then run an LLM judge
  to accept semantically equivalent answers, so the strict execution verdict
  and the default reported verdict are different contracts.
- Reproducible now: strict evaluation is feasible after downloading the exact
  BIRD database release and matching gold SQL. SQL counterfactual generation is
  deterministic once Stage 1 output and the database are fixed. Exact Stage 1,
  SQL predecessor output, default LLM-judge decisions, and paper scores cannot
  be recreated from this pin.
- Access and license: the databases are a large external download. CC BY-SA
  attribution and share-alike duties apply to redistributed dataset material.
  This PR commits no BIRD rows, SQL, evidence, or database bytes.

## BrowseComp+

- Public input: `Tevatron/browsecomp-plus` exposes 830 obfuscated query records.
  Its [dataset card](https://huggingface.co/datasets/Tevatron/browsecomp-plus)
  labels the data MIT. The public corpus has about 100,000 documents and the
  card reports about 2.8 GB of query and relevance data.
- Published upstream asset: 100 evaluation IDs and runner task IDs are
  committed. No query text, answer, evidence document, or corpus record is
  copied here.
- Generated and intermediate assets: decrypted query JSONL, extraction,
  argument counterfactuals, function predecessors,
  `final_dataset/browsecomp_plus_final.json`, BM25 and Qwen3 FAISS indexes,
  provider calls, judge calls, and result files are absent.
- Native evaluator: the runner first checks normalized exact match. On failure
  it calls an LLM judge with the question, prediction, and correct answer.
  Search also depends on the external corpus, indexes, embedding model, and
  usually a GPU.
- Reproducible now: published ID membership, code paths, and exact-match logic
  are available. A user can acquire and decrypt the public benchmark and fetch
  the corpus, but the upstream docs warn that Hugging Face login may be
  required. Exact index bytes, generated conversations, judge outcomes, and
  paper scores are not pinned.
- Access and license: the code and dataset metadata say MIT, but benchmark
  plaintext is deliberately obfuscated to reduce leakage. This PR does not
  decrypt or redistribute it and does not copy the benchmark canary.

## SWE-bench Verified

- Public input: `SWE-bench/SWE-bench_Verified` publishes 500 human-validated
  instances with issue text, repository and base commit, gold patch, test
  patch, `FAIL_TO_PASS`, and `PASS_TO_PASS`. The
  [dataset card](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)
  is public. The [SWE-bench repository](https://github.com/SWE-bench/SWE-bench)
  uses the MIT license.
- Published upstream asset: 50 evaluation IDs and runner task IDs are
  committed.
- Generated assets: extraction, argument counterfactuals, real-bug pairing, G1
  orientation, implementation precursor output,
  `final_dataset/swe_bench_verified_final.json`, model trajectories, and result
  files are absent.
- Native verifier: upstream wraps the official SWE-bench Docker harness and
  uses all `FAIL_TO_PASS` and `PASS_TO_PASS` outcomes. Runtime assets include
  source repositories at instance base commits, test patches, environment
  setup, Docker, and per-instance images.
- Reproducible now: source instances and official harness inputs are public.
  A user with Docker, registry access, enough disk, and compatible architecture
  can evaluate a patch. Exact Evolving Intent conversations and paper scores
  cannot be recreated. The upstream environment is not locked:
  `swebench>=4.1.0` is a lower bound and `mini-swe-agent` has no version.
- Access and license: Docker images are external and roughly 3 GB per instance
  according to upstream docs. On ARM, the official harness may need local image
  builds. Each target repository and its dependencies retain their own
  licenses. This PR commits only hashes and counts of public IDs, not patches,
  tests, repository snapshots, images, or hidden answers.

## Feasibility result

GSM8K is the only adapter whose public source and narrow native answer check
need no large evaluator asset. BIRD-SQL strict evaluation is feasible after an
exact database release is acquired. BrowseComp+ and SWE-bench Verified are
publicly obtainable but operationally heavy and not pinned tightly enough for
exact paper replay. None of the four has a committed upstream Stage 3 pool, so
no adapter can pass a production generation-provenance gate from this source
tree alone.
