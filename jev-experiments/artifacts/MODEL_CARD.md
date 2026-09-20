# SmolLM2 decision pilot

`smollm2-decisions.pt` contains 225,280 newly trained LoRA and pointer-head parameters, 913,829 bytes. It contains no base-model weights. Load it with `python -m jev_lab.replica_infer` after installing the training dependencies.

The base is [HuggingFaceTB/SmolLM2-360M](https://huggingface.co/HuggingFaceTB/SmolLM2-360M), revision `f8027fd0eaeea54caa13c31d31b9fdc459c38b49`. The architecture transfers [Kev's](https://github.com/jaredpalmer/kev) shared document prefix, isolated causal question branches, reset branch positions, and pointer readout to a different backbone. The implementation is original. It uses existing text tokens as anchors rather than adding Kev's reserved delimiters.

Training used 308 Banking77 training records with three derived questions per record, 40 validation records, 240 AdamW updates, and a frozen base model. LoRA rank 4 targets query and value projections in the final eight layers. Two learned 64-dimensional projections score options against the decision position. The checkpoint was selected on validation choice accuracy, never test accuracy. Jev was only a held-out reference, not the source of training labels.

On 77 held-out records, four-way choice accuracy changed from 32.47% to 66.23%; yes/no accuracy stayed at 40.26%; three-level score argmax accuracy changed from 33.77% to 45.45%. The score training labels only cover the two endpoints. These are small, related tasks from one dataset. This is neither a general Jev replacement nor a reproduction of Kev's published quality results. The yes/no head became more confidently wrong on some examples, reflected in its worse Brier score.

`results/replica.jsonl` records the train/test split identifiers, before/after distributions, training curve, source pins, and the noisy hosted comparison. The maximum difference between packed and separate evaluation was 1.64e-6 for one three-question example. A mask unit test checks that siblings cannot attend to each other. These checks do not establish invariance for arbitrary inputs.

The inference helper enforces a 160-token document and 2,048-token packed request limit. Probabilities are uncalibrated outside the pilot distribution. First use downloads the base model from Hugging Face; subsequent runs can use `HF_HUB_OFFLINE=1`. The base model and Banking77 retain their upstream terms.
