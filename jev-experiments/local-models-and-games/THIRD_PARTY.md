# Attribution

The committed full-text benchmark records derive from LocalLLaMA/typed-decisions, revision ea9306458d6e9563628369a3d1e72e362fb381d2, released under Apache-2.0. The records add our model predictions and reorganize questions for display. Original source: https://huggingface.co/datasets/LocalLLaMA/typed-decisions. A copy of Apache-2.0 is included in APACHE-2.0.txt.

The native MLX implementation follows the published Laya architecture and checkpoint naming. Reference code: NandhaKishorM/laya, revision 42626c348753fbb17572a813127df2278a1ec527, Apache-2.0. Base model: convaiinnovations/laya, revision 1c5edc17a7acd8701df6fc341c0d179f1c62c982. The code here implements the equations in MLX; the upstream repository and model weights are downloaded into the ignored cache for verification and conversion, not redistributed in this commit.

The first-token method was informed by Eric Zhang's openjev-sglang, revision 604664a22b2cf44c6cc499e503092ae4e3c24c03. Full-option likelihood was informed by daseinlabs/open-jev. These implementations and the sgnt.ai article are linked in the report. No copies of their source trees are included.

The open-model identifiers and immutable revisions are in apple/open-models.json. Their upstream license terms govern the weights. This repository stores predictions and original evaluation code, not the model weights. The Core ML export and trained head also remain local because they exceed the investigation's binary size limit.

The app uses Three.js through its package dependency and Bun lockfile. Three.js is MIT-licensed. Existing React, Motion, and other app dependencies retain their respective licenses.
