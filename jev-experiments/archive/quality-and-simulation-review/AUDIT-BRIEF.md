# Experiment audit contract

Read this brief and audit exactly the assigned experiment, not the whole catalog. Work in the shared checkout at /Users/nikhil/.codex/worktrees/a144/hatch. Do not spawn further agents, commit, edit app files, call paid models, or download large datasets/weights. Your job is a bounded, evidence-based review plus an implementable improvement design.

Inspect the current catalog, the actual React component, runner/model prompts, published JSONL inputs in experience-prototypes/publication.json, and relevant tests. Do not rely on older notes as current facts. Read enough complete records to test the headline against the underlying evidence. Use small scripts when useful to count or reproduce a flaw. Browse primary official documentation for recommended libraries or external benchmarks and include exact source URLs. Be resourceful and concrete. Do not mistake fixture/provider availability for model accuracy. Do not call a tiny authored set an external benchmark. Distinguish current evidence, inference, and proposal.

Priorities: P0 means an immediate data-integrity or unsafe-action defect; P1 blocks a trustworthy claim or central interaction; P2 improves scope, usability, or research depth. Verdict repair preserves the experiment design; redesign changes its decision/state/evaluation design. Keep severity proportional to this developer playground.

Write experiments/<id>.md with:
- Current purpose, what Jev actually decides, what deterministic code does, and what the visitor sees.
- What already works, with source paths and line numbers.
- The most important setup/evaluation/UX flaws, each with severity, concrete evidence, why it matters, and a proposed correction. Aim for 3-6 meaningful findings, not generic advice.
- One richer simulation or interaction, specified as a user journey, state/actions/model boundary, failure behavior, and acceptance criteria.
- A credible evaluation protocol including baselines, independent outcomes, confounds/leakage, number of cases/seeds, uncertainty, and exact success measures. For external benchmarks specify full split size vs current coverage, official scoring, feasibility, blockers, and request volume. Verify official counts online.
- 1-3 useful existing libraries with verified primary URLs, exactly what they would contribute, and where Jev improves the experience. No library laundry list.
- Prioritized next steps, size S/M/L, and any future experiment that reuses the work.
- A short investigation log of reads, calculations and checks performed.

Also write experiments/<id>.json matching this schema:
{
  "id": "assigned-id", "title": "catalog title", "evidenceStatus": "exact short description of current evidence", "verdict": "keep|repair|redesign|research-map", "highestPriority": "P0|P1|P2", "summary": "2-3 concrete sentences", "strengths": ["..."],
  "findings": [{"priority":"P1", "title":"...", "evidence":"path:line and/or measured count", "impact":"...", "fix":"..."}],
  "simulation": {"title":"...", "description":"...", "jevsRole":"...", "codeRole":"...", "acceptanceCriteria":["..."]},
  "evaluation": {"design":"...", "baselines":["..."], "metrics":["..."], "coverage":{"kind":"authored|external|mixed|none", "current":"...", "full":"...", "feasibility":"..."}},
  "libraries": [{"name":"...", "url":"https://...", "use":"..."}],
  "nextSteps": [{"priority":"P1", "size":"S|M|L", "action":"..."}],
  "sources": [{"label":"...", "url":"https://..."}]
}

Use only the specified output paths, never overwrite another experiment's report. You may create small supporting probes under probes/<id>.* if they add evidence. All prose should be plain and precise. Return a concise summary of the biggest finding and output paths when done. Do not claim to have run a browser if you only inspected React source. Review time should go toward actual code/data evidence, not broad unfocused web browsing.
