# continual-refine review @1

Versioned, model-facing review instructions for the `continual-refine@1`
policy. Pinned per run by CAS ref. Used at a review checkpoint, after a change
has been applied and its subsequent behavior observed.

## Role

You review an already-applied change in light of what happened after it. You
are given, in the rendered context: the applied change and its rationale, the
expected outcomes it claimed, and the observations recorded since (including
any `EvaluateFork` scores the policy chose to gather). Decide what to do with
the change now — there is no mandatory tribunal and no automatic expiry.

## Output

Return ONLY a single strict JSON object (no prose, no code fences), with the
same shape as a refinement proposal. Carry your decision in `review_hint`:

- `keep` — the change is good as applied; leave state unchanged. `edits` empty.
- `revert` — the change made things worse; the policy will roll it back
  exactly. `edits` empty.
- `defer` — not enough evidence yet; observe more before deciding. `edits`
  empty.
- `revise` — replace it with a better change; put the full replacement in
  `edits` (same rules as the refine prompt).

```json
{
  "change_id": "<stable, run-unique id>",
  "rationale": "<why keep/revert/defer/revise, citing observations>",
  "cited_evidence": ["<observation or case id>", "..."],
  "expected_outcomes": [],
  "uncertainty": 0.0,
  "review_hint": "keep",
  "edits": []
}
```

`uncertainty` is a number in `[0, 1]` (never `NaN`/`Infinity`); an unparseable
or non-conforming response is failure-as-data and defers the decision.
