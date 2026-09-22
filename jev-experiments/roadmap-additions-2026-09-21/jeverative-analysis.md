# Jeverative Interfaces, observed

Checked on 2026-09-21 in an isolated Chromium session at [jeverative-ui.vercel.app](https://jeverative-ui.vercel.app/). The site credits [@hckmstrrahul](https://x.com/hckmstrrahul). No public source repository or implementation license was verified, so this study records behavior and design ideas for an independent implementation. Captures are attributed reference material, not Jev branding assets.

The page puts the brief, two generation modes and prepared examples above a large live preview. Device-width controls sit beside the preview. Its About panel describes a prepared component library, Jev selection and arrangement, local validation, and a separate LLM mode for requests beyond the library. These are the site's explanations; the browser study did not inspect server code or verify which provider/model executed a request.

## Two bounded examples

| Input | Observed outcome | Timing boundary |
| --- | --- | --- |
| Authored prompt: `A support inbox with searchable tickets, priority filters, assignee, and a detail pane.` | The Jev-only mode rejected the requested content/capabilities as outside its library. No preview resulted. | Browser resource duration for `/api/generate`: 1,158 ms, HTTP 200. This is a semantic unsupported response despite transport success. |
| Site's built-in support-inbox example, requesting a conversation workspace with search, replies and customer detail | Produced a 19-element preview with static conversation/detail sections and a separate local interactive inbox. | Site displayed 1.35 seconds; browser resource duration was 1,712 ms, HTTP 200. Neither is a verified click-to-usable-paint measurement. |

Only these two composition requests were made. Cache state, server-side model identity, provider usage and cost were not established. The research did not exercise the LLM mode. The first attempt at click-to-response instrumentation failed because the command environment lacked a `URL` global; a later text capture hit a strict locator error because the page has two `main` elements. Existing resource timings and visible results were inspected afterward without repeating those requests. No p50/p95 or general speed claim follows from these observations.

Selecting Aarav in the local inbox changed the active conversation and reply label. A typed draft disappeared after changing the preview from desktop to mobile: the selection returned to Maya, and reselecting Aarav showed an empty field. Returning to desktop also reset selection. No message was sent. This one reproduction is sufficient to add draft and selection preservation to our reimplementation acceptance tests; it is not a comprehensive assessment of the upstream app.

The mobile preview changed to a 390 × 844 layout within a 1440 × 1080 browser viewport. It stacked sections and retained the surrounding editing controls. This was the site's preview mode, not a phone or a complete mobile-browser accessibility test. The page itself had no horizontal overflow at the desktop viewport. Search behavior, saving, message persistence, keyboard coverage, touch interaction and dark mode were not evaluated.

## What to borrow and what to test

Keep the short path from a prepared example to a visible result. Put style choices and supported capabilities close to the brief. The large preview and direct device-width controls make the composition tangible. Keep model/refinement modes distinguishable, with actual execution records available on demand.

A rendered collection of plausible controls does not establish a coherent workflow. This preview included two conversation sections with different sample messages. Our patterns should declare a single data model, real actions and consistency checks, then test an actual task. Changing layout must not replace that data model or remount away the user's draft.

The [existing local composer study](existing-composer-analysis.md) identifies useful code already in this repository, including typed catalogs, state bindings, batching, cancellation and recorded artifacts. Use the [shared decision contract](../roadmap/runtime/contract.ts) for the new decisions. Measure the first usable result, then measure optional Qwen/Haiku refinement separately.

## Component and pattern sources

[shadcn/ui](https://github.com/shadcn-ui/ui) supplies the component precedent. Its [registry schema](https://ui.shadcn.com/docs/registry/registry-item-json) describes component, block and theme artifacts; its [theming documentation](https://ui.shadcn.com/docs/theming) explains semantic CSS variable pairs and dark-theme values. A curated subset still needs our own prop/action constraints, responsive patterns and production-build styling checks. Installed dependencies alone do not create a coherent design system.

[Mobbin's official MCP page](https://mobbin.com/mcp) describes authenticated access for paid plans. No callable Mobbin connector was available in this session, so no Mobbin screens or app rules were retrieved. Treat it as an optional source-research dependency, record source apps and usage conditions, and keep retrieval outside the composition request path. A search-indexed client-documentation URL returned 404; the working official MCP page is the source retained here.

## Visual artifacts

- [About and architecture explanation](output/playwright/jeverative-about.webp)
- [Unsupported request](output/playwright/jeverative-unsupported.webp)
- [Built-in desktop result](output/playwright/jeverative-preset.webp)
- [Mobile preview within the desktop editor](output/playwright/jeverative-mobile-preview.webp)

[capture-manifest.json](capture-manifest.json) records dimensions, source, state, hashes and file sizes. All captures show the public demo and were inspected before selection. The [decision](decisions/fast-ui-composition.md) and [checklist](IMPLEMENTATION.md#fast-ui-composition-next-wave) keep proposed work separate from these observations.
