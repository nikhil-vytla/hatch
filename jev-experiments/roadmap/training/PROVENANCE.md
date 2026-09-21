# Backbone exposure and attribution

The new readout corpus has frozen train/validation/test IDs and content hashes. That separation does not establish that a published backbone has never seen a public benchmark.

| Backbone | BANKING77 | BoolQ | STS-B | CLINC | MultiRC | SummEval | Typed Decisions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Laya, pinned model revision `1c5edc1` | Unknown upstream exposure | Upstream repository documents BoolQ in its training mix; exact pinned-weight split is unverified | Unknown | Unknown | Unknown | Unknown | Base card distinguishes zero-shot base from separate workflow specialist; exact test exposure is not independently established |
| SmolLM2-360M-Instruct, `a10cc15` | Unknown public-data pretraining exposure | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |
| MLX Qwen3-0.6B-4bit, `73e3e38` | Unknown public-data pretraining exposure | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |

The checked-out [Laya repository](https://github.com/NandhaKishorM/laya/tree/42626c348753fbb17572a813127df2278a1ec527) explicitly marks BoolQ as in its training mix. The pinned [base model card](https://huggingface.co/convaiinnovations/laya/tree/1c5edc17a7acd8701df6fc341c0d179f1c62c982) distinguishes its base checkpoint from a separate Typed Decisions specialist. Those statements warrant a task-exposure disclosure. They do not by themselves prove that this checkpoint consumed any particular held-out test row.

Laya model authorship is credited to Nandakishor M and Convai Innovations. Wojciech Dobry's playground is a separate interface project. The existing repository's original MLX port supplies Laya inference equations; the new scripts import it without copying the upstream repository. SmolLM2 and Qwen backbones retain their upstream licenses and revision identities. All frozen embedding baselines mean-pool their own input embedding tables; none is advertised as a dedicated sentence-embedding model.
