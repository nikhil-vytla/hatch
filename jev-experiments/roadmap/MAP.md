# Jev release map

## Destination

Ship useful playable scenes, a materials sandbox, a completed local typed-decision study, a routing toolkit that works inside existing coding clients, and an installable Mac runtime. A negative research result can ship. A broken installation or misleading demonstration cannot.

## Notes and standing requirements

The supplied release plan is the authority for this map. It explicitly includes implementation, overriding wayfinder's usual planning-only scope. Decision tickets below record questions and resolutions; [implementation checklist](IMPLEMENTATION.md) tracks delivery. Owners are workstream names, with the root integrator responsible for merging and verification. Read the evidence before changing a resolved decision.

- Publish the exact footnote "Not affiliated with or endorsed by TypeSafe AI". Credit original builders next to adaptations, distinguish model authors from playground authors, and retain design research with visual and styling artifacts.
- Backward compatibility is not a release goal. Refactor structure and replace weak interactions when that produces a more coherent, useful, well-crafted result.
- Keep Bun and the existing Vercel project and URL. Its root stays `jev-experiments/experience-prototypes`. Keep parent source access and committed JSONL inputs available to clean builds.
- Keep unfinished entry experiences out of the public catalog. Historical research remains labeled with its original protocol.
- Separate classification, hard eligibility, preference selection, execution and outcomes. No fallback widens permissions, capabilities, context or explicit spending limits.
- Use one typed-decision contract across hosted, local and heuristic conditions. Classifier comparisons use the same selection policy. Delegation occurs at a bounded task boundary; the calling client owns edits and tool execution.
- Preserve the full Tetris game, human handoff, synchronized branches and adjustable 700 ms grace default. Attribute fallback controller time separately.
- Keep local music playable while decisions affect future musical boundaries. Listener preference is not an objective musical-quality claim.
- Freeze training splits, transformations, primary metrics and bounded search before fitting. Choose checkpoints and installed default only on validation data. Repeat selected recipes across three seeds. Keep all 400 Typed Decisions test cases out of general adaptation and report them separately.
- Label candidate-selection derivatives accurately. Report unsupported inputs, calibration, order sensitivity, batch independence and full Core ML decision-level drift. Keep the old workflow specialist separate.
- Local email processing reads explicitly supplied `.eml` files. It does not alter mailboxes or silently fall back to cloud inference. Separate installation and inference dependencies from training dependencies.
- Reuse existing libraries. Share concrete cancellation, disclosure and artifact consumers when useful. Do not introduce a universal experiment engine.
- Review duplication after every two integrations and before release. Serialize GPU work and performance measurement. Use Fable 5.1 Global through OpenCode/AWS Bedrock at frozen protocol, integrated prototype and release gates; retain feedback and independently verify consequential findings.
- Commit authored artifacts in this work folder and save existing-code changes as patches, per root AGENTS.md. Fetched repositories, model weights and build output stay out of commits.

## Delivery stages

| Stage | Deliverables | Completion gate | Current status |
| --- | --- | --- | --- |
| Foundations | Contracts, CI, publication metadata, common runtime | Clean build and provider-free checks | Verified locally, including canonical-root build before sibling installs |
| Internal previews | Play-first home, Tetris/crowd/music, routing integration | Visual review and actual client calls | Implemented, visually checked and exercised through real clients |
| First public release | Playable core/materials, trained models/export, routing/CLI/MCP, Mac runtime | Research, usability, integrations and installation verified | Not released |
| Next wave | Perception, private extension, source-linked annotations, icons/brushes | Named dependent decisions | Deferred |
| Further products | Creative apps, richer mail, games/GPU worlds | Investigate before implementation commitment | Deferred |

## Decisions so far

- [Build an instrument notebook](design-research/README.md) records the design-engineering research and separates visual inspiration from copied implementation.

- [Preserve the deployment and research boundaries](decisions/deployment-boundary.md) records the canonical source root and patch-only research delivery rule.
- [One typed-decision wire contract](decisions/decision-contract.md) fixes runtime identity, distribution and unsupported-result semantics.

## Frontier and dependencies

| Decision | Owner | Depends on | Status / evidence |
| --- | --- | --- | --- |
| [Freeze training and export criteria](decisions/training-protocol.md) | training/runtime | Typed contract | Resolved; execution tracked separately |
| [Keep routing restrictions hard](decisions/routing-policy.md) | routing/integration | Typed contract | Resolved; negative comparison retained |
| [Prove client delegation with real tasks](decisions/harness-evidence.md) | routing/integration | Routing policy | Real calls and independent tasks passed; see evidence index |
| [Make scene changes observable](decisions/playable-defaults.md) | playable/root | Deployment boundary | Resolved; local production-build captures, functional checks and active frame samples retained |
| [Select an installed local default](decisions/local-default.md) | training/runtime | Training criteria, export and mail evaluation | Resolved; validation-selected experimental Laya readout, fresh offline install passed |
| [Release only supported claims](decisions/release-gate.md) | root | All first-release decisions | Local artifact acceptance recorded; public deployment open |

## Later named decisions

| Decision | Dependency | Scope |
| --- | --- | --- |
| [Selective observation resolution](decisions/selective-perception.md) | Render profiling and frozen visual labels | Next wave |
| [Private extension inference runtime](decisions/private-extension.md) | Local runtime and ONNX/browser measurements | Next wave |
| [Correct source-linked interpretations](decisions/source-annotations.md) | Café, wardrobe and paste artifact contracts | Next wave |
| [Icon and brush interaction improvements](decisions/brush-and-icons.md) | Scene history review | Next wave |
| [Standalone creative products](decisions/creative-products.md) | First release usability evidence | Further products |
| [Richer email workflows](decisions/email-workflows.md) | Read-only .eml evaluation and installation | Further products |
| [Additional games and GPU worlds](decisions/games-and-gpu.md) | Frame-time profiles before infrastructure | Further products |

The design research also opens bounded questions for [local rule interpretation](decisions/local-rules.md), [semantic observation](decisions/local-observation.md), [creative choice](decisions/local-creative-choice.md), and [useful uncertainty](decisions/useful-uncertainty.md). They depend on completed runtime evidence and do not enlarge this release.

## Not yet specified

Later products need evidence from first-release use before choosing architecture or dates. These are scope markers, not implementation promises.

## Out of scope for this release

Mailbox mutation, autonomous patch application, public claims of general-purpose local-model quality, automatic cloud fallback, and a universal simulation engine.
