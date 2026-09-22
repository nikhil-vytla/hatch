# Existing composer analysis

2026-09-21. Repo-only investigation for the proposed reimplementation of `jeverative-ui.vercel.app`. The separate site investigation owns observations about that application. This note records current local capabilities, a proposed decision contract, and work to put on the roadmap. No composer implementation or model calls were made.

The useful starting point is the existing json-render composer, its state bindings, and the shared typed-decision runtime. The missing product is a compiler from a component catalog, editable style Markdown, and app-pattern rules into a usable interface. Jev can make bounded design choices quickly; arbitrary copy, new components, and application behavior require additional authored inputs or a separate generation step. The requested 1–2 seconds is a target to measure, not an established property of the current experiment.

## What already exists

Paths in this note are relative to the repository root.

| Piece | Current behavior | Reuse and boundary |
| --- | --- | --- |
| [Component catalog](../experience-prototypes/src/ui-catalog.ts), `jev-experiments/experience-prototypes/src/ui-catalog.ts:7` | Eleven Zod-defined types: Stack, Card, Heading, Text, Input, Toggle, Metric, Button, Choice, Apartment, and Progress. Settings and apartments each offer 10 recipes; event planning offers 12. | Keep typed props, slots, events, and finite recipes. Each recipe fixes copy, binding paths, and action parameters. Jev selects recipes and structure; it does not write these values. |
| [Composer wrapper](../experience-prototypes/server/compose.ts), `jev-experiments/experience-prototypes/server/compose.ts:25` | Calls `experimental_composeSpec` with catalog, candidates, prompt, initial state, optional existing spec, and a native Jev evaluator. Defaults to sequential composition; accepts `batch`. Limits are 22 elements, depth 5, and 32 initial or 16 revision evaluation steps. | Reuse the validated operations and batch option. Replace the three-domain switch with explicit pattern capabilities. Do not make the entire app depend directly on an experimental package API. |
| [Renderer and editing UI](../experience-prototypes/src/generated-ui.tsx), `jev-experiments/experience-prototypes/src/generated-ui.tsx:69` | Original React registry, real input bindings, local actions, streamed previews, version selection, stop control, and recorded replay. State is held by a keyed `StateProvider`; current data is saved into a version before generation or changing versions. | Reuse binding and action mechanisms. Separate canonical task data from layout versions before adding concurrent refinement. Save currently shows a notice; shortlist is an actual local add/remove collection. Neither is a complete application backend. |
| [Streaming parser](../quality-and-simulation-review/composition-stream.ts) and [tests](../quality-and-simulation-review/composition-stream.test.ts) | Parses split UTF-8 NDJSON, final records without a newline, and cancellation. The component rejects obsolete request versions and detects EOF without completion. | Keep these cases. Add a typed event envelope and explicit base-revision identity for the new composer. A syntactically valid event is not a valid component tree or successful user task. |
| [Shared decision contract](../roadmap/runtime/contract.ts) and [execution wrapper](../roadmap/runtime/execute.ts) | Choice, boolean, and ordinal questions; complete distributions; runtime identity and limits; timing; explicit unsupported/error/cancelled results; validation before and after inference. | Use this contract for new Jev composition decisions. Adapt json-render's choice questions at one boundary. The old composer wrapper currently bypasses this shared contract and discards most gateway metadata. |
| [Jev adapter](../roadmap/runtime/jev.ts) | Converts shared questions into the native hosted Jev protocol and retains execution identity, distributions, and timing. | Reuse the checked adapter path rather than adding another Jev transport. Preserve choice semantics when adapting back to json-render. |
| [Record utilities](../experience-prototypes/scripts/records.ts) | Encodes and decodes the repo's `jev-records-v1` JSONL format. | Reuse for complete composition traces and publication. Add catalog, pattern, style, and compiler revisions to new records. |

The renderer currently imports `@json-render/core` and `@json-render/react`, not the installed shadcn renderer. [The application package](../experience-prototypes/package.json) already pins all three json-render packages to 0.21.0 and includes React 19.2.4, Zod 4, Tailwind 4, Motion, Lucide, and TanStack Table. [Vite](../experience-prototypes/vite.config.ts) already runs the Tailwind plugin. No new framework is needed for a first experiment.

Inspection of the installed 0.21.0 shadcn declarations found `shadcnComponents` and `shadcnComponentDefinitions`, including Grid, Tabs, Table, Dialog, Drawer, form controls, and navigation controls. Select a useful subset and wrap it in the app's catalog. The existing custom prop schema is not interchangeable with that package's schema: Stack uses `small/medium/large` here versus `sm/md/lg` there, and Card uses `subtitle` here versus `description` there. Some library components accept `className`; a style compiler still needs an explicit policy for permitted variants and values. Verify packaged class scanning and theme variables in a production build rather than assuming installation makes styles work.

There is no style-Markdown reader, style interpretation record, app-pattern registry, Mobbin MCP integration, or Qwen/Haiku refinement stage in the reviewed application composer path. The older [Python UI experiment](../src/jev_lab/pilots.py), `jev-experiments/src/jev_lab/pilots.py:186`, already asks about layout, density, emphasis, and field inclusion in one typed request. Those question categories are useful; its layout labels are not evidence of generated application quality.

## What the evidence supports

Decoded [initial composition records](../experience-prototypes/results/composed-ui.jsonl) contain three finished examples:

| Domain | Elements | Recorded composer elapsed time |
| --- | ---: | ---: |
| Settings | 8 | 2,753 ms |
| Apartments | 5 | 1,651 ms |
| Event planning | 10 | 21,607 ms |

Three earlier attempts remain recorded: two limit stops and one unavailable result. Configuration changed between attempts. These are examples, not a controlled success rate or latency distribution. Input-token totals are null. The separate [cloud check](../experience-prototypes/results/cloudcheck.jsonl) records one settings revision in 832 ms total, with its first response chunk at 508 ms. It removed the notification toggle while preserving an edited name. That is one server revision, not a 1–2 second application-generation result.

Several observations in the [earlier UI audit](../quality-and-simulation-review/experiments/ui.md) have since been repaired. Current source accepts `batch`, aborts on domain changes and unmount, checks request versions, labels premature EOF, saves the outgoing version's current data, ignores reselecting that version, and maintains a shortlist. Do not turn those historical findings directly into current bug tickets. Replay still reveals prefixes of a final tree at a fixed 550 ms interval; it is not a playback of actual event timing. The recorder still reuses finished rows by domain and collects step events separately from the terminal event's complete trace. New comparisons need fresh, versioned evidence rather than treating these old records as a current reproducibility test.

A provider-free check during this investigation exercised the actual wrapper with an in-memory mocked gateway. Both strategies produced the same four-node canvas/name/email/save interface. `batch` made two logical evaluator calls containing 11 and 3 questions; `sequential` made five calls containing one question each. Both retained a fixture value in output state without sending that value in evaluator input. This confirms call structure and the state boundary only. It measures no model quality, network latency, or inference latency. The installed composer supports an explicit `context` object, but the current wrapper does not supply it, so changing a bound budget field does not automatically inform composition.

## Proposed composition boundary

Keep four inputs distinct:

1. **Component catalog.** Versioned React components, prop schemas, supported slots, binding paths, and action definitions. Application code owns effects and validation.
2. **Style document.** User-editable Markdown with original text and a content hash. Interpret prose into a small set of allowed typography, spacing, density, color, shape, and motion choices. Preserve exact supported user-supplied values where applicable. Expose unresolved or conflicting rules instead of silently mapping every document to the same preset. The compiled style needs a visible connection to the source lines.
3. **App-pattern rules.** Authored structures such as searchable list/detail, settings form, or comparison desk. Each declares required and optional regions, supported data and actions, legal nesting, responsive behavior, and semantic postconditions. A Mobbin MCP retrieval could help author these rules, with source links and access conditions recorded. It is not a runtime dependency by default and does not supply permission to copy implementations.
4. **Task data and request.** The brief, available records and fields, current editing state, and approved derived context. Calculations, filtering, save effects, and permissions remain deterministic code.

For a fast first pass, start from patterns with known slots. Ask Jev for a pattern, optional regions, emphasis, and a few style variants in one batched request where decisions are independent. Code expands the chosen pattern into a validated tree and binds supplied data. A second typed pass can choose ordering or grouping when those choices depend on the first. Measure that path against the existing two-call batch composer before replacing it. Asking a sequential model question for every component is an expensive default when the pattern already determines most of the structure.

Freeform copy and new component implementations do not fit a finite-choice decision interface. The first usable result can use user-supplied labels, data, and authored pattern copy. Optional Qwen or Haiku refinement can propose better copy or a richer catalog-valid composition later. That proposal should have its own model identity, latency, cost, schema, and validation result. Keep the first result usable while refinement runs; compare or accept the proposal explicitly, and reject responses based on an obsolete document revision. This is a proposal for the roadmap, not an existing capability or measured speed ranking between those model families.

The routing toolkit's [structured artifacts](../roadmap/routing/artifacts.ts) and [executor types](../roadmap/routing/types.ts) provide possible transport/accounting building blocks. Their generic `{kind, text}` envelope does not validate a UI specification. A refinement adapter still needs the catalog-specific schema, invariant checks, and a clear decision about whether it returns a whole spec or bounded edits. Do not import coding-patch repair into interface editing.

## Likely decision contract

Use the existing `DecisionRequest` and `DecisionResponse` unchanged for inference. Put composer-specific state and metadata around them instead of creating a second inference protocol.

| Contract area | Proposed content |
| --- | --- |
| Request identity | Shared `requestId`, plus composer `sessionId`, `baseRevision`, and catalog/style/pattern revisions. The caller owns the abort signal. |
| State | User brief, style text or its explicit compiled rules, offered pattern and component descriptions, supplied content schema, minimum approved derived context, and current presentation summary for revisions. A hash alone cannot tell a model what a style document says. |
| Questions | `pattern` as a finite choice; region inclusion as booleans; density/emphasis/variant as finite choices; bounded order choices only within legal slots. Omit determined decisions rather than asking trivial questions. |
| Decisions | Full distributions and selected values from the shared response, checked against the offered set. A distribution is not a correctness guarantee. Independent selections still require joint checks for required regions, incompatible choices, cycles, and duplicate uses. |
| Compiled artifact | Validated component tree, stable element IDs and binding paths, style tokens, action references, input revisions, actual runtime identity, decision trace, and timing for interpretation, inference, compilation, and rendering. |
| Failure | Shared unsupported/error/cancelled state, plus a composer explanation of an unsupported request or conflicting rules. Preserve the current working interface. Never silently truncate an oversized catalog or label a partial tree complete. |

The current runtime rejects unsupported input sizes and option counts. A larger catalog needs a deliberate shortlist or hierarchical selection protocol, with excluded capabilities disclosed and evaluated. Local inference is another explicit adapter condition; installing a local model does not establish its suitability for composition.

## Roadmap gates and open decisions

- Decide the first supported app patterns and their actual task outcomes. A page that renders a form is incomplete if Save has no defined effect.
- Define the style Markdown format, precedence between exact user rules and pattern defaults, and the treatment of unsupported rules. Decide which parts can be interpreted in the same Jev call as composition.
- Compare a curated shadcn registry with the current custom registry on the same tasks. Keep component changes separate from claims about better model decisions.
- Choose the canonical-data and layout-history semantics. Edits, branch selection, replay, and late refinement must not reset data or replace a newer layout.
- Freeze a bounded workflow suite before model runs. Include required content, an unsupported action, conflicting style rules, narrow layouts, keyboard interaction, save behavior, and revisions after user edits. Separate semantic task success from visual preference.
- Treat 1–2 seconds as a first-usable-interface target. Record first usable paint and final accepted result separately, with cold/warm conditions, p50/p95, failure coverage, request count, retries, and total cost. A prepared preview or a cache hit must be identified as such. Preserve slower runs and failures.
- Compare the same patterns and content across deterministic defaults, Jev decisions, and optional refinement. Evaluate refinement as an incremental change to a working result, including whether it preserves user intent and state.

This pass read the current wrapper, renderer, catalog, stream parser, shared runtime, installed package declarations and composition implementation, record utilities, existing audit, and published composition records. It decoded records and ran one mocked-gateway comparison without network access. Existing source, dependencies, and measured evidence were not changed.
