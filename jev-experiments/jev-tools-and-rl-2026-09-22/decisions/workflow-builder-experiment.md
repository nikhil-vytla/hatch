# Can typed branches improve a small workflow?

- Owner: root/design engineering, with routing/integration
- Stage: next wave; extend the existing agent-flow experience
- Status: proposed experiment; protocol and implementation open
- Reference: [Chris Nicholas's Jev Workflow Builder](../workflow-builder-analysis.md)
- Depends on: existing React Flow, typed-decision contract, routing toolkit, immutable graph/run artifacts, independent task grader

## Direction and first action

Build a **workflow trace lab** around one support-request example. The first action is “Replay this request”: a recorded trace highlights each fired branch and exposes its input, decision distribution, output and observed failure state. The visitor can then fork the graph, change one urgency condition, and compare the resulting path. Editing does not rewrite an earlier run or relabel a replay as live execution.

Limit the initial graph to input, typed decision, bounded draft generation and named output nodes. Provide OR/AND joins with visible semantics, one output schema, and a validated acyclic graph. Output is a proposed customer reply and optional team note; nothing is sent. An exported artifact contains the complete graph snapshot and hash, task/input revision, run ID, ordered events, parent relationships, actual runtime identities, usage, statuses and drafts. Authored examples are public; private text stays out of shared URLs and automatic publications.

Reuse [Model Routing Lab](../../roadmap/routing/README.md) for eligible model selection and execution. Resolve each delegated task's destination once and preserve that selection until the task completes. A graph cannot bypass hard spending, tool or locality restrictions. The deterministic executor owns branch activation and permissions; the model supplies typed observations. Require exact task compatibility before adding the proposed Jimothy node condition. Do not add Liveblocks or another framework merely to draw a graph: begin with the existing React Flow dependency and local artifacts.

## Protocol to freeze before model evaluation

Prepare 80 authored, redistributable support requests with explicit facts, admissible paths and output requirements: 20 development cases and 60 held-out cases, grouped by underlying scenario and paraphrase family. Cover routine/urgent billing, routine/urgent technical questions, unsupported requests and ambiguous requests equally in the held-out set. Freeze input hashes, graph revisions, prompts, criteria, join rules, threshold policy, provider revisions, cost ceiling and independent grader before any held-out execution. These are controlled fixtures, not a representative customer-support benchmark.

Compare three conditions on the same inputs and allowed outputs: a fixed linear workflow, deterministic rule-based branching, and Jev branching. Use the same generator model/configuration and output budget wherever a generator is called. Report three predefined repetitions, retaining every failure. Reusing recorded outputs is an explicitly labeled offline branch replay; actual downstream live success requires actual execution with that condition's resolved inputs. Select policies using development only. Any model alias that lacks an immutable revision is recorded as such.

Primary task success requires an admissible branch, correct required facts and no unsupported promised action in the resulting drafts. Retain each component as a separate metric. Use deterministic checks for factual fields and blinded human review for residual draft criteria; do not let the same Jev judgment both route and establish success. Report paired group-resampled differences, intervals and denominators. Secondary measures include branch confusion, review/unsupported coverage, per-node probability error, rework and total cost. Small fixtures do not establish calibrated confidence or production savings.

Separately freeze 30 provider-free execution fixtures covering cycles, dangling handles, duplicate question IDs, incomplete criteria, malformed distributions, OR/AND joins, missing parents, conflicting merges, missing output, API failure, timeout, cancellation, editing during execution, unmounting and damaged imports. Define invalid graphs as rejected before calls. Distinguish inactive, unsupported, cancelled, unavailable and errored nodes; an empty question set must not look like a successful decision.

## Completion gate and boundaries

Every replay must reproduce its original graph and events after later edits. Live results need run/revision checks before application, cancellation through all adapters, and explicit incomplete-trace states if persistence fails. Mock, recorded and live identities remain visible at node and run level. Score branches must state whether they use argmax, expected-value rounding or another frozen policy; threshold crossing does not itself prove correctness.

Measure wall-clock latency, critical-path latency and per-node time separately; parallel node durations cannot be added into a user wait time. Include routing, classification, verification, generation, retries, transport and persistence overhead in costs and latency. Preserve unknown charges as unknown and enforce declared caps before execution. Verify keyboard, touch, reduced motion, narrow screens, import/export round-trip and “first useful result” without credentials.

Multiplayer is a later, separately gated addition: real authenticated users, room permissions, authorized run endpoints, retention controls, concurrent edit semantics and multi-client recovery tests. The upstream example's collaboration code is source inspiration, not proof of those guarantees. This ticket authorizes roadmap investigation only; no catalog entry, provider run, public endpoint or implementation is added here.
