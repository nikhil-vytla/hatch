# Exhausting the design space for an RL rollout data layer

Design exploration for the data layer underneath RL environment rollouts:
how sandboxes get their filesystems fast, how rollout state gets captured at
stage boundaries, and how grading decouples from the agent loop. The
platform profile this studies: a system that runs agent rollouts inside
sandboxes at scale, one sandbox per rollout, driven by a control plane and
scheduler, with metadata in a relational database and artifacts in object
storage. Such systems hit the same wall: each rollout pays a cold start
(boot instance, pull the full container image, run environment setup)
before the agent does any work, the sandbox is torn down afterward, and
nothing about the rollout's state survives except a trajectory log.

This is a learning and exploration exercise, deliberately not designed
around any one platform. The document defines
the jobs the layer must do, enumerates the design axes and the options on
each axis, prunes combinations that violate hard constraints, and lands on
the archetypes that survive. The working log is in [NOTES.md](NOTES.md). Two
small scripts ground the argument: a latency/cost model in
[model/coldstart_model.py](model/coldstart_model.py) and a design-space
enumerator in [model/design_space.py](model/design_space.py). A working
prototype in [prototype/](prototype/) pulls a real OCI image without a
container runtime, traces which bytes stand-in agent tasks actually touch,
and repacks layers by observed access. A benchmark platform in
[bench/](bench/) turns the design axes into experiment configs you can run
and measure; both sets of findings are reported below.

## How deep this design goes

An honest depth audit, because "design document" can mean anything.

- Argued on paper: the jobs, the seven axes, the pruning rules, the three
  archetypes, the recommendation. This level is a structured argument, and
  its weakest joints are the hand-written pruning rules.
- Modeled with arithmetic: cold-start decomposition and re-grade economics
  (parametric, assumptions not measurements) and the mechanical enumeration
  of the option space. These bound orders of magnitude; they prove nothing
  about tails.
- Prototyped with running code: registry pull and layer extraction, syscall
  -level access tracing of tasks in a sandbox, the join of traces against
  layer ownership, access-based repacking, a prefetch-policy evaluation
  with held-out tasks, and the content-addressed seed store for the
  drag-and-drop flow. All on one machine with free tooling.
- Not touched: a real lazy filesystem serving reads on demand (the
  prototype measures what one would serve, not the serving), the multi-node
  cache tier, checkpoint restore under concurrency, memory-state capture,
  lease/fencing protocol details, failure injection, and any security
  review. Each of these is a separate experiment with a clear setup; none
  is blocked on a decision made here.

## Jobs the layer must do

Everything below is derived from these seven jobs. An option that serves no
job gets cut, no matter how elegant.

1. Start a rollout's filesystem in seconds, independent of image size, and
   without requiring anyone to change how they build environment images.
2. Checkpoint rollout state at stage boundaries: after environment setup,
   after the agent loop, after grading.
3. Re-grade: run a new grader version against the stored final state of
   existing rollouts, without re-running agents.
4. Fork: materialize N writable copies of a prepared state for parallel
   rollouts.
5. Audit and provenance: given a reward, reproduce the exact state it was
   computed from, indefinitely later and cheaply.
6. Export: hand trajectories, state diffs, and grades to the training
   pipeline, in the platform's own storage, in a format readable without
   the layer that produced them.
7. Slot into heterogeneous runtimes. Rollout platforms run plain containers
   on cloud VMs, microVM fleets, container orchestrators, and third-party
   sandbox providers, across clouds. A layer that demands one runtime is a
   rewrite, not an integration.

Job 7 shapes the design most, because it is where the ideal-on-paper layer
and the adoptable-in-practice layer diverge. The technically maximal design
owns the whole sandbox runtime. The adoptable design treats the runtime as
someone else's and meets it at a stable interface.

## The artifacts and their access patterns

| artifact | written | read | mutability | typical size | lifetime |
| --- | --- | --- | --- | --- | --- |
| base environment image | once, at task publish | every rollout, partially | immutable | 1-20 GB | months |
| seed data (fixtures, DB dumps) | once, at task publish | every rollout | immutable | MB-GB | months |
| working writes (agent's changes) | continuously during the loop | grader, auditors | mutable then frozen | 10 MB - few GB dirty | days-months |
| stage checkpoints | at 2-3 boundaries per rollout | re-grade, fork, audit | immutable once taken | diff-sized | months |
| trajectory (tokens, tool calls) | streamed during the loop | training, audit | append-only | MB | years |
| grade record | once per grading pass | training, review UIs | append-only, versioned | KB | years |

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
   Only works where the fleet runs a pluggable runtime.
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

1. Fully managed elsewhere: data lives outside the platform's own cloud.
   Easiest to operate, hardest to square with data custody, which labs
   downstream often demand.
2. Data plane in the platform's account, control plane separate: cache
   nodes, agents, and the snapshotter run next to the fleet; chunks and
   snapshots land in the platform's own object storage bucket; only
   metadata and coordination live outside. The common pattern for
   infrastructure that must run inside someone else's trust boundary.
3. Fully self-hosted. Maximal custody, slowest iteration, heaviest
   operational burden.

Orthogonal sub-choice: is the durable format native (objects a human can
read with standard tools) or chunked-proprietary? Native format sacrifices
chunk-level dedup in the bottom tier but means job 6 (export) is free and
the data outlives the layer that wrote it. A
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
   different problem (shared scratch space, cross-agent memory; this is the
   territory staked out by shared-disk services in the agent space), and
   genuinely hard: consistency protocols, locking, fencing. Note that it
   actively conflicts with the reproducibility jobs, since a rollout whose
   inputs can be mutated concurrently is not re-gradable or auditable.

## Pruning the space

The seven axes give 4x5x5x4x4x3x3 = 14,400 nominal combinations (the
enumerator counts them; axis A option 1 is pruned as failing job 1 outright).
Hard constraints cut this down fast:

- Memory or VM-state capture (B4, B5) requires runtime or hypervisor
  cooperation (A4, A5), which violates job 7 wherever the runtime is not
  ours to change. Not pruned globally, but demoted to an adapter: used
  where the fleet's runtime supports it, never required by the core.
- Lazy materialization (D2-D4) requires seekable addressing (C3-C5, or C2
  with an external index). Path addressing plus laziness has no way to know
  what a file's bytes are without fetching the whole object.
- Shared read-write semantics (G3) conflict with jobs 3 and 5
  (re-gradability, audit). Excluded from the rollout path; a separate
  problem worth studying on its own.
- Whole-filesystem-image capture (B3) fails the economics of job 5: audit
  storage priced at full copies per rollout is orders of magnitude worse
  than diffs, given dirty sets are typically under a gigabyte against
  multi-gigabyte images.
- Fully managed deployment (F1) fails job 6 and the custody requirements
  common downstream (labs frequently require data to stay in the platform's
  own account). Kept only as an evaluation mode.
- Owning the runtime (A5 as the only interface) makes the layer a sandbox
  platform, not a data layer, and shrinks the set of fleets it can serve to
  the ones willing to migrate. Excluded as the core; kept as one adapter
  among several.

Running the enumerator with these rules leaves a coherent region of the
space rather than a single point, and the surviving combinations cluster
into three archetypes.

## The three surviving archetypes

### Archetype 1: acceleration cache

Delivery only. Lazy mount of unmodified OCI images through a
snapshotter/FUSE interface, content-addressed multi-tier cache, no capture.
Wins on one number (cold start) and integrates in a day. But it creates no
new workflows, large clouds are drifting toward shipping it natively, and
nothing about it compounds. Right as a first step, insufficient as a
destination.

### Archetype 2: checkpoint-native rollout store

Delivery plus capture, runtime-agnostic. The core object is the rollout
checkpoint: an immutable, content-addressed snapshot of a sandbox's
filesystem state at a stage boundary, with a manifest binding it to base
image, seed data, config, and trajectory. Concretely:

- Interface: A2/A4 (FUSE mount or runtime snapshotter plugin), with A3
  (block device) as an adapter for microVM fleets. Whatever the mount
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
- Deployment: F2, data plane in the platform's account, its own bucket as
  the durable bottom.
- Semantics: G2, branchable snapshot trees. Fork = branch, checkpoint =
  commit, re-grade = read-only mount of a commit.

This archetype is the recommendation. Every listed job maps onto a concrete
workflow it enables: re-grading becomes an API call over stored state,
forking becomes a scheduler feature, audit becomes a retention policy. The
checkpoint manifest format can be published as an open spec, so captured
state stays readable without the layer that produced it, which is what
keeps job 6 honest.

### Archetype 3: integrated sandbox platform

Own the runtime, the hypervisor, and the storage; get memory-state forking
in the hundreds of milliseconds and pause/resume for free (this is the
point in the space that microVM sandbox platforms occupy). Technically the
strongest position and the wrong fit for the problem as framed: rollout
platforms already operate or rent sandbox fleets, and replacing a runtime
is a migration while mounting a filesystem is an integration. The
capabilities of this archetype re-enter archetype 2 as adapters wherever
the fleet's runtime exposes snapshot hooks.

A production data point on where these archetypes converge: DeepSeek's V4
technical report (section 5.2.5) describes DSec, the sandbox platform
behind their agentic post-training, running hundreds of thousands of
concurrent sandboxes. It is an archetype-3 build, as expected for a lab
that controls its whole stack, and its internals validate the axis choices
made here one for one: four execution substrates (pre-warmed function
pool, container, microVM, full VM) behind one SDK, which is the
multi-runtime-adapter thesis applied inward; lazy image loading with file
metadata local at mount time and data blocks fetched on demand from a
distributed filesystem (axis D); read-only base layers shared across
instances with local copy-on-write writes and chainable snapshots giving
millisecond-scale resumption (axes B and G); and a globally ordered
per-sandbox trajectory log used for preemption-safe resumption,
provenance, and deterministic replay, which is job 5 as a production
feature. When a frontier lab's in-house system and an outside-in design
exercise land on the same combination, the combination is probably not an
accident of either.

## What the numbers say

From the cost model (assumptions are parameters, replace with measured
values per fleet):

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
problem. A warm pool of pre-booted machines is a prerequisite that lives
with the scheduler; without it, the data layer shaves a minority of the
cold start. Any evaluation should say so up front, because overclaiming
here surfaces in the first measurement.

## Prototype: decomposing image layers by observed agent access

The question the prototype answers: can you determine, from the accesses an
agent actually makes while completing a task, how an image's layers should
be decomposed for delivery? Yes, with about 600 lines of Python and no
container runtime, no paid platform, and no kernel modules. Method:

1. [prototype/oci_pull.py](prototype/oci_pull.py) speaks the registry HTTP
   API directly (token auth, manifest negotiation, blob fetch), extracts
   layers in order with whiteout handling, and records the ownership map:
   for every path in the final rootfs, which layer serves it. This map is
   what overlay semantics give a running container implicitly; materializing
   it is what lets us join access traces to layers.
2. [prototype/make_deps_layer.sh](prototype/make_deps_layer.sh) adds a
   synthetic dependency layer (numpy + pandas, 97 MB) to a slim Python base
   image, mimicking the deps layer every real environment image carries.
   Final image: 5 layers, 7,400 files, 213 MB uncompressed, 70 MB
   compressed.
3. [prototype/trace_task.sh](prototype/trace_task.sh) runs a task inside a
   chroot of the extracted rootfs under strace, capturing every open, read,
   pread and file-backed mmap with file-descriptor-to-path resolution. Five
   stand-in agent tasks cover distinct behavior classes: stdlib CSV
   analysis, shell-tool code search and edit, relational DB work, numeric
   work touching numpy only, and a dataframe pipeline touching pandas.
4. [prototype/analyze.py](prototype/analyze.py) joins traces against the
   ownership map, estimating unique bytes touched per file (reads plus
   mapped lengths, capped at file size), and emits a per-task access
   profile, which is exactly the artifact a profile-guided prefetcher
   consumes.
5. [prototype/repack.py](prototype/repack.py) classifies files into hot
   (touched by two or more tasks), warm (one task), and cold (none), emits
   real repacked layer tars with real gzip sizes, and evaluates prefetch
   policies including leave-one-out coverage for a never-seen task. Full
   output in [prototype/results/summary.md](prototype/results/summary.md).

What the traces showed, on real bytes:

| task | files touched | bytes touched | deps-layer utilization |
| --- | --- | --- | --- |
| CSV report (stdlib) | 21 of 7,400 (0.3%) | 11.1 of 213 MB (5.2%) | 0% |
| code search + edit | 1,278 (17.3%) | 29.5 MB (13.8%) | 0% |
| DB query | 19 (0.3%) | 12.5 MB (5.9%) | 0% |
| numeric solve | 49 (0.7%) | 63.5 MB (29.8%) | 43% |
| dataframe pipeline | 115 (1.6%) | 83.6 MB (39.2%) | 62% |

And the decomposition: the hot tier across all five tasks is 69 files,
21.7 MB compressed, against a 70.2 MB full pull. Eager delivery of the hot
tier plus lazy everything else cuts up-front bytes 3.2x while guaranteeing
the interpreter, loader, shared libraries and coreutils are warm. 6,044 of
7,400 files (104 MB) were never touched by any task.

The leave-one-out evaluation is the finding I'd highlight, and it has a
direct academic twin: REAP (ASPLOS '21) found that serverless functions
touch a stable working set of memory pages across invocations and that
recording-then-prefetching that set cuts cold starts 3.7x. The same
recurrence shows up here at file granularity:

| held-out task | working set | covered by other tasks' profiles | missed |
| --- | --- | --- | --- |
| CSV report | 11.1 MB | 100% | 0 |
| code search + edit | 29.5 MB | 23% | 22.7 MB |
| DB query | 12.5 MB | 87% | 1.6 MB |
| numeric solve | 63.5 MB | 100% | 0 |
| dataframe pipeline | 83.6 MB | 78% | 18.2 MB |

Three lessons. First, the Slacker result replicates on a modern
environment-shaped image: single-digit to lowish-double-digit byte
utilization per task. Second, build-order layers are the wrong delivery
unit: the deps layer is 0% relevant to three tasks and 43-62% relevant to
two, so access-based tiers dominate any layer-granularity policy. Third,
profile-guided prefetch is a floor, not a ceiling: it approaches 100%
coverage for tasks whose behavior is API-shaped, and collapses to 23% for a
task that trawls the filesystem (code search), which is precisely the
agent-shaped access pattern. That asymmetry is the argument for hot-tier
prefetch plus a lazy tail rather than prefetch-only, and it also says
per-task profiles converge only after observing that task a few times,
which the rollout workload conveniently provides.

Honest limitations: file-level granularity, not sub-file chunks (pread
offsets are in the traces; extending to chunk-level is mechanical); the
byte estimates are per-file upper bounds; the tasks are scripted stand-ins,
not a live agent (though a real agent's tool calls cross the same syscall
surface, which is what makes the tracer runtime-agnostic); and nothing here
measures the serving side, only what would need to be served.

To run this against a real platform instead of stand-ins, the information
needed: the environment images (or registry references) for a
representative task set; either recorded rollout traces or permission to
run the tracer inside their sandbox (strace works where ptrace is allowed;
fanotify or eBPF where it is not); the task fan-out distribution, which
sets how quickly per-task profiles converge; and whether their image build
pipeline permits server-side repacking or must remain untouched with
index-only laziness.

## Non-technical users: from dragged-in files to a task bundle

The flow to support: a user drops n arbitrary files, writes one sentence
about what the agent should do, and the platform synthesizes the rest. The
data layer's half of that flow is prototyped in
[prototype/synthesize/](prototype/synthesize/):

- Ingest: every dropped file is hashed and stored once in a
  content-addressed store; the task bundle holds digests, not bytes. Two
  bundles that drop the same file share one object (the demo drops four
  files across two tasks and stores three objects). This is the same dedup
  argument the design makes for checkpoints, at drag-and-drop scale, and
  it means a thousand variants of a task sharing a big fixture cost one
  copy.
- Deterministic seed: the generated setup script materializes seeds by
  hardlink from the read-only store, so every rollout starts from
  digest-verified state, which is what makes grading and re-grading
  defensible. Modified-seed detection comes free: rehash and compare.
- Synthesis: the scenario and grader are a model call in a real system.
  The prototype emits the exact synthesis prompt (description plus a typed
  seed inventory with samples) and a runnable grader stub encoding the
  contract the design doc requires: reward in [0,1], unchanged seed state
  scores 0.0, a correct completion scores 1.0, and checks should prefer
  final filesystem state so grading works from a checkpoint without a live
  agent.
- Validation before publish: a null-agent rollout must score 0 and an
  oracle rollout must score 1 before the task goes live. Those validation
  rollouts are themselves the first entries in the task's access profile,
  which means the delivery layer's prefetch data starts accumulating
  before the first real rollout runs.

What is deliberately not prototyped: the model call itself, and the
iteration loop where synthesis failures (grader scores oracle below 1)
feed back into regeneration. Neither changes the data layer's shape; both
consume it.

## The experiment platform: benchmarking the axes

The design axes should not stay arguments; they should be columns in a
results table. [bench/](bench/) is a config-driven benchmark platform that
runs fleets of rollouts under different data-layer configurations and
measures every phase. An experiment is a JSON spec (tasks x delivery
policies x capture/re-grade settings x concurrency); the harness expands
the matrix, runs each rollout in its own copy-on-write sandbox (a real
overlayfs mount with a tmpfs dirty layer, a real chroot, a real grader),
and writes per-phase timings to JSONL, which the reporter aggregates into
markdown. Adding a task is one shell script plus one grader; adding a
policy is one method; adding an experiment is one JSON file.

What is real: mounts, task execution, checkpoint capture (tar of the dirty
layer), decoupled re-grading from the checkpoint alone, and all timings
under real concurrency. What is modeled: network fetch time, computed from
the byte counts each policy must move (measured by the prototype's access
profiles) divided by a configured bandwidth. One machine cannot honestly
measure a fleet's network, so the harness does not pretend to; the byte
counts are real, the seconds are arithmetic. "Distributed" is a worker
pool here, but each rollout is a pure function from spec row to result
record with no shared state, which is the property that lets the same
code fan out to remote executors when there is a fleet to run it on.

Three experiments are committed with their results
(all rollouts scored 1.00 by their graders; results in
[bench/results/](bench/results/)):

- [delivery_policies](bench/results/delivery_policies.md): five tasks
  under eager-full, lazy-no-prefetch, hot-tier, profile, and
  leave-one-out-profile delivery. Reproduces the prototype's byte
  asymmetries as end-to-end rollout rows: at 150 MB/s, modeled fetch drops
  from 0.47s (eager full) to 0.14s (hot tier) with the lazy tail visible
  per policy.
- [capture_regrade](bench/results/capture_regrade.md): checkpoint capture
  costs 9-66 ms and 0.03-0.3 MB per rollout on these tasks, and re-grading
  from the checkpoint alone (the sandbox is destroyed first) takes
  16-68 ms and reproduces the live reward exactly for every task. That is
  the post-agent-loop decoupling working end to end: grade twice, run
  once.
- [concurrency_scale](bench/results/concurrency_scale.md): the same
  rollout set at worker-pool sizes 1, 4, and 16 on a 4-vCPU host.
  Throughput stays flat (322 to 353 rollouts/min) while p95 task time
  degrades 11x (0.24s to 2.67s). Piling concurrency onto one host buys
  latency variance, not throughput. This is the cheapest possible
  demonstration of why rollout fleets scale horizontally, and of where
  timing noise that can contaminate rewards comes from.

The harness is also the vehicle for the experiments this document says
should exist but could not run on one machine: the reward-noise A/B
(lazy vs eager delivery, comparing reward distributions), cache-tier
hit-rate studies, and restore-under-concurrency. Those need either a
second machine or a real network between fetch and mount, and the spec
format already has room for them.

## Risks and what must be true

- The grader question. If most graders only inspect final filesystem state,
  FS-level checkpoints cover re-grading fully. If a meaningful fraction
  needs live services, restore must boot base-plus-diff and re-run service
  startup (seconds, usually fine). If graders need in-memory-only state,
  only the memory-capture adapters help, and the case for FS-level capture
  narrows. Surveying real graders across a few platforms is the single
  highest information-per-effort step.
- Reward noise from laziness. Mid-rollout cache misses inject timing
  variance into environments, and timing-sensitive tasks may translate that
  into reward variance. Background and profile-guided prefetch bound the
  window; an A/B harness that compares reward distributions with and
  without lazy delivery should be part of the layer's own QA. The
  benchmark platform below is the seed of exactly that harness.
- Dedup scope versus tenancy. Content addressing across tenants leaks blob
  existence through cache timing and creates a poisoning surface if hashing
  or verification is ever wrong. Default to per-tenant dedup; cross-tenant
  only with measured savings and a real isolation review.
- Checkpoint capture tail latency. Sealing a diff synchronously at
  agent-loop end delays sandbox teardown, which is paid fleet time. Eject
  the writable layer at freeze time, seal and upload asynchronously, and
  mark the checkpoint available when the upload lands.
- Standards drift. The container ecosystem is steadily absorbing lazy
  delivery. The durable contribution is not lazy pull; it is the
  checkpoint semantics, lineage, and the workflows above them. Archetype 1
  alone is a melting asset.

## Open questions

1. Across real rollout platforms, what fraction of graders read only final
   filesystem state versus needing live services or process memory?
2. What runtimes are actually in production across such platforms (plain
   containers on VMs, microVMs, orchestrators, rented sandboxes), and in
   what proportions? This sets the adapter build order.
3. Is data custody in the platform's own cloud account a hard contractual
   requirement downstream, or folklore? F2 rests on it.
4. How much cross-image byte overlap exists in practice across a real task
   catalog? This prices content-defined chunking against simpler file-hash
   dedup.
5. What retention window do training and audit workflows actually demand
   for checkpoints, and who pays for it?
6. Is shared mutable storage across sandboxes (agent memory, shared
   scratch) part of the same problem, or a different layer for a different
   need? It sits outside the pruned region and should not ride along by
   default.
7. For the fork job: how often is fan-out from a common prepared state
   (hundreds of rollouts of one task within minutes) versus embarrassingly
   parallel distinct tasks? Fork frequency decides whether pre-agent
   checkpoints justify memory-capture adapters early.

## Sources and further reading

The design text above stays vendor-neutral; this section names names, since
the concepts came from somewhere and we are here to learn.

### Academic papers

- Harter et al., Slacker: Fast Distribution with Lazy Docker Containers,
  [USENIX FAST '16](https://www.usenix.org/conference/fast16/technical-sessions/presentation/harter).
  The empirical basis for lazy delivery: containers read a small fraction
  of their image bytes before and during useful work.
- Vangoor et al., To FUSE or Not to FUSE,
  [USENIX FAST '17](https://www.usenix.org/conference/fast17/technical-sessions/presentation/vangoor).
  The cost model for userspace filesystem interfaces (axis A option 2).
- Oakes et al., SOCK: Rapid Task Provisioning with Serverless-Optimized
  Containers, [USENIX ATC '18](https://www.usenix.org/conference/atc18/presentation/oakes).
  Lean containers and zygote-style pre-initialization; an ancestor of the
  pre-agent-checkpoint idea.
- Agache et al., Firecracker: Lightweight Virtualization for Serverless
  Applications, [NSDI '20](https://www.usenix.org/conference/nsdi20/presentation/agache).
  The microVM base underneath most snapshot/restore sandbox platforms.
- Du et al., Catalyzer: Sub-millisecond Startup for Serverless Computing
  with Initialization-less Booting,
  [ASPLOS '20](https://ipads.se.sjtu.edu.cn/_media/publications/catalyzer-asplos20.pdf).
  Restore-instead-of-boot with lazy memory mapping.
- Ustiugov et al., Benchmarking, Analysis, and Optimization of Serverless
  Function Snapshots (vHive/REAP),
  [ASPLOS '21](https://doi.org/10.1145/3445814.3446714). Functions touch a
  stable working set of memory pages across invocations; record-and-
  prefetch cuts cold starts 3.7x. The memory-page twin of this project's
  file-level leave-one-out result.
- Ao et al., FaaSnap: FaaS Made Fast Using Snapshot-based VMs,
  [EuroSys '22](https://dl.acm.org/doi/10.1145/3492321.3524270). Concurrent
  paging and per-region mapping on top of REAP-style working sets.
- Seekable OCI: Lazy-Loading Container Images via Range-Request Indexing,
  [arXiv 2607.06868](https://arxiv.org/html/2607.06868). External-index
  lazy pull over unmodified images.

### Engineering writeups from industry

- DeepSeek-AI, [DeepSeek-V4 technical report](https://arxiv.org/html/2606.19348),
  section 5.2.5 "Sandbox Infrastructure for Agentic AI". DSec: a
  production sandbox platform for agentic RL post-training (hundreds of
  thousands of concurrent sandboxes) with four execution substrates behind
  one SDK, EROFS on-demand image loading over the 3FS distributed
  filesystem, overlaybd copy-on-write layers with chainable snapshots and
  millisecond resumption, and per-sandbox trajectory logs for
  preemption-safe resumption and deterministic replay. The closest thing
  in print to this document's recommendation, built lab-side.
- Modal, [How we achieved truly serverless GPUs](https://modal.com/blog/truly-serverless-gpus).
  The four-ingredient stack this project's delivery/checkpoint framing
  started from: warm buffers, content-addressed lazy image FS, CPU
  snapshots, GPU snapshots.
- E2B, [infrastructure architecture](https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md).
  "A sandbox is a resumed snapshot": userfaultfd lazy page-in, COW rootfs
  as NBD, async diff sealing, P2P chunk transfer. Open source, and the
  closest existing implementation of archetype 2's capture side.
- Archil, [Bash is the SQL for file systems](https://archil.com/post/serverless-execution)
  and [S3 Files: the right product on the wrong foundation](https://archil.com/post/s3-files-deep-dive);
  docs on [branches and checkpoints](https://docs.archil.com/concepts/branches-and-checkpoints)
  and [architecture](https://docs.archil.com/details/architecture).
  The persistent-shared-disk view of agent storage (axis G option 3
  territory): the filesystem outlives the sandbox, compute is ephemeral.
  Their branches-or-backing-bucket exclusivity and "a branch is not a
  security boundary" caveat both informed the pruning here.
- Morph Cloud, [Infinibranch](https://cloud.morph.so/docs/developers).
  VM snapshot/branch/restore in the 100-250 ms range, aimed directly at
  RL rollouts; archetype 3 in its purest commercial form.
- Grab engineering, [Docker lazy loading with eStargz and SOCI in production](https://noise.getoto.net/2026/01/21/docker-lazy-loading-at-grab-accelerating-container-startup-times/).
  Production comparison; lazy pull redistributes rather than eliminates
  download time.
- Zain Malik, [Lazy-pulling container images: a deep dive into OCI seekability](https://blog.zmalik.dev/p/lazy-pulling-container-images-a-deep).
  The clearest survey of the eStargz/SOCI/Nydus/overlaybd tradeoff space.

### Projects and tools

- [stargz-snapshotter](https://github.com/containerd/stargz-snapshotter),
  [soci-snapshotter](https://github.com/awslabs/soci-snapshotter),
  [Nydus](https://github.com/dragonflyoss/nydus): the three main lazy-pull
  snapshotter families for containerd.
- [Dragonfly](https://d7y.io/) and [Kraken](https://github.com/uber/kraken):
  P2P image/blob distribution (axis E option 3 at fleet scale).
- [CernVM-FS](https://cvmfs.readthedocs.io/): lazy, content-addressed,
  globally distributed read-only FS; two decades of prior art on serving
  software to ephemeral workers.
- [CRIU](https://criu.org/): checkpoint/restore in userspace, the base
  mechanism under most process-level capture (axis B option 4).
