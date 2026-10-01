"""Trains the student networks on the open teacher's answers (never on Jev's).

    train.py DATASET_DIR OUT_DIR

Each net is one hidden ReLU layer and a head per question. Choice heads fit the teacher's soft
distribution (cross-entropy, masked to the options the game offered); yes/no heads fit the
teacher's probability (binary cross-entropy). Early stopping uses held-out templates.
"""

import base64, json, sys
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np

SIZES = {"line": 64, "reaction": 64, "profile": 64}


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.float32).tobytes()).decode()


class Net(nn.Module):
    def __init__(self, n_in, hidden, heads):
        super().__init__()
        self.hidden = nn.Linear(n_in, hidden)
        self.drop = nn.Dropout(0.2)
        self.names = list(heads)
        self.outs = [nn.Linear(hidden, 1 if h["kind"] == "sigmoid" else len(h["labels"])) for h in heads.values()]

    def __call__(self, x):
        h = self.drop(nn.relu(self.hidden(x)))
        return [o(h) for o in self.outs]


def load(d, name):
    meta = json.load(open(d / f"{name}.json"))
    rows = meta["rows"]
    x = np.fromfile(d / f"{name}.x.f32", dtype=np.float32).reshape(rows, meta["x"])
    y = np.fromfile(d / f"{name}.y.f32", dtype=np.float32).reshape(rows, meta["y"])
    m = np.fromfile(d / f"{name}.m.f32", dtype=np.float32).reshape(rows, meta["m"]) if meta["m"] else None
    val = np.array(meta["split"], dtype=bool)
    return meta, x, y, m, val


def losses(net, heads, x, y, m):
    outs = net(x)
    total, parts = 0.0, {}
    for (name, h), z in zip(heads.items(), outs):
        if h["kind"] == "sigmoid":
            t = y[:, h["from"] : h["from"] + 1]
            l = nn.losses.binary_cross_entropy(z, t, with_logits=True, reduction="mean")
        else:
            n = len(h["labels"])
            t = y[:, h["from"] : h["from"] + n]
            if m is not None:
                z = mx.where(m > 0, z, -1e9)
            t = t / mx.maximum(mx.sum(t, axis=1, keepdims=True), 1e-6)
            l = -mx.mean(mx.sum(t * nn.log_softmax(z, axis=1), axis=1))
        parts[name] = l
        total = total + l
    return total, parts


def agreement(net, heads, x, y, m):
    """Share of rows where the student's top choice is the teacher's (choice heads), or where
    both fall on the same side of 0.5 (yes/no heads)."""
    net.eval()
    outs = net(mx.array(x))
    res = {}
    for (name, h), z in zip(heads.items(), outs):
        z = np.array(z)
        if h["kind"] == "sigmoid":
            t = y[:, h["from"]]
            res[name] = float(np.mean((z[:, 0] > 0) == (t > 0.5)))
        else:
            n = len(h["labels"])
            t = y[:, h["from"] : h["from"] + n]
            if m is not None:
                z = np.where(m > 0, z, -1e9)
            res[name] = float(np.mean(z.argmax(1) == t.argmax(1)))
    net.train()
    return res


def train(d, out, name):
    meta, x, y, m, val = load(d, name)
    heads = meta["heads"]
    mx.random.seed(7)
    np.random.seed(7)
    net = Net(x.shape[1], SIZES[name], heads)
    opt = optim.AdamW(learning_rate=2e-3, weight_decay=1e-3)
    tr = ~val
    X, Y = mx.array(x[tr]), mx.array(y[tr])
    M = mx.array(m[tr]) if m is not None else None
    Xv, Yv = mx.array(x[val]), mx.array(y[val])
    Mv = mx.array(m[val]) if m is not None else None
    step = nn.value_and_grad(net, lambda xb, yb, mb: losses(net, heads, xb, yb, mb)[0])
    best, best_params, patience = float("inf"), None, 0
    n, batch = X.shape[0], 256
    for epoch in range(200):
        perm = np.random.permutation(n)
        for i in range(0, n, batch):
            idx = mx.array(perm[i : i + batch])
            loss, grads = step(X[idx], Y[idx], M[idx] if M is not None else None)
            opt.update(net, grads)
            mx.eval(net.parameters(), opt.state)
        net.eval()
        vl = float(losses(net, heads, Xv, Yv, Mv)[0]) if Xv.shape[0] else 0.0
        net.train()
        if vl < best - 1e-4:
            best, patience = vl, 0
            best_params = {k: np.array(v) for k, v in nn.utils.tree_flatten(net.parameters())}
        else:
            patience += 1
            if patience >= 12:
                break
    net.update(nn.utils.tree_unflatten([(k, mx.array(v)) for k, v in best_params.items()]))
    net.eval()
    report = {
        "rows": int(len(y)),
        "train": int(tr.sum()),
        "val": int(val.sum()),
        "epochs": epoch + 1,
        "val_loss": round(best, 4),
        "val_agreement_with_teacher": agreement(net, heads, x[val], y[val], m[val] if m is not None else None),
    }
    p = best_params
    f = {
        "input": int(x.shape[1]),
        "hidden": SIZES[name],
        "w": b64(p["hidden.weight"]),
        "b": b64(p["hidden.bias"]),
        "heads": {},
    }
    for i, (hn, h) in enumerate(heads.items()):
        f["heads"][hn] = {
            "kind": h["kind"],
            "labels": h.get("labels", ["true"]),
            "w": b64(p[f"outs.{i}.weight"]),
            "b": b64(p[f"outs.{i}.bias"]),
        }
    # Parity checks: a few inputs and this net's outputs, for the TypeScript tests. agreement()
    # leaves the net in training mode, so switch dropout off again first.
    net.eval()
    rows = list(range(0, len(x), max(1, len(x) // 5)))[:5]
    outs = [np.array(o) for o in net(mx.array(x[rows]))]
    checks = []
    for j, r in enumerate(rows):
        c = {"x": [round(float(v), 6) for v in x[r]], "out": {}}
        for (hn, h), z in zip(heads.items(), outs):
            if h["kind"] == "sigmoid":
                c["out"][hn] = {"true": float(1 / (1 + np.exp(-z[j, 0])))}
            else:
                zz = z[j].astype(np.float64)
                if m is not None:
                    zz = np.where(m[r] > 0, zz, -np.inf)
                e = np.exp(zz - zz.max())
                c["out"][hn] = dict(zip(h["labels"], (e / e.sum()).tolist()))
        if m is not None:
            c["mask"] = {hn: [l for l, keep in zip(h["labels"], m[r]) if not keep] for hn, h in heads.items() if h["kind"] == "softmax"}
        checks.append(c)
    json.dump(f, open(out / f"{name}.json", "w"))
    json.dump(checks, open(out / f"{name}.checks.json", "w"))
    print(name, json.dumps(report), flush=True)
    return report


if __name__ == "__main__":
    d, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    names = sys.argv[3:] or list(SIZES)
    reports = {n: train(d, out, n) for n in names if (d / f"{n}.json").exists()}
    json.dump(reports, open(out / "training.json", "w"), indent=1)
