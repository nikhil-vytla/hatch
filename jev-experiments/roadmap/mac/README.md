# Local Mac typed decisions

This source uses version 2 of the [typed decision contract](../runtime/README.md). Existing model installation, export and evaluation records below retain their original version 1 source identities. They do not verify the changed runtime. The [current provider-free checks](../../typed-runtime-2026-09-22/README.md) verify wire semantics, unsupported-input rejection and Python/TypeScript agreement using authored distributions. They do not run MLX, install weights or establish email usefulness.

`selected` remains a modal option. Boolean responses separately return `probabilityTrue`, and ordinal responses return `expected`. This model accepts string prompts and string choice descriptions only. Structured entries, boolean criteria and descriptive ordinal levels are unsupported and rejected before loading weights. Version 1 requests and unknown fields return errors. An explicit choice description replaces its display label even when empty.

The following installation and study narrative is retained historical context. The default model registry is unchanged in this source slice. Email remains experimental; historical successful installation is not a reliable email-triage result.

This experimental toolkit reads explicit JSON or `.eml` files and runs a pinned Laya backbone with a small typed readout on Apple Silicon with MLX. The installed default was selected using validation data from the completed study and passed a fresh offline installation check. It does not access a mailbox. Inference requires installed local files and never falls back to a hosted model. The 12-message authored email check scored 7/12; its probabilities are uncalibrated for email, so the example is not a reliable email triage product.

From a checkout of this repository, install the toolkit with one command:

```sh
bash jev-experiments/roadmap/mac/install.sh
```

The installer creates `~/Library/Application Support/Jev/toolkit`, with its own Python environment and a `bin/jev-local` launcher. It uses `uv` if available, otherwise Python's `venv` and `pip`. Python 3.13 and Apple Silicon macOS are the tested prerequisites. No training packages, datasets, PyTorch or Core ML conversion tools are installed.

Install the validation-selected experimental default, then get a first result:

```sh
JEV="$HOME/Library/Application Support/Jev/toolkit/bin/jev-local"
"$JEV" install-model
"$JEV" doctor
"$JEV" decide jev-experiments/roadmap/mac/examples/decision.json
```

The authored example contains three apples and two bananas. The fresh installed default correctly returned `true` for `has-apples` and `apple` for `most-common`, with networking blocked. This first-action check verifies usable installation; it does not estimate general task accuracy. The [package record](default-package-verification.json) retains the full response, diagnostic result and installed-file hashes.

Model installation downloads about 846 MB and adds the bundled 12 KB readout. `models.json` pins the Hugging Face revision, byte counts and SHA-256 values for every installed model file. Downloads go to temporary files and are promoted only after checksum verification. For an existing verified model directory, use `install-model --from-directory /path/to/laya-readout-experimental`; it copies bytes and performs the same checks. The application checks all model hashes when loading. [Validation selection](../training/default-selection.json) chose `laya-readout-experimental` after all three study candidates completed training and full-graph export checks; final test scores did not select it.

`decide` accepts the shared [typed decision contract](../runtime/contract.ts). It returns value-keyed probabilities, the actual model/revision/runtime, timing and explicit unsupported/error states. Limits are 32 questions, eight options, 768 tokens per question, 64 KiB serialized state and 128 KiB requests. Oversized input is rejected without truncation. Every question runs independently; choices, boolean values and ordinal levels preserve their identities.

`classify-eml` requires a path to an existing `.eml` file of at most 1 MiB. MIME headers and plain-text transfer encodings are decoded; HTML-only bodies are rejected. Attachments are not executed or interpreted. Output contains purpose labels, maximum probability, normalized entropy and an input SHA-256. Source files remain unchanged. The labels are `action_required`, `transactional`, `newsletter`, `personal` and `uncertain`; model uncertainty is not a guarantee that the selected label is correct.

Run the email example with:

```sh
"$JEV" classify-eml jev-experiments/roadmap/mac/examples/meeting.eml
```

The earlier base-model installation check labeled this meeting message personal instead of action-required. Both variants made mistakes on the separate authored email evaluation. Inspect the full distributions and evaluation before relying on a label.

Run the checks:

```sh
python3 -m unittest discover -s jev-experiments/roadmap/mac -p 'test_*.py'
"$HOME/Library/Application Support/Jev/toolkit/venv/bin/python" jev-experiments/roadmap/mac/evaluate_email.py
```

[Email evaluation](email-evaluation.json) records all 12 predictions, frozen fixture hash, 58.3% accuracy and 100% coverage. Socket connections were forbidden during the full inference run and the evaluator verified every source file remained byte-identical. These authored messages test installation and behavior; they do not measure representative mailbox quality.

To uninstall the toolkit while retaining downloaded models:

```sh
python3 jev-experiments/roadmap/mac/uninstall.py
```

To also remove the known model directory, add `--models "$HOME/Library/Application Support/Jev/models"`. The uninstall command rejects unmarked toolkit directories and model directories containing unknown files. Custom installation paths use `install.sh --prefix PATH`, `uninstall.py --prefix PATH`, and inference/model commands accept `--data PATH` or `JEV_LOCAL_DATA`.

The toolkit imports the repository's original [MLX Laya equations](../../local-models-and-games/apple/mlx_model.py). [CREDITS.md](CREDITS.md) travels with every installation and identifies the model authors, pinned revision, licenses and runtime provenance. Model metadata is also recorded in [models.json](models.json); the training study's [provenance table](../training/PROVENANCE.md) separates unknown backbone exposure from the new adaptation splits.

The published base model remains available as an explicit alternative:

```sh
"$JEV" install-model --model laya-base-experimental
"$JEV" decide --model laya-base-experimental jev-experiments/roadmap/mac/examples/decision.json
```

The default readout uses predefined seed17 and validation-selected temperature 1.3; the backbone stays frozen. A fresh remote model download/install passed, and an installed runtime matched 15 saved validation decisions across all three question kinds within 1.05e-7 probability error with networking blocked. Both the base and adapted variants scored 7/12 on the authored email smoke set. See [runtime parity](readout-runtime-verification.json), [readout email results](email-readout-evaluation.json), [earlier installation evidence](installation-evidence.json) and the [final default package check](default-package-verification.json). The new readout is separate from the earlier workflow specialist and remains labeled experimental after promotion.
