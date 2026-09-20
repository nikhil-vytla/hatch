"""An original SmolLM2 transfer of Kev's shared-prefix decision mechanism.

No Kev source or weights are vendored. Readout/branch-mask design is attributed to
https://github.com/jaredpalmer/kev. This small pilot is not its published training recipe.
"""

import asyncio
import math
import os
import random
import time

import numpy as np

from . import data
from .core import ROOT, choice, collect, save

BASE = "HuggingFaceTB/SmolLM2-360M"


def records(rows, labels, seed):
    rng, result = random.Random(seed), []
    for row in rows:
        candidates = rng.sample([x for x in labels if x != row["target"]], 3) + [row["target"]]
        rng.shuffle(candidates)
        query_label = (
            row["target"]
            if rng.random() < 0.5
            else candidates[(candidates.index(row["target"]) + 1) % 4]
        )
        result.append(
            {
                **row,
                "questions": [
                    {
                        "type": "choice",
                        "instruction": "Which intent is expressed by the customer?",
                        "options": [x.replace("_", " ") for x in candidates],
                        "label": candidates.index(row["target"]),
                    },
                    {
                        "type": "noul",
                        "instruction": f"Is this about {query_label.replace('_', ' ')}?",
                        "options": ["no", "yes"],
                        "label": int(query_label == row["target"]),
                    },
                    {
                        "type": "score",
                        "instruction": f"How directly is this about {query_label.replace('_', ' ')}?",
                        "options": ["not about this", "partly related", "directly about this"],
                        "label": 2 if query_label == row["target"] else 0,
                    },
                ],
                "candidate_labels": candidates,
            }
        )
    return result


def pack(tokenizer, record):
    def tokens(text):
        return tokenizer.encode(text, add_special_tokens=False)

    ids = tokens("Document:\n" + record["text"] + "\n")
    if len(ids) > 160:
        raise ValueError("Document exceeds the pilot's explicit 160-token limit")
    prefix = len(ids)
    segments, positions = [0] * prefix, list(range(prefix))
    anchors, decisions = [], []
    for i, q in enumerate(record["questions"], 1):
        branch = tokens("Question: " + q["instruction"] + "\n")
        ends = []
        for option in q["options"]:
            branch += tokens("Option: " + option + "\n")
            ends.append(len(ids) + len(branch) - 1)
        branch += tokens("Decision:")
        decisions.append(len(ids) + len(branch) - 1)
        anchors.append(ends)
        ids += branch
        segments += [i] * len(branch)
        positions += list(range(prefix, prefix + len(branch)))
    return {
        "ids": ids,
        "segments": segments,
        "positions": positions,
        "anchors": anchors,
        "decisions": decisions,
        "labels": [q["label"] for q in record["questions"]],
    }


def branch_mask(segments, device):
    import torch

    seg = torch.tensor(segments, device=device)
    n = len(segments)
    causal = torch.ones(n, n, device=device, dtype=torch.bool).tril()
    allowed = causal & ((seg[:, None] == seg[None, :]) | (seg[None, :] == 0))
    mask = torch.zeros(n, n, device=device).masked_fill(~allowed, torch.finfo(torch.float32).min)
    return mask[None, None]


def build_model(revision, device):
    """Construct the same trainable architecture for training and saved inference."""
    import torch
    from peft import LoraConfig, get_peft_model
    from torch import nn
    from transformers import AutoModel

    class DecisionModel(nn.Module):
        def __init__(self):
            super().__init__()
            backbone = AutoModel.from_pretrained(
                BASE, revision=revision, dtype=torch.float32, attn_implementation="eager"
            )
            backbone.requires_grad_(False)
            self.backbone = get_peft_model(
                backbone,
                LoraConfig(
                    task_type="FEATURE_EXTRACTION",
                    r=4,
                    lora_alpha=8,
                    lora_dropout=0,
                    target_modules=r"layers\.(24|25|26|27|28|29|30|31)\.self_attn\.(q_proj|v_proj)",
                ),
            )
            dim = backbone.config.hidden_size
            self.query = nn.Linear(dim, 64, bias=False)
            self.option = nn.Linear(dim, 64, bias=False)
            self.to(device)

        def forward(self, enc):
            ids = torch.tensor([enc["ids"]], device=device)
            pos = torch.tensor([enc["positions"]], device=device)
            hidden = self.backbone(
                input_ids=ids,
                position_ids=pos,
                attention_mask=branch_mask(enc["segments"], device),
                use_cache=False,
            ).last_hidden_state[0]
            return [
                self.option(hidden[torch.tensor(options, device=device)])
                @ self.query(hidden[decision])
                / math.sqrt(64)
                for decision, options in zip(enc["decisions"], enc["anchors"])
            ]

    return DecisionModel()


def train_local(run, quick):
    os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    import torch
    from huggingface_hub import model_info
    from torch import nn
    from transformers import AutoTokenizer

    torch.manual_seed(42)
    torch.set_num_threads(4)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    revision = model_info(BASE).sha
    print(f"Replica: loading {BASE} at {revision}, device={device}", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(BASE, revision=revision)
    train_rows, labels = data.banking("train")
    train_rows, val_rows = data.train_validation(train_rows)
    test_rows, _ = data.banking("test")
    train_records = records(data.balanced(train_rows, 2 if quick else 4), labels, 1)
    val_records = records(data.balanced(val_rows, 1)[: 20 if quick else 40], labels, 2)
    test_records = records(data.balanced(test_rows, 1)[: 20 if quick else 77], labels, 3)
    encoded = [pack(tokenizer, r) for r in train_records]

    model = build_model(revision, device)
    parameter_count = sum(p.numel() for p in model.parameters() if p.requires_grad)

    def evaluate(recs):
        model.eval()
        rows = []
        with torch.no_grad():
            for record in recs:
                start = time.perf_counter()
                logits = model(pack(tokenizer, record))
                probabilities = [torch.softmax(z, -1).cpu().tolist() for z in logits]
                rows.append(
                    {
                        "id": record["id"],
                        "targets": [q["label"] for q in record["questions"]],
                        "probabilities": probabilities,
                        "latency_ms": (time.perf_counter() - start) * 1000,
                    }
                )
        return rows

    before = evaluate(test_records)
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4)
    steps = 40 if quick else 240
    rng, curve = random.Random(42), []
    best_val, best_state = -1, None
    started = time.perf_counter()
    for step in range(steps):
        model.train()
        enc = rng.choice(encoded)
        optimizer.zero_grad(set_to_none=True)
        logits = model(enc)
        loss = sum(
            nn.functional.cross_entropy(z[None], torch.tensor([label], device=device))
            for z, label in zip(logits, enc["labels"])
        ) / len(logits)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        if step % 10 == 0:
            curve.append(
                {
                    "step": step + 1,
                    "loss": float(loss.detach().cpu()),
                    "elapsed_s": time.perf_counter() - started,
                }
            )
            print(f"Replica step {step + 1}/{steps}: loss={curve[-1]['loss']:.4f}", flush=True)
            run.checkpoint(
                {
                    "base": BASE,
                    "revision": revision,
                    "device": device,
                    "curve": curve,
                    "completed_training_steps": step + 1,
                    "requested_training_steps": steps,
                }
            )
        if (step + 1) % (20 if quick else 60) == 0:
            val = evaluate(val_records)
            accuracy = np.mean(
                [int(np.argmax(r["probabilities"][0])) == r["targets"][0] for r in val]
            )
            if accuracy > best_val:
                best_val = float(accuracy)
                best_state = {
                    n: p.detach().cpu().clone()
                    for n, p in model.named_parameters()
                    if p.requires_grad
                }
    if best_state is not None:
        with torch.no_grad():
            for name, parameter in model.named_parameters():
                if name in best_state:
                    parameter.copy_(best_state[name].to(device))
        torch.save(best_state, run.path / "adapter-and-head.pt")
    after = evaluate(test_records)
    record = test_records[0]
    model.eval()
    with torch.no_grad():
        together = model(pack(tokenizer, record))
        differences = []
        for index, question in enumerate(record["questions"]):
            alone = model(pack(tokenizer, {**record, "questions": [question]}))[0]
            differences.append(
                float(
                    (torch.softmax(together[index], -1) - torch.softmax(alone, -1))
                    .abs()
                    .max()
                    .cpu()
                )
            )

    def summarize(rows):
        return {
            kind: {
                "accuracy": float(
                    np.mean(
                        [int(np.argmax(r["probabilities"][i])) == r["targets"][i] for r in rows]
                    )
                ),
                "brier": float(
                    np.mean(
                        [
                            sum(
                                (p - float(j == r["targets"][i])) ** 2
                                for j, p in enumerate(r["probabilities"][i])
                            )
                            for r in rows
                        ]
                    )
                ),
            }
            for i, kind in enumerate(("choice", "noul", "score"))
        }

    return {
        "base": BASE,
        "revision": revision,
        "device": device,
        "trainable_parameters": parameter_count,
        "training_steps": steps,
        "training_seconds": time.perf_counter() - started,
        "before": summarize(before),
        "after": summarize(after),
        "best_validation_choice_accuracy": best_val,
        "packed_separate_max_probability_difference": max(differences),
        "curve": curve,
        "before_rows": before,
        "after_rows": after,
        "test_records": test_records,
        "sources": data.source_manifest(),
        "limitations": [
            "Small architecture-transfer pilot; not Kev's full recipe or results.",
            "Four-way choices have supplied distractors, unlike the 77-way classification benchmark.",
            "Score labels cover endpoints only; intermediate rubric calibration is untested.",
            "No additional Jev labels were used to train this replica.",
        ],
    }


async def replica(client, quick=False):
    result = await asyncio.to_thread(train_local, client.run, quick)
    client.run.checkpoint(result)

    async def one(record):
        options = {str(i): x for i, x in enumerate(record["questions"][0]["options"])}
        out = await client.evaluate(
            record["text"],
            {"intent": choice(record["questions"][0]["instruction"], options)},
            "replica-reference/" + record["id"],
        )
        return {
            "id": record["id"],
            "target": record["questions"][0]["label"],
            "prediction": int(out["answers"]["intent"]["value"]),
            "latency_ms": out["latency_ms"],
        }

    references = await collect(result.pop("test_records"), one)
    result["jev_reference"] = {
        "rows": references,
        "accuracy_all_attempted": sum(
            r.get("prediction") == r.get("target", -1) for r in references
        )
        / len(references),
    }
    save(client.run.path / "training-summary.json", result)
    return result
