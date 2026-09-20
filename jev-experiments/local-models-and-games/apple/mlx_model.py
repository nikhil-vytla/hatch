"""Original MLX implementation of the published Laya inference equations.

Compatible with pinned convaiinnovations/laya weights, Apache-2.0.
Reference architectures: NandhaKishorM/laya and Hugging Face ModernBERT.
No autoregressive decoding. Each question is an independent batch row.
"""

import math
import mlx.core as mx
import mlx.nn as nn


def linear(x, w, p):
    y = x @ w[p + ".weight"].T
    return y + w[p + ".bias"] if p + ".bias" in w else y


def norm(x, w, p, eps=1e-5):
    return mx.fast.layer_norm(x, w[p + ".weight"], w.get(p + ".bias"), eps)


def attention(q, k, v, mask):
    return mx.fast.scaled_dot_product_attention(q, k, v, scale=q.shape[-1] ** -0.5, mask=mask)


def rotary(x, theta):
    n, d = x.shape[-2:]
    freq = mx.arange(n)[:, None] / (theta ** (mx.arange(0, d, 2) / d))[None, :]
    angles = mx.concatenate([freq, freq], axis=-1)[None, None]
    half = d // 2
    rot = mx.concatenate([-x[..., half:], x[..., :half]], axis=-1)
    return x * mx.cos(angles) + rot * mx.sin(angles)


class Encoder(nn.Module):
    def __init__(self, weights, cfg):
        super().__init__()
        self.w = weights
        self.cfg = cfg

    def __call__(self, ids, pad):
        w, c = self.w, self.cfg
        h = norm(w["embeddings.tok_embeddings.weight"][ids], w, "embeddings.norm")
        b, n, d = h.shape
        heads = c["num_attention_heads"]
        hd = d // heads
        base = mx.where(pad[:, None, None, :] > 0, 0.0, -1e9)
        distance = mx.abs(mx.arange(n)[:, None] - mx.arange(n)[None, :])
        local = base + mx.where(distance[None, None] <= c["local_attention"] // 2, 0.0, -1e9)
        for i in range(c["num_hidden_layers"]):
            p = f"layers.{i}"
            x = norm(h, w, p + ".attn_norm") if i else h
            q, k, v = mx.split(
                linear(x, w, p + ".attn.Wqkv").reshape(b, n, 3, heads, hd).transpose(2, 0, 3, 1, 4),
                3,
                axis=0,
            )
            q, k, v = q[0], k[0], v[0]
            full = i % c["global_attn_every_n_layers"] == 0
            theta = c["rope_parameters"]["full_attention" if full else "sliding_attention"][
                "rope_theta"
            ]
            x = (
                attention(rotary(q, theta), rotary(k, theta), v, base if full else local)
                .transpose(0, 2, 1, 3)
                .reshape(b, n, d)
            )
            h = h + linear(x, w, p + ".attn.Wo")
            a, g = mx.split(linear(norm(h, w, p + ".mlp_norm"), w, p + ".mlp.Wi"), 2, axis=-1)
            h = h + linear(nn.gelu(a) * g, w, p + ".mlp.Wo")
        return norm(h, w, "final_norm")


class Head(nn.Module):
    def __init__(self, weights):
        super().__init__()
        self.w = weights

    def __call__(self, h, pad, markers, valid, qtype):
        w = self.w
        h = h + w["type_emb.weight"][qtype][:, None, :]
        b, n, d = h.shape
        heads = d // 64
        mask = mx.where(pad[:, None, None, :] > 0, 0.0, -1e9)
        for i in range(2):
            p = f"head.layers.{i}"
            x = norm(h, w, p + ".norm1")
            z = x @ w[p + ".self_attn.in_proj_weight"].T + w[p + ".self_attn.in_proj_bias"]
            q, k, v = mx.split(z.reshape(b, n, 3, heads, 64).transpose(2, 0, 3, 1, 4), 3, axis=0)
            x = attention(q[0], k[0], v[0], mask).transpose(0, 2, 1, 3).reshape(b, n, d)
            h = h + linear(x, w, p + ".self_attn.out_proj")
            h = h + linear(
                nn.relu(linear(norm(h, w, p + ".norm2"), w, p + ".linear1")), w, p + ".linear2"
            )
        anchors = h[mx.arange(b)[:, None], markers]
        logits = linear(
            nn.gelu(linear(norm(anchors, w, "scorer.0"), w, "scorer.1")), w, "scorer.3"
        )[..., 0]
        return mx.where(valid, logits, -1e4)


def load(path, cfg):
    weights = mx.load(str(path))
    encoder = Encoder(
        {
            k.removeprefix("encoder."): v.astype(mx.float32)
            for k, v in weights.items()
            if k.startswith("encoder.")
        },
        cfg,
    )
    head = Head(
        {
            k: v.astype(mx.float32)
            for k, v in weights.items()
            if k.startswith(("head.", "type_emb.", "scorer."))
        }
    )
    mx.eval(encoder.parameters(), head.parameters())
    return encoder, head
