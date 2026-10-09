# hatch 🥚

Little agent-driven vibe-coded experiments. Inspired by simonw's [very fun blog on async code research (Nov 2025)](https://simonwillison.net/2025/Nov/6/async-code-research/).

For these experiments, all I hope is that I get to learn something new! I have a feeling I'd also love to eventually graduate some of these, perhaps to more polished [agent skills](https://www.claude.com/blog/skills), custom tools/[MCP servers](https://modelcontextprotocol.io/docs/getting-started/intro), or (slightly) more formal research!

## Experiments

<!-- index:start -->
7 experiments, newest first.

### [Growing software by talking to it, and how to verify it](chat-grown-software/) (2026-10-08)

Geoffrey Huntley's [Jiti](https://github.com/ghuntley/jiti) grows an application by chatting with a live Common Lisp image. Here the idea is rebuilt in TypeScript on a `node:vm` realm, with a focus on verification. The model proposes code and example calls but never the expected answers: the kernel shows the user what each call actually returns and does to the state, asks its own boundary, repetition and coverage questions, and only the user's answers become the contract. With contracts built that way, seven verification layers caught 100% of 238 behavior-changing slips in an expense tracker and 96% of 224 in a held-out shop scenario. They also caught 30 of 37 hand-written misunderstandings, against 10 when the model graded itself. A follow-up in `languages/` rebuilt the kernel in Clojure, Elixir, Pharo Smalltalk, Racket and Lean 4 and had [DeepSeek](https://api-docs.deepseek.com/) grow two apps in each, 3 runs per language, scored by hidden checks.

### [Exhausting the design space for an RL rollout data layer](rl-env-filesystem/) (2026-08-03)

Underneath every RL environment platform sits the same data problem: sandboxes cold-start by pulling full container images, and nothing about a rollout's state survives grading. This exploration maps that design space across seven axes (interface, capture granularity, addressing, materialization, cache topology, deployment, sharing semantics), prunes 14,400 nominal combinations with constraints derived from seven jobs, and lands on a checkpoint-native rollout store: lazy delivery of unmodified images, copy-on-write diff capture at stage boundaries, branchable snapshot trees, and object storage as source of truth. A prototype grounds the delivery half with no container runtime or paid platform, pulling an OCI image straight from the registry API and tracing five stand-in agent tasks under strace; it replicates the [Slacker (USENIX FAST '16)](https://www.usenix.org/conference/fast16/technical-sessions/presentation/harter) result on an environment-shaped image (tasks touch 0.3-17% of files, 5-39% of bytes) and echoes [REAP's](https://doi.org/10.1145/3445814.3446714) stable-working-set finding at file granularity. A benchmark platform then turns the axes into runnable experiments: overlayfs sandboxes, pluggable delivery policies, checkpoint capture at 9-66 ms per rollout, and decoupled re-grading that reproduces every live reward from the checkpoint alone.

### [Parallax](parallax/) (2026-08-02)

Parallax implements and tests offline [Evolving Intent](https://arxiv.org/abs/2607.20734v1) paths for GSM8K and SWE-bench Verified using strict frozen Pydantic models, sealed verifiers, canonical evidence, and source-clustered reporting. The SWE path pins the paper's published source IDs, validates provider and dataset boundaries, applies the characterized symptom overlay, gives every arm one equal episode budget, and renders digest-pinned official HUD environments. A preregistered screening harness preserves the Verification/RunFailure split, estimates spend before execution, and refuses unapproved or over-$20 plans. The implementation follows the semantics of the immutable [Microsoft reference revision](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a) without claiming a real-provider call, paid episode, provider-text parity, generated-pool reproduction, or paper-score reproduction.

### [Working with Claude Fable 5: distilled tips](claude-fable-5-tips/) (2026-07-03)

Working with Claude Fable 5 turns out to require two distinct shifts, drawn from two Anthropic-adjacent sources plus the official docs. Thariq Shihipar's essay argues that output quality is now bottlenecked less by the model and more by how well a user surfaces their own "unknowns" — gaps between the prompt (the map) and the actual codebase (the territory) — via techniques like blind spot passes, brainstorms, interviews, and post-hoc quizzes. Simon Willison's post and Anthropic's official [prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) make a separate point: Fable is capable enough that older, prescriptive prompting habits (enumerated rules, tight checkpoints, treating it like autocomplete) now hold it back, and the fix is judgement and intent over rules, delegation of mechanical work to cheaper subagents, and explicitly grounding self-reported progress in tool evidence. Three reusable artifacts came out of this: a drop-in AGENTS.md addendum, a skill implementing the fresh-context verifier-subagent pattern, and a skill implementing the unknowns-discovery technique catalog.

### [Markov Chain Simulator](markov-chain-sim/) (2025-12-04)

A small, self-contained Markov chain simulator for watching state transitions play out and seeing the memoryless property in action: the next state depends only on the current one. It is a lightweight single-page tool, [markov.html](markov.html), so it needs no build step or dependencies. The README is brief and gives no results, parameters, or usage notes, so what the simulator can do beyond visualizing transitions is not documented. For background on the underlying idea, see the [Markov chain article on Wikipedia](https://en.wikipedia.org/wiki/Markov_chain).

### [Multi-Turn Eval System (standardization for agents)](meta-agent-eval-system/) (2025-11-21)

A demo of a multi-turn evaluation pipeline and an incident-to-eval taxonomy for customer support AI agents, built as a Streamlit app. It includes a support chatbot with two tools (refund policy lookup and booking status check), LLM judges that score multi-turn conversations from CSV data, and a taxonomy explorer that maps real incidents (the Air Canada chatbot case) to eval categories and methodologies. Without an OpenAI key the agent and judges run in mock mode, so the whole flow works end to end. The design draws on [Snowglobe](https://snowglobe.so/) for chatbot simulation and [Verifiers](https://github.com/PrimeIntellect-ai/verifiers) for RL environments and agent evals.

### [llabel - Lightweight Labeling Widgets](lightweight-labeling-tool/) (2025-11-08)

This lightweight labeling toolkit brings anywidget-based annotation to Jupyter notebooks with a clean, extensible architecture inspired by molabel. The implementation includes fully-functional text and image widgets (supporting binary classification and bbox/point/polygon annotations), complete with interactive JavaScript frontends, comprehensive documentation, and demo notebooks. Built on minimal dependencies (anywidget + traitlets), the codebase features thoughtfully designed extension points for video (with SAM integration hooks) and PDF labeling, making it straightforward to add new media types. Explore the package at https://github.com/koaning/molabel and https://anywidget.dev for the foundational libraries.

## Graduated

These moved to their own repositories.

- [Jev experiments](jev-experiments/) (2026-09-19): Jev has moved to its own repository: [nikhil-vytla/jev-experiments](https://github.com/nikhil-vytla/jev-experiments) (public). The live site is [jev-experiments.vercel.app](https://jev-experiments.vercel.app).
- [Windtunnel](windtunnel/) (2026-07-07): Windtunnel has moved to its own repository: [nikhil-vytla/windtunnel](https://github.com/nikhil-vytla/windtunnel) (private).
<!-- index:end -->
