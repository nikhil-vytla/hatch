# Build and replay a GSM8K family

## Sub-features

- Load one pinned GSM8K source record and one frozen proposal.
- Build static, turn-matched, and evolved conversation arms.
- Run current family admission checks.
- Publish content-addressed public and sealed arm artifacts.
- Generate a family lock and replay it to byte-identical artifacts.

## How to get to it (user POV)

Use `tests/fixtures/synthesis_kernel/experiment.toml` only as an input template.
Copy its three files to isolated scratch because the first build writes
`family.lock` beside the experiment file.

## Driving it with the Parallax CLI

```bash
.cursor/skills/verify-parallax/prove-family-build.sh unit0-family-build
```

The helper runs the two real user commands:

```bash
uv run parallax build <copied-experiment.toml> --store <first-store>
uv run parallax build --locked <generated-family.lock> --store <replay-store>
```

Proof is a shared family ID and arm IDs, identical relative file sets and bytes,
passing admission checks in `family.json`, and complete matching SHA-256 lists
for both artifact trees. The receipt also binds base HEAD, relevant git status,
the tracked-diff digest, and a deterministic manifest of exact current inputs,
including untracked source files and the copied config.

## Gotchas

The checked-in proposal is hand-authored frozen input. Its prompt and response
digests are placeholder-shaped strings, and its `school_supply_sales` context
does not match the Natalia's clips source task. This path proves current family
build and locked replay only. It does not prove proposal provenance integrity,
semantic validity, Microsoft Evolving Intent generation, extraction,
counterfactuals, predecessor escalation, scheduler parity, rendering parity,
domain assets, or paper results. Public and sealed artifacts both appear in
local evidence. Keep that evidence local.
