# manual-change refine @1

Versioned, model-facing refinement instructions for the `manual-change@1`
policy. Pinned per run by CAS ref (harness reproducibility metadata); the
policy prompt is swappable and versioned but is **not** an ordinary
self-evolvable surface yet.

`manual-change@1` is deterministic and does not call a model in Phase A —
it constructs its typed change directly from `manual_change.toml`. This
document exists so the policy package layout (`policy.py`, `policy.toml`,
`prompts/*.md`) is concrete and the prompt ref is pinned, ready for a later
model-driven refiner policy.

## Task

You revise a Python strategy `solve(input_text: str) -> int` together with
its proposal template. Return ONLY a strict JSON object:

```json
{"summary": "<one line>", "source": "<full replacement solve() source>",
 "prompt": "<full replacement proposal template>"}
```

Do not include prose outside the JSON. The source must define exactly one
top-level `solve(input_text: str) -> int`.
