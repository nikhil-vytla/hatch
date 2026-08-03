# Grade a candidate tree

## Sub-features

- Compare the candidate with a previously captured baseline tree.
- Reject removed files and changes outside the recipe's allowed paths.
- Run counterfactual, regression, and adversarial checks in a temporary copy.
- Emit reward, integrity gate, component evidence, changed paths, and
  violations.

## How to get to it (user POV)

Start with a candidate workspace and the matching recipe. The `--baseline`
directory is a filesystem baseline captured before candidate edits, not a JSON
manifest or git commit name. It must use the same ignored-path policy as the
recipe.

## Driving it with the Parallax CLI

```bash
uv run parallax grade \
  /path/to/recipe.json \
  /path/to/candidate-tree \
  --baseline /path/to/baseline-tree \
  --out /path/to/isolated/grade.json
```

Capture stdout and `grade.json`. Inspect `outcome`, `reward`,
`integrity_gate`, `changed_paths`, each component's check evidence, and
`violations`. A useful proof preserves the action that changed the candidate
as well as the resulting grade.

## Gotchas

The CLI captures the baseline directory when invoked. It cannot reconstruct the
correct pre-edit baseline from the candidate. Recipe checks run arbitrary
trusted commands in temporary materializations, not a security sandbox.
Ignored files do not enter the tree comparison. A forbidden path or hard-gate
failure can reduce reward to zero even when the main behavioral check passes.
