---
name: jev-route-task
description: Delegate a bounded coding subtask through a configured Jev route_task MCP tool, then review and use the returned answer, structured result or proposed patch. Use when a caller requests model routing or delegated bug fixes, test writing or repository analysis.
---

Find the configured Jev `route_task` MCP tool. Read the relevant source with the host's normal tools and pass a concrete task plus complete relevant context. The delegate cannot inspect the repository or run tools. Give it a stable task id and an explicit output allowance, usually 2048 tokens for a small task.

Keep the task on one selected destination. The result separates classification, selection, attempts and outcome. Inspect status and the returned artifact. Apply a suitable proposed patch with the host's normal file permissions, then run independent task tests. A returned patch is a proposal, not proof that a bug is fixed.

If no route meets the required capabilities, permissions or spending cap, preserve those restrictions and report the explanation. Do not retry by dropping required tools or switching a local-only request to cloud. Availability fallback and quality escalation are separate configured policies.

A malformed or cancelled response is unusable. Do not apply partial or stale artifacts. Unknown cost is unknown; quality, latency and cache simulations are labeled and do not establish savings.

`decide` accepts the version 1 typed decision contract. Its default adapter is a state-blind uniform prior. `classify_eml` accepts explicitly supplied raw text/plain email and uses a labeled lexical baseline; it does not modify a mailbox. Never describe either default as a trained model.
