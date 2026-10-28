"""Add each neuron's nearest neighbors by output direction to an existing atlas.

    python -m atlas.neighbors --atlas out/<slug> [--k 8]

Cosine similarity between unit-norm down-projection columns, across all layers. Adds `nbrs` (global index
layer * d_mlp + neuron) and `nbr_cos` to neurons.parquet. Exact search in chunks: O(N^2 d), about a minute on CPU
for 100k neurons.
"""
import argparse, json
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from .model import NeuronModel


@torch.no_grad()
def neighbors(nm: NeuronModel, k=8, chunk=4096):
    X = torch.cat([torch.nn.functional.normalize(nm.down_cols(L), dim=1) for L in range(nm.n_layers)])
    idx = torch.empty(len(X), k, dtype=torch.int32)
    cos = torch.empty(len(X), k)
    for s in range(0, len(X), chunk):
        sim = X[s:s + chunk] @ X.T
        sim[torch.arange(sim.shape[0]), torch.arange(s, s + sim.shape[0])] = -2  # not yourself
        top = sim.topk(k, dim=1)
        idx[s:s + chunk] = top.indices.int().cpu()
        cos[s:s + chunk] = top.values.cpu()
    return idx.numpy(), cos.numpy()


def add(atlas, k=8, nm=None):
    meta = json.load(open(f"{atlas}/meta.json"))
    nm = nm or NeuronModel(meta["model"], device=None)
    idx, cos = neighbors(nm, k)
    t = pq.read_table(f"{atlas}/neurons.parquet")
    order = (t["layer"].to_numpy().astype(np.int64) * meta["d_mlp"] + t["neuron"].to_numpy())
    off = pa.array(np.arange(0, len(order) * k + 1, k, dtype=np.int32))
    for name, arr, typ in [("nbrs", idx[order], pa.int32()), ("nbr_cos", cos[order].round(3), pa.float32())]:
        col = pa.ListArray.from_arrays(off, pa.array(arr.reshape(-1), type=typ))
        t = t.set_column(t.schema.get_field_index(name), name, col) if name in t.schema.names else t.append_column(name, col)
    pq.write_table(t, f"{atlas}/neurons.parquet", compression="zstd", row_group_size=16384)
    print(f"neighbors added to {atlas}: mean top-1 cosine {cos[:, 0].mean():.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--k", type=int, default=8)
    a = ap.parse_args()
    add(a.atlas, a.k)
