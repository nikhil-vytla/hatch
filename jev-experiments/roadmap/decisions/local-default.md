# Select an installed local default

- Owner: training/runtime
- Type: research
- Status: Resolved, experimental default verified
- Depends on: Freeze training and export criteria

## Question and resolution

Does a validation-selected model have reproducible export and installation evidence, including task-specific email evaluation and no silent cloud fallback?

Yes. Install `laya-readout-experimental` by default. The predefined seed 17 had validation macro NLL 0.8843, compared with Qwen 1.0972 and Smol 1.5150. Both Core ML compute conditions passed validation parity. Test and transfer metrics did not select the model, recipe, checkpoint or seed.

All three recipes completed three seeds and the predefined exports retain all 17,760 comparison rows. The final fresh toolkit/model directories used the proposed default registry from installation onward, rehashed bytes from the previously tested remote-download cache, verified installed sources and credits, and answered the first authored example correctly with networking blocked and no model argument. The small authored email evaluation remains 7/12 with uncalibrated probabilities; this is not a general-purpose or reliable mail-triage claim.

## Evidence

- [Frozen selection and promotion](../training/default-selection.json)
- [Complete study gate](../training/release-status.json)
- [Fresh default package verification](../mac/default-package-verification.json)
- [Email evaluation](../mac/email-readout-evaluation.json)
