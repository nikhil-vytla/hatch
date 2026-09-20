"""Full-text packing. No state, instruction, or criterion truncation."""

import json
import hashlib
from pathlib import Path
import numpy as np
from transformers import PreTrainedTokenizerFast
from prepare import CACHE

QTYPES = {"choice": 0, "score": 1, "noul": 2}
MAX_LEN = 768
MAX_OPTIONS = 8


def tokenizer():
    return PreTrainedTokenizerFast(
        tokenizer_file=str(CACHE / "base/tokenizer/tokenizer.json"),
        cls_token="[CLS]",
        sep_token="[SEP]",
        pad_token="[PAD]",
        mask_token="[MASK]",
    )


def pack(tok, state, q):
    def tokens(s):
        return tok.encode(s.replace(tok.mask_token, " "), add_special_tokens=False)

    t = q["type"]
    crit = q.get("criteria", {})
    if t == "choice":
        options = [f"{k}: {v}" for k, v in crit.items()]
        keys = list(crit)
    elif t == "score":
        options = [f"level {i}: {v}" for i, v in enumerate(crit)]
        keys = [str(i) for i in range(len(crit))]
    else:
        options = [
            "false: " + crit.get("false", "no, the statement does not hold"),
            "true: " + crit.get("true", "yes, the statement holds"),
        ]
        keys = ["false", "true"]
    ids = [tok.cls_token_id] + tokens(t + " question: " + q["instructions"]) + [tok.sep_token_id]
    markers = []
    for option in options:
        markers.append(len(ids))
        ids += [tok.mask_token_id] + tokens(" " + option)
    ids += (
        [tok.sep_token_id]
        + tokens(state if isinstance(state, str) else json.dumps(state, ensure_ascii=False))
        + [tok.sep_token_id]
    )
    if len(ids) > MAX_LEN or len(options) > MAX_OPTIONS:
        raise ValueError(
            f"Input exceeds explicit limits: {len(ids)} tokens, {len(options)} options"
        )
    return {"ids": ids, "markers": markers, "qtype": QTYPES[t], "keys": keys}


def examples(split):
    tok = tokenizer()
    out = []
    for row in json.loads((CACHE / f"{split}.json").read_text()):
        state = json.loads(row["state"])
        qs = json.loads(row["questions"])
        gold = json.loads(row["gold"])
        for key, q in qs.items():
            ex = pack(tok, state, q)
            ex.update(
                id=row["id"], workflow=row["workflow"], question_key=key, state=state, question=q
            )
            target = np.array([gold[key]["probabilities"][k] for k in ex["keys"]], dtype=np.float32)
            target /= target.sum()
            ex["target"] = target.tolist()
            out.append(ex)
    return out


def collate(items, fixed=False):
    b = len(items)
    n = MAX_LEN if fixed else max(len(x["ids"]) for x in items)
    k = MAX_OPTIONS if fixed else max(len(x["markers"]) for x in items)
    ids = np.full((b, n), 50283, np.int32)
    pad = np.zeros((b, n), np.int32)
    markers = np.zeros((b, k), np.int32)
    valid = np.zeros((b, k), bool)
    qtype = np.array([x["qtype"] for x in items], np.int32)
    targets = np.zeros((b, k), np.float32)
    for i, x in enumerate(items):
        ids[i, : len(x["ids"])] = x["ids"]
        pad[i, : len(x["ids"])] = 1
        markers[i, : len(x["markers"])] = x["markers"]
        valid[i, : len(x["markers"])] = True
        if "target" in x:
            targets[i, : len(x["target"])] = x["target"]
    return ids, pad, markers, valid, qtype, targets
