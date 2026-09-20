import numpy as np


def metrics(rows, key):
    correct = []
    soft = []
    brier = []
    kl = []
    confidence = []
    mae = []
    for r in rows:
        p = np.array(r[key], dtype=float)
        p /= p.sum()
        t = np.array(r["target"], dtype=float)
        t /= t.sum()
        i = int(p.argmax())
        correct.append(int(i == t.argmax()))
        soft.append(float(t[i]))
        brier.append(float(np.mean((p - t) ** 2)))
        kl.append(float(np.sum(t * np.log(np.maximum(t, 1e-12) / np.maximum(p, 1e-12)))))
        confidence.append(float(p[i]))
        if r["qtype"] == 1:
            mae.append(abs(float(np.arange(len(p)) @ (p - t))))
    c = np.array(correct)
    conf = np.array(confidence)
    ece = 0
    for lo, hi in zip(np.linspace(0, 1, 11)[:-1], np.linspace(0, 1, 11)[1:]):
        mask = (conf > lo) & (conf <= hi)
        if mask.any():
            ece += mask.mean() * abs(conf[mask].mean() - c[mask].mean())
    return {
        "decisions": len(rows),
        "accuracy": float(c.mean()),
        "soft_accuracy": float(np.mean(soft)),
        "brier": float(np.mean(brier)),
        "kl": float(np.mean(kl)),
        "ece": float(ece),
        "score_mae": float(np.mean(mae)) if mae else None,
    }
