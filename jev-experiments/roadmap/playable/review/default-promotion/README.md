# Independent default-package boundary review

Two consequential gaps were fixed and independently rechecked without running a model or promoting a real package.

| Finding | Exact source boundary | Resolution and check |
| --- | --- | --- |
| A promoted default made fresh toolkit installation fail before model installation. The final `doctor` command inherited the registry default and required model bytes that were not installed yet. Verification previously substituted the proposed registry after installation. | [Installer](../../../mac/install.sh), [CLI defaults/doctor](../../../mac/jev_local.py:291), [package verifier](../../../mac/verify_default_package.py) | Installer uses `doctor --runtime-only`; verifier supplies the proposed registry through `--model-registry` from the start. CPU probe returns0 for the new command and2 for the original command against an empty model directory. |
| A changed MLX helper could invalidate a fresh-package check without changing the only pinned source file, `jev_local.py`. | [Promotion](../../../training/promote_default.py), [source manifest](../../../mac/package_sources.py) | Verification records all shipped/executed source hashes and checks installed copies. Promotion/audit recheck the manifest. An unchanged temporary fixture passes; changing only its MLX helper prevents promotion and preserves a null default. |

Verification, promotion and final audit also derive the selection again from current evidence. The ranking still uses the predefined seed17 validation result and declared latency tie-break, while held-out results remain outside selection. Source model defaults remain null at this review's completion. Fresh installation/inference and actual promotion belong to the training owner's gated execution and were not performed by this review.

The [probe code](probes.py) and [retained output](probe-results-after.json) state their limits. Runtime dependency imports are stubbed only for the doctor check. The source-integrity fixture stubs research readiness and validation derivation, then exercises the actual promotion function against synthetic temporary files. It never writes production evidence or registries.

```sh
python3 jev-experiments/roadmap/playable/review/default-promotion/probes.py probe-results-after.json
```

See [notes](NOTES.md) for the review sequence and owner dispositions.
