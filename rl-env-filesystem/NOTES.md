# Notes: RL rollout data layer design space

Working log for the investigation into a data layer for RL rollout
sandboxes: fast starts without full container image downloads, plus
checkpointing at rollout stage boundaries (post-setup, post-agent-loop,
post-grading).

## Context

- Customer shape: RL environment and evaluation companies. Common
  architecture: control plane (API + scheduler) -> one sandbox per rollout
  on cloud instances -> metadata in a relational database, artifacts in
  object storage. Cold chain per rollout: boot instance -> pull image ->
  env setup -> agent works; instance terminated after, next rollout cold.
- Checkpoint stages called out in the brief:
  - pre-agent-loop: fork setup progress onto multiple rollouts (flagged low
    priority for lack of latency evidence)
  - post-agent-loop: decouple grading; re-run an updated grader on existing
    rollouts instead of re-running the rollouts
  - post-grading: archival, audit, training-data export
- Direction after review: do not design for any single platform. Frame the
  layer as a standalone product sellable across RL environment vendors, and
  exhaust the design space rather than jumping to one architecture. Keep
  all docs, code, and metadata vendor-neutral.

## Research log

### Fast-start techniques in production systems (public writeups)

Surveyed engineering writeups from serverless compute platforms, hosted
sandbox providers, and container-runtime projects. Recurring ingredients:

1. Warm instance buffers: pre-booted, health-checked machines shared across
   workloads; scheduling onto the buffer takes seconds and removes instance
   provisioning (minutes) from the hot path. Not a storage problem; a
   prerequisite that sits next to the data layer.
2. Lazy image delivery: container start blocks only on a few MB of metadata
   index (~100ms-class), file or chunk contents served on demand from a
   tiered content-addressed cache (host memory -> local NVMe -> zone cache
   tier -> region -> object storage). Content addressing beats layer
   addressing because shared bytes across images are rarely layer-aligned.
   Empirical basis: Slacker (USENIX FAST '16) showed containers read only a
   small fraction of image bytes.
3. Process checkpoint/restore to skip host-side init (interpreter imports,
   service startup): ~10x on that phase in published numbers. Snapshots are
   sensitive to host CPU features, so heterogeneous fleets need
   per-host-class snapshots.
4. Compression choice matters: single-threaded DEFLATE caps out around
   100 MB/s, below every other link; production systems recompress or skip.

### Lazy-pull mechanisms in the container ecosystem

Four mechanism families, all proven in production somewhere:
- Embedded seek tables in recompressed layers. Requires image conversion,
  changes digests, breaks signatures.
- External per-layer index stored beside an UNMODIFIED image. No digest
  change; index can be built after push, server-side; needs registry
  support for associated artifacts. The most adoption-friendly option.
- Purpose-built chunked filesystem formats with content-defined dedup and
  an in-kernel read path (bypassing FUSE, ~10-50us/op vs 100-500us).
  Fastest, most invasive to adopt.
- Block-device presentation of layers via a kernel target. High density,
  kernel module dependency.

Common finding: lazy delivery redistributes download time rather than
eliminating it; background prefetch after start bounds the mid-run miss
window. For RL there is a determinism angle: cache-state-dependent tool
latency can leak into reward variance on timing-sensitive tasks.

### Snapshot/fork capability in sandbox platforms

- MicroVM-based platforms treat "a sandbox is a resumed snapshot":
  templates are pre-booted VM snapshots (memory + disk + device state) in
  object storage; memory pages fault in lazily; the rootfs is a read-only
  template plus per-sandbox copy-on-write layer; pause exports dirty blocks
  as a diff, uploaded asynchronously; peer-to-peer chunk transfer between
  hosts avoids origin bottlenecks. One open-source implementation of this
  exists with a permissive license.
- At least one commercial platform branches running VMs (memory included)
  in the 100-250ms range and markets it directly at RL rollouts.
- Full-VM capture is the most powerful mechanism and the least portable:
  it couples the data layer to a specific hypervisor and host fleet.

### Storage-layer options below the cache

- Raw object storage: right home for write-once-read-few immutable blobs
  (checkpoint diffs, trajectories, indices). No POSIX, ~100-200ms first
  byte, cheapest capacity.
- FUSE clients that translate file ops to object APIs: fine for streaming
  reads, poor for metadata-heavy or random-write workloads.
- Managed NFS-over-object-storage services: easy shared POSIX, but the NFS
  protocol forces a round trip per mutation and caps per-client throughput.
- POSIX caching filesystems with custom protocols (checkout/checkin
  semantics, NVMe cache, read-after-write consistency across mounts,
  object storage as source of truth in native format). One surveyed product
  has git-like checkpoints/branches, but exclusive with object-storage
  backing (a disk syncs to a bucket OR branches, not both), and branches
  are not a security boundary (credentials scope to the whole disk).
- Chunked POSIX filesystems with a separate metadata database: strong
  consistency and dedup, but the bucket contents become a proprietary
  layout, and someone must operate the metadata tier.

### Synthesis

Three separable problems, often conflated:
1. Delivery INTO a fresh sandbox (read path, latency-bound, hot):
   content-addressed cache + lazy load.
2. Capture OUT of a sandbox at stage boundaries (write path,
   throughput-bound, async-able): copy-on-write diff export.
3. Durable shared plane (graders, datasets, results): object storage as
   source of truth; POSIX only where a workflow demands it.

The immutability of nearly every artifact (images, seeds, checkpoints,
trajectories, grades) is the structural gift: caching and dedup are
trivially correct, and no distributed write-consistency problem needs to be
solved on the rollout path. Shared read-write POSIX across sandboxes
actively conflicts with re-gradability and audit; it is a different product.

## Design-space pass

Reframed the doc around seven axes (interface, capture granularity,
addressing/dedup, materialization, cache topology, deployment/source of
truth, sharing semantics) with pruning rules derived from seven jobs
(fast start, stage checkpoints, re-grade, fork, audit, export,
runtime heterogeneity). Wrote model/design_space.py to enumerate: 18,000
combinations, 14,400 nominal after dropping object-API-only, 1,632
core-viable, 1,632 more valid only as per-runtime adapters (anything
needing memory capture), rest pruned. Survivors cluster into three
archetypes: acceleration cache (delivery only, melting asset),
checkpoint-native rollout store (recommended), integrated sandbox platform
(strongest tech, wrong business: it competes with the prospective
customers).

## Cost model

model/coldstart_model.py, assumptions tunable:
- Pre-agent overhead: ~190s baseline; ~102s with a warm pool; ~75s adding
  lazy delivery; ~17s adding post-setup checkpoint restore.
- Grader update over 10,000 rollouts: re-run ~$456 instance time + model
  tokens (dominant); re-grade stored checkpoints ~$19 compute + ~$115/mo
  storage at 0.5 GB diff per rollout.

## Wrap-up

- README.md is the design-space document: jobs, artifact table, seven axes,
  pruning rules, three archetypes, recommendation (checkpoint-native
  rollout store: unmodified images, server-side indices, content-defined
  chunking, profile-guided prefetch, customer-account data plane with the
  customer's bucket as source of truth, branchable snapshot trees, memory
  capture only as per-runtime adapters), risks, open questions.
- Deliberately left open: grader state requirements (filesystem vs live
  services vs memory), runtime mix at target customers, custody
  requirements, dedup value on real catalogs, retention economics, fork
  fan-out frequency.

## Prototype pass (depth interrogation follow-up)

Constraint: no paid platforms, no container runtime on the box. Turned out
to be a feature: pulling straight from the registry HTTP API exposes layer
mechanics (manifest negotiation, blob redirect to presigned CDN URLs,
whiteout handling) that a runtime hides. Gotcha hit: the standard library
HTTP client re-sends the Authorization header on the blob redirect, which
presigned CDN URLs reject with 400; fixed by stripping auth on redirect.

Setup: slim Python base (4 layers, 119 MB) + synthetic deps layer
(numpy+pandas, 97 MB) = 7,400 files, 213 MB uncompressed, 70 MB compressed.
Five stand-in tasks traced in a chroot under strace -f -y (opens, reads,
preads, file-backed mmaps; unfinished/resumed lines handled per pid).
Python 3.12 chroot ran with no /proc or /dev mounts needed.

Numbers (results/summary.md has full tables):
- Per-task utilization: 0.3-17.3% of files, 5.2-39.2% of bytes. Slacker
  replicates on a modern env-shaped image.
- Layer boundaries mislead: deps layer 0% relevant to 3 of 5 tasks, 43-62%
  to the other two. Access tiers beat build-order layers.
- Hot tier (files touched by >=2 tasks): 69 files, 21.7 MB compressed vs
  70.2 MB full pull = 3.2x less up-front. Cold: 6,044 files, 104 MB, never
  touched.
- Leave-one-out prefetch coverage: 100% (csv), 100% (numpy), 87% (db), 78%
  (dataframes), 23% (code-search). The filesystem-trawling task is the
  adversarial case; hot-tier + lazy tail is the right default, profiles
  are a floor.
- PEP 479 bite in synth prototype (StopIteration in genexp -> RuntimeError);
  switched to islice.

Synthesis prototype (synthesize/): drops + description -> content-addressed
bundle (manifest of digests, hardlink seed setup, grader stub with the
0.0/1.0 sanity contract, synthesis prompt for the model step). Demo: 4 seed
files across 2 bundles -> 3 stored objects (shared policy file deduped).

Depth audit added to README: argued (axes/pruning) vs modeled (arithmetic)
vs prototyped (this) vs untouched (serving path, multi-node cache, memory
capture, fencing, security).

## Benchmark platform pass

Direction change: this is a learning/exploration project; removed the
buy-vs-build product framing from the docs (kept internal), restored named
citations (academic + industry) since we want sources to learn from, and
built bench/, a config-driven experiment platform over the prototype.

Mechanics learned the hard way: /workspace is overlayfs, and overlay
upperdirs cannot live on overlay, so sandbox upper/work dirs live on tmpfs
(/dev/shm). Overlay lower on overlayfs is fine. Chroot into the merged
mount needs no /proc or /dev for these tasks.

Harness: per-rollout overlayfs sandbox -> chroot task -> grader ->
optional checkpoint (tar of dirty upper layer) -> optional re-grade after
destroying the sandbox, restoring from the checkpoint alone. Delivery
policies (eager_full, lazy_none, hot_tier, profile, profile_loo) get
(upfront, lazy) byte predictions from the prototype's access profiles;
fetch seconds are modeled bytes/bandwidth and labeled as modeled.

Results (bench/results/, 4-vCPU host):
- delivery_policies: 25 rollouts, all reward 1.00. Eager 70.2 MB / 0.47s
  modeled vs hot tier 21.6 MB / 0.14s; lazy tails visible per policy.
- capture_regrade: capture 9-66 ms, checkpoints 0.03-0.3 MB; re-grade from
  checkpoint alone 16-68 ms and reproduces every live reward exactly.
- concurrency_scale: throughput flat 322->353 rollouts/min from
  concurrency 1->16 while task p95 degrades 0.24s->2.67s. One host buys
  latency variance, not throughput; fleets scale horizontally, and this is
  also where timing-based reward noise comes from.

New citations folded into README (REAP/vHive ASPLOS'21 is the memory-page
twin of our file-level leave-one-out finding; also SOCK, Catalyzer,
FaaSnap, Firecracker NSDI'20, CernVM-FS, Dragonfly/Kraken, Archil blog,
Modal, E2B, Morph, Grab, and the OCI seekability survey).
