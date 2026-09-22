# Compose useful interfaces from a prepared library

- Owner: root/design engineering, with routing/runtime support
- Stage: next wave; source analysis starts now
- Status: experiment accepted; library, style grammar and evaluation protocol open
- Depends on: code organization, typed-decision contract, artifact/version semantics, design direction
- Evidence: [Jeverative study](../jeverative-analysis.md), [existing composer analysis](../existing-composer-analysis.md)

## Question

Can Jev turn a task, a user-written style Markdown document and prepared app-pattern rules into a useful responsive interface within a 1–2 second target?

## Direction

Reimplement the idea demonstrated by [Jeverative Interfaces](https://jeverative-ui.vercel.app/), which credits [@hckmstrrahul](https://x.com/hckmstrrahul). Use a selected [shadcn/ui](https://github.com/shadcn-ui/ui) component library with typed props, bindings and authored actions. Build on the existing composer where it helps, while allowing replacement of its structure. The external application's source and reuse license remain unverified; its observed interaction is a reference for an independent implementation.

Keep four inputs explicit: a component catalog, a style document, app-pattern rules, and the user's task/data. A style document can be supplied or written by the user. Compile its supported rules into validated tokens and variants, preserve the original text and revision, and show conflicts or unsupported instructions. A document hash alone is not model context. Never execute arbitrary JavaScript or CSS found in prose.

Start with authored patterns such as settings, searchable list/detail and comparison. Each declares required regions, data requirements, real actions, responsive behavior and semantic checks. [Mobbin MCP](https://mobbin.com/mcp) can inform this research when authenticated access is available; record the original app and source screen. Research and pattern preparation occur before the measured composition request. Mobbin is not a required service on that request path and reference access does not license copying an application's implementation.

Jev chooses bounded patterns, optional regions, emphasis, ordering and style variants through the shared typed-decision contract. Code validates the combined choices and renders a deterministic responsive composition. Prefer one batched call for independent choices, with a second pass only when choices depend on an earlier answer. Existing recorded examples do not establish a general 1–2 second result.

An optional Qwen or Haiku refinement can propose improved copy or a different catalog-valid composition after the initial interface is usable. Record actual model identity and separate time/cost. Keep current edits and focus intact, offer a reviewable proposal, and reject stale results. Whether refinement improves quality or efficiency is an evaluation question. Do not describe a slower extra call as an efficiency win without measurements.

## Open decisions

- Which initial patterns support complete tasks, including persistence/export and error recovery?
- How should exact style rules override pattern defaults, and which prose interpretation needs inference?
- Does a curated shadcn renderer or an adapted existing registry produce the most coherent, accessible result?
- What data belongs to the task, and what belongs to layout history? How do revisions and refinement preserve drafts, selection and focus?
- Which specific provider/model configurations should be compared? A model-family name alone is insufficient provenance.

## Completion gate

Freeze a workflow suite before model runs. Compare deterministic defaults, Jev composition and Jev plus optional refinement on the same patterns, content and style rules. Repeat the same task with different supported style documents; check the resulting tokens/variants and rendered rule adherence, plus required pattern regions and actions. An ignored style document is a failure even if the page looks plausible. Include unsupported actions, contradictory styles, option order, keyboard use, narrow screens, editing during a request, cancellation and actual task completion. Measure first usable paint and final accepted result separately, with cold/warm p50/p95, coverage, failures, all calls/retries and total cost. Identify cached examples and preparation costs. Preserve slow and failed runs.

The entry experience needs an immediate recorded example, editable style Markdown, inspectable choices and supported capabilities, real responsive behavior, and an export containing the composition and its input revisions. Public notes should explain a concrete decision with code and measured evidence. See the separate [implementation checklist](../IMPLEMENTATION.md#fast-ui-composition-next-wave). The 1–2 second target is not a release claim yet.
