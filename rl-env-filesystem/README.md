# Exhausting the design space for an RL rollout data layer

Design exploration for a standalone data layer that RL environment and
evaluation companies could buy instead of build. The customer profile: a
company that runs agent rollouts inside sandboxes at scale, one sandbox per
rollout, driven by a control plane and scheduler, with metadata in a
relational database and artifacts in object storage. Every one of them hits
the same wall: each rollout pays a cold start (boot instance, pull the full
container image, run environment setup) before the agent does any work, the
sandbox is torn down afterward, and nothing about the rollout's state
survives except a trajectory log.

This document deliberately does not design for any one company. It defines
the jobs the layer must do, enumerates the design axes and the options on
each axis, prunes combinations that violate hard constraints, and lands on
the archetypes that survive. The working log is in [NOTES.md](NOTES.md). Two
small scripts ground the argument: a latency/cost model in
[model/coldstart_model.py](model/coldstart_model.py) and a design-space
enumerator in [model/design_space.py](model/design_space.py).

## Jobs the layer must do

Everything below is derived from these seven jobs. An option that serves no
job gets cut, no matter how elegant.

1. Start a rollout's filesystem in seconds, independent of image size, and
   without requiring the customer to change how they build environment
   images.
2. Checkpoint rollout state at stage boundaries: after environment setup,
   after the agent loop, after grading.
3. Re-grade: run a new grader version against the stored final state of
   existing rollouts, without re-running agents.
4. Fork: materialize N writable copies of a prepared state for parallel
   rollouts.
5. Audit and provenance: given a reward, reproduce the exact state it was
   computed from, indefinitely later and cheaply.
6. Export: hand trajectories, state diffs, and grades to the customer's
   training pipeline, in their storage, in a format they can read without us.
7. Slot into heterogeneous runtimes. Customers run plain containers on cloud
   VMs, microVM fleets, container orchestrators, and third-party sandbox
   providers, across clouds. A layer that demands one runtime is a rewrite,
   not a purchase.

Job 7 is the one that shapes the product most, because it is where "ideal
data layer" and "sellable data layer" diverge. The technically maximal
design owns the whole sandbox runtime. The sellable design treats the
runtime as someone else's and meets it at a stable interface.

## The artifacts and their access patterns

| artifact | written | read | mutability | typical size | lifetime |
| --- | --- | --- | --- | --- | --- |
| base environment image | once, at task publish | every rollout, partially | immutable | 1-20 GB | months |
| seed data (fixtures, DB dumps) | once, at task publish | every rollout | immutable | MB-GB | months |
| working writes (agent's changes) | continuously during the loop | grader, auditors | mutable then frozen | 10 MB - few GB dirty | days-months |
| stage checkpoints | at 2-3 boundaries per rollout | re-grade, fork, audit | immutable once taken | diff-sized | months |
| trajectory (tokens, tool calls) | streamed during the loop | training, audit | append-only | MB | years |
| grade record | once per grading pass | training, product UI | append-only, versioned | KB | years |

Two structural facts fall out of this table and drive the whole design.
First, almost everything is immutable or append-only; the only mutable thing
is the working set during the agent loop, and even that freezes at a
boundary. Immutability is what makes aggressive caching and dedup trivially
correct. Second, reads of the big immutable artifacts are partial: research
going back to Slacker ([USENIX FAST '16](https://www.usenix.org/conference/fast16/technical-sessions/presentation/harter))
showed that containers typically read only a small fraction of their image
bytes, which is why lazy delivery works at all.

## Design axes

Seven axes. For each: the options, and what pushes toward or away from each.

### Axis A: interface presented to the sandbox

1. Object API only. The sandbox pulls blobs itself. No kernel involvement,
   but every existing environment expects a filesystem, so this fails job 1
   alone.
2. POSIX filesystem in userspace (FUSE or equivalent). Files served on
   demand. Easy to deploy anywhere with a mount; userspace hop costs
   100-500us per uncached operation.
3. Virtual block device. The layer serves blocks; the guest runs a normal
   kernel filesystem on top. Faster data path, coarser visibility (the layer
   sees blocks, not files), needs kernel or hypervisor cooperation.
4. Container-runtime snapshotter plugin. Integrates below the container
   runtime so images mount lazily with zero change to the user workflow.
   Only works where the customer runs a pluggable runtime.
5. VM disk plus memory image. The unit is the whole machine. Maximal
   capture power, minimal portability.

### Axis B: capture granularity

1. File-level diff of the writable layer. Portable, human-inspectable,
   loses timestamps/sparseness fidelity at the edges.
2. Block-level copy-on-write diff. Exact, compact, capture is O(dirty
   blocks), restore needs the matching base.
3. Whole-filesystem image. Simple, wasteful, kills dedup.
4. Filesystem plus process memory (checkpoint/restore of running
   processes). Restores a live environment, not just its disk. Sensitive to
   host CPU features and kernel versions; requires deep runtime cooperation.
5. Filesystem, memory, and device state (full VM snapshot). Strongest
   semantics; couples the data layer to one hypervisor.

### Axis C: addressing and deduplication

1. Path-based. No dedup; a cache entry is a file path in some namespace.
2. Layer-based (as container registries do). Dedup only when layers are
   byte-identical; shared bytes across differently-built images are missed.
3. File-hash based. Dedup at file granularity; breaks on large files that
   change slightly (databases, logs).
4. Fixed-size chunks, content-addressed. Simple, good dedup, boundary-shift
   problem (one inserted byte re-chunks the rest of the file).
5. Content-defined chunking. Best dedup, especially across image rebuilds
   and across checkpoints of the same rollout; costs CPU at ingest.

### Axis D: materialization strategy

1. Eager: fetch everything before start. The status quo being replaced.
2. Lazy: fetch on first access. Start is fast; mid-rollout reads pay a
   cache-miss penalty, which for RL is not just latency but reward noise,
   since two rollouts of the same task can observe different tool latencies
   depending on cache state.
3. Lazy plus background prefetch of the full working set. Start fast, and
   the miss window closes within the first minute.
4. Profile-guided prefetch: record which chunks past rollouts of this task
   actually touched, prefetch exactly those first. The rollout workload is
   unusually favorable for this, because the same task runs hundreds of
   times; access profiles converge quickly.

### Axis E: cache topology

1. Node-local only. Helps repeat rollouts on the same host; cold otherwise.
2. Shared cluster tier (a few NVMe-heavy nodes per zone). One fetch from
   durable storage serves the whole fleet; 500 parallel rollouts of one task
   hit the origin once.
3. Peer-to-peer between sandbox hosts. Removes the dedicated tier at the
   cost of scheduling and security complexity.
4. Multi-tier (host memory, host disk, zone tier, region, durable bottom).
   What every mature system converges on; each tier trades latency for
   capacity roughly an order of magnitude at a step.

### Axis F: deployment and source of truth

1. Fully managed: data lives in the vendor's cloud. Easiest to run, hardest
   to sell to companies whose customers (the labs) demand data custody.
2. Customer-hosted data plane, vendor control plane: our software (cache
   nodes, agents, snapshotter) runs in their account; chunks and snapshots
   land in their object storage bucket; we run the metadata and coordination
   service. This is the classic pattern for selling infrastructure to
   infrastructure companies.
3. Fully self-hosted (licensed software). Maximal custody, slowest
   iteration, heavy support burden.

Orthogonal sub-choice: is the durable format native (objects a human can
read with standard tools) or chunked-proprietary? Native format sacrifices
chunk-level dedup in the bottom tier but means job 6 (export) is free and
the customer is never hostage to our software to read their own data. A
hybrid works: native-format source of truth for images and exports,
chunked content-addressed format for checkpoints, with an export tool that
rehydrates any checkpoint to plain files.

### Axis G: sharing and write semantics

1. Immutable snapshots plus single-writer working sets. Each rollout owns
   its writable layer exclusively; sharing happens only through snapshots.
   No distributed write consistency problem exists at all.
2. Branchable trees of snapshots (git-like). Same guarantees, richer
   lineage; a fork is a branch, a checkpoint is a commit.
3. Shared read-write POSIX across sandboxes. Genuinely useful for a
   different product (shared scratch space, cross-agent memory), and
   genuinely hard: consistency protocols, locking, fencing. Note that it
   actively conflicts with the reproducibility jobs, since a rollout whose
   inputs can be mutated concurrently is not re-gradable or auditable.

## Pruning the space

The seven axes give 4x5x5x4x4x3x3 = 14,400 nominal combinations (the
enumerator counts them; axis A option 1 is pruned as failing job 1 outright).
Hard constraints cut this down fast:

- Memory or VM-state capture (B4, B5) requires runtime or hypervisor
  cooperation (A4, A5), which violates job 7 for every customer whose
  runtime we do not control. Not pruned globally, but demoted to an adapter:
  offered where the customer's runtime supports it, never required by the
  core product.
- Lazy materialization (D2-D4) requires seekable addressing (C3-C5, or C2
  with an external index). Path addressing plus laziness has no way to know
  what a file's bytes are without fetching the whole object.
- Shared read-write semantics (G3) conflict with jobs 3 and 5
  (re-gradability, audit). Excluded from the rollout path; possible future
  side product.
- Whole-filesystem-image capture (B3) fails the economics of job 5: audit
  storage priced at full copies per rollout is orders of magnitude worse
  than diffs, given dirty sets are typically under a gigabyte against
  multi-gigabyte images.
- Fully managed deployment (F1) fails job 6 and, in practice, the sales
  motion: the buyers sell to labs that contractually require data custody.
  Kept only as a free tier / evaluation mode.
- Owning the runtime (A5 as the only interface) makes the product a sandbox
  platform, not a data layer, and turns every prospective customer into a
  competitor. Excluded as the core; kept as one adapter among several.

Running the enumerator with these rules leaves a coherent region of the
space rather than a single point, and the surviving combinations cluster
into three archetypes.

## The three surviving archetypes

### Archetype 1: acceleration cache

Delivery only. Lazy mount of unmodified OCI images through a
snapshotter/FUSE interface, content-addressed multi-tier cache, no capture.
Sells on one number (cold start), integrates in a day. But it creates no new
workflows, it is a feature every large cloud is drifting toward shipping
natively, and nothing about it compounds: churn risk is maximal. Right as an
on-ramp, wrong as the product.

### Archetype 2: checkpoint-native rollout store

Delivery plus capture, runtime-agnostic. The core object is the rollout
checkpoint: an immutable, content-addressed snapshot of a sandbox's
filesystem state at a stage boundary, with a manifest binding it to base
image, seed data, config, and trajectory. Concretely:

- Interface: A2/A4 (FUSE mount or runtime snapshotter plugin), with A3
  (block device) as an adapter for microVM customers. Whatever the mount
  path, images are unmodified; indices are built server-side at publish.
- Capture: B2 (block COW diff) where the mount is block-backed, B1 (file
  diff of the writable layer) where it is file-backed. B4/B5 memory capture
  as optional per-runtime adapters, never required.
- Addressing: content-defined chunks (C5) in the cache and checkpoint
  store; native-format export path for custody (F sub-choice hybrid).
- Materialization: D3 by default, D4 (profile-guided prefetch) as the
  differentiator; nobody is better positioned to have per-task access
  profiles than the layer that serves every rollout of that task.
- Topology: E4, multi-tier with a zone-shared NVMe tier.
- Deployment: F2, customer account data plane, vendor control plane,
  customer's bucket as the durable bottom.
- Semantics: G2, branchable snapshot trees. Fork = branch, checkpoint =
  commit, re-grade = read-only mount of a commit.

This archetype is the recommendation, and the reasoning is as much about
the market as the technology. Every listed job maps to a billable workflow:
re-grading is a metered API, forking is a scheduler feature the customer
markets to labs, audit storage is a retention tier. The checkpoint manifest
format can be published as an open spec, which converts job 6 from a risk
into lock-in-by-honesty: customers can always leave, which is exactly why
they can buy.

### Archetype 3: integrated sandbox platform

Own the runtime, the hypervisor, and the storage; get memory-state forking
in the hundreds of milliseconds and pause/resume for free. Technically the
strongest point in the space and the wrong business here: the target
customers already operate sandbox fleets or rent them, several sell exactly
this capability themselves, and "replace your runtime" is a multi-quarter
migration pitch against "mount this and get checkpoints today." The
capabilities of this archetype re-enter archetype 2 as adapters where the
customer's runtime exposes snapshot hooks.

## What the numbers say

From the cost model (assumptions are parameters, replace with measured
values per customer):

| architecture | pre-agent latency | overhead vs 10-min agent loop |
| --- | --- | --- |
| baseline (eager pull, cold instance) | ~190s | 32% |
| + warm instance pool | ~102s | 17% |
| + lazy image delivery | ~75s | 12% |
| + restore from post-setup checkpoint | ~17s | 3% |

And for the grader-update workflow, the asymmetry that justifies the whole
capture side: re-running 10,000 rollouts costs roughly $456 of instance time
plus the dominant real cost, model tokens for 10,000 ten-minute agent loops.
Re-grading the same 10,000 stored checkpoints costs roughly $19 of compute
plus about $115/month of object storage at 0.5 GB of diff per rollout.

One boundary worth stating plainly: instance boot time is not a data-layer
problem. A warm pool of pre-booted machines is a prerequisite the customer
owns; without it, the data layer shaves a minority of the cold start. The
sales narrative should say so, because overclaiming here surfaces in the
first proof-of-concept.

## Risks and what must be true

- The grader question. If most graders only inspect final filesystem state,
  FS-level checkpoints cover re-grading fully. If a meaningful fraction
  needs live services, restore must boot base-plus-diff and re-run service
  startup (seconds, usually fine). If graders need in-memory-only state,
  only the memory-capture adapters help, and the core value pitch narrows.
  Surveying real graders across 2-3 design partners is the single highest
  information-per-dollar step.
- Reward noise from laziness. Mid-rollout cache misses inject timing
  variance into environments, and timing-sensitive tasks may translate that
  into reward variance. Background and profile-guided prefetch bound the
  window; an A/B harness that compares reward distributions with and
  without lazy delivery should be part of the product's own QA, and is a
  credibility asset in sales conversations.
- Dedup scope versus tenancy. Content addressing across tenants leaks blob
  existence through cache timing and creates a poisoning surface if hashing
  or verification is ever wrong. Default to per-tenant dedup; cross-tenant
  only with measured savings and a real isolation review.
- Checkpoint capture tail latency. Sealing a diff synchronously at
  agent-loop end delays sandbox teardown, which is paid fleet time. Eject
  the writable layer at freeze time, seal and upload asynchronously, and
  mark the checkpoint available when the upload lands.
- Standards drift. The container ecosystem is steadily absorbing lazy
  delivery. The moat is not lazy pull; it is the checkpoint semantics,
  lineage, and the workflows above them. Archetype 1 alone is a melting
  asset.

## Open questions

1. Across target customers, what fraction of graders read only final
   filesystem state versus needing live services or process memory?
2. What runtimes are actually in production at the target customers (plain
   containers on VMs, microVMs, orchestrators, rented sandboxes), and in
   what proportions? This sets the adapter build order.
3. Do the labs buying from these companies require data custody in the
   customer's cloud account contractually, or is that assumption
   sales-lore? F2 rests on it.
4. How much cross-image byte overlap exists in practice across a real
   customer's task catalog? This prices content-defined chunking against
   simpler file-hash dedup.
5. What retention window do training and audit workflows actually demand
   for checkpoints, and who pays for it?
6. Is shared mutable storage across sandboxes (agent memory, shared scratch)
   demanded by the same buyers, or a different product for a different
   buyer? It sits outside the pruned region and should not ride along by
   default.
7. For the fork job: how often is fan-out from a common prepared state
   (hundreds of rollouts of one task within minutes) versus embarrassingly
   parallel distinct tasks? Fork frequency decides whether pre-agent
   checkpoints justify memory-capture adapters early.

## References

- Slacker (lazy container distribution),
  [USENIX FAST '16](https://www.usenix.org/conference/fast16/technical-sessions/presentation/harter).
  The empirical basis for lazy delivery: containers read a small fraction of
  their image bytes.
- To FUSE or Not to FUSE: Performance of User-Space File Systems,
  [USENIX FAST '17](https://www.usenix.org/conference/fast17/technical-sessions/presentation/vangoor).
  The cost model for userspace filesystem interfaces.
