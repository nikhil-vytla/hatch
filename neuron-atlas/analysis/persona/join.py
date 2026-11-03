"""Join the weight, activation, lexicon and atlas views of the Qwen3-8B OCEAN persona adapters.

Reads the outputs of weights.py and acts.py, the JSON from lexicon.py and a local Qwen3-8B atlas
directory, then writes results.json, top_neurons.csv and web figure data CSVs.  Runs on CPU with
pandas/numpy; no torch.

Usage:
  python analysis/persona/join.py --weights persona_weights --acts persona_acts \\
      --lexicon persona_lexicon.json --atlas atlas/Qwen__Qwen3-8B --out persona_join
  python analysis/persona/join.py --weights pw --acts pa --lexicon pl.json \\
      --atlas atlas/Qwen__Qwen3-8B --out pj_smoke --sample 0.01
"""
import argparse
import json
import math
import os

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

MODEL = "Qwen/Qwen3-8B"
N_LAYERS = 36
D_MLP = 12288
N_ALL_NEURONS = N_LAYERS * D_MLP
TRAITS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]
SHORT = {"openness": "o", "conscientiousness": "c", "extraversion": "e",
         "agreeableness": "a", "neuroticism": "n"}
ADAPTERS = ["o+", "o-", "c+", "c-", "e+", "e-", "a+", "a-", "n+", "n-", "ctrl"]
WEIGHT_METRICS = ("dgate", "dup", "ddown", "dcos")
ACT_METRICS = ("rel", "shift", "start", "reply_rel")
MODULES = ["gate_proj", "up_proj", "down_proj", "q_proj", "k_proj", "v_proj", "o_proj"]
MLP_MODULES = ["gate_proj", "up_proj", "down_proj"]
ATTN_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj"]
CORR_EDGES = np.linspace(-1.0, 1.0, 21)
START_EDGES = np.linspace(0.0, 1.0, 21)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--weights", required=True, help="output directory of weights.py")
    ap.add_argument("--acts", required=True, help="output directory of acts.py")
    ap.add_argument("--lexicon", required=True, help="JSON written by lexicon.py")
    ap.add_argument("--atlas", required=True, help="local Qwen3-8B atlas directory")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--sample", type=float, default=None, help="optional fraction of neurons for a quick test")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--reps", type=int, default=5, help="matched-random replicates")
    ap.add_argument("--overlap-reps", type=int, default=100, help="uniform-random overlap replicates")
    return ap.parse_args()


def require_columns(frame, columns, source):
    missing = [c for c in columns if c not in frame.columns]
    if missing:
        raise ValueError(f"{source} is missing columns {missing}")


def amp_name(trait):
    return SHORT[trait] + "+"


def sup_name(trait):
    return SHORT[trait] + "-"


def pair_column(columns, x, y):
    for name in (f"{x}|{y}", f"{y}|{x}"):
        if name in columns:
            return name
    raise KeyError(f"no activation-pair column for {x} and {y}")


def subsample_neurons(df, fraction, seed):
    if not 0.0 < fraction <= 1.0:
        raise ValueError("--sample must be in (0, 1]")
    if fraction >= 1.0:
        return df
    rng = np.random.default_rng(seed)
    parts = []
    for layer, group in df.groupby("layer", sort=True):
        k = max(1, int(round(len(group) * fraction)))
        k = min(k, len(group))
        picked = rng.choice(group.index.to_numpy(), size=k, replace=False)
        parts.append(df.loc[np.sort(picked)])
    out = pd.concat(parts).sort_values(["layer", "neuron"]).reset_index(drop=True)
    print(f"sampled {len(out)} of {len(df)} neurons at {fraction:g}", flush=True)
    return out


def load_inputs(weights_dir, acts_dir, sample, seed):
    wpath = os.path.join(weights_dir, "neurons.parquet")
    apath = os.path.join(acts_dir, "neurons.parquet")
    w = pd.read_parquet(wpath)
    a = pd.read_parquet(apath)
    wcols = [f"{name}_{metric}" for name in ADAPTERS for metric in WEIGHT_METRICS]
    acols = ["base_rms"] + [f"{name}_{metric}" for name in ADAPTERS for metric in ACT_METRICS]
    require_columns(w, ["layer", "neuron"] + wcols, wpath)
    require_columns(a, ["layer", "neuron"] + acols, apath)
    if w.duplicated(["layer", "neuron"]).any():
        raise ValueError(f"{wpath} has duplicate (layer, neuron) rows")
    if a.duplicated(["layer", "neuron"]).any():
        raise ValueError(f"{apath} has duplicate (layer, neuron) rows")
    w = w[["layer", "neuron"] + wcols].copy()
    a = a[["layer", "neuron"] + acols].copy()
    for col in wcols:
        w[col] = w[col].astype(np.float32)
    for col in acols:
        a[col] = a[col].astype(np.float32)
    df = w.merge(a, on=["layer", "neuron"], how="inner", validate="one_to_one")
    print(f"merged {len(df)} weights/activations rows", flush=True)
    if len(df) != len(w) or len(df) != len(a):
        print(f"warning: weight rows {len(w)}, act rows {len(a)}, merged {len(df)}", flush=True)
    if sample is not None:
        df = subsample_neurons(df, sample, seed)
    df = df.sort_values(["layer", "neuron"]).reset_index(drop=True)
    ppath = os.path.join(acts_dir, "pairs.parquet")
    pairs = pd.read_parquet(ppath)
    require_columns(pairs, ["layer", "neuron"], ppath)
    if pairs.duplicated(["layer", "neuron"]).any():
        raise ValueError(f"{ppath} has duplicate (layer, neuron) rows")
    for col in pairs.columns:
        if col not in ("layer", "neuron"):
            pairs[col] = pairs[col].astype(np.float32)
    df = df.merge(pairs, on=["layer", "neuron"], how="left", validate="one_to_one")
    df["gid"] = df["layer"].astype(np.int64) * D_MLP + df["neuron"].astype(np.int64)
    return df


def load_modules(weights_dir):
    path = os.path.join(weights_dir, "modules.parquet")
    df = pd.read_parquet(path)
    require_columns(df, ["adapter", "layer", "module", "rel_fro"], path)
    df["rel_fro"] = df["rel_fro"].astype(np.float32)
    return df


def load_weight_pairs(weights_dir):
    path = os.path.join(weights_dir, "pairs.parquet")
    df = pd.read_parquet(path)
    require_columns(df, ["layer", "module", "a", "b", "cos"], path)
    df["cos"] = df["cos"].astype(np.float32)
    return df


def pick_text_column(columns, candidates, source):
    for name in candidates:
        if name in columns:
            return name
    raise ValueError(f"{source} has none of the text columns {candidates}")


def load_atlas(atlas_dir):
    labels_path = os.path.join(atlas_dir, "labels.parquet")
    personas_path = os.path.join(atlas_dir, "personas.parquet")
    label_schema = pq.read_schema(labels_path)
    if "layer" not in label_schema.names or "neuron" not in label_schema.names:
        raise ValueError(f"{labels_path} is missing layer/neuron")
    label_col = pick_text_column(label_schema.names, ["label", "name", "text", "description", "title"],
                                 labels_path)
    labels = pd.read_parquet(labels_path, columns=["layer", "neuron", label_col])
    label_map = {}
    for layer, neuron, text in zip(labels["layer"], labels["neuron"], labels[label_col]):
        label_map[(int(layer), int(neuron))] = "" if pd.isna(text) else str(text)

    persona_schema = pq.read_schema(personas_path)
    if "layer" not in persona_schema.names or "neuron" not in persona_schema.names:
        raise ValueError(f"{personas_path} is missing layer/neuron")
    reply_col = "reply_kind" if "reply_kind" in persona_schema.names else None
    if reply_col is None:
        raise ValueError(f"{personas_path} is missing reply_kind")
    cols = ["layer", "neuron", reply_col]
    if "who" in persona_schema.names:
        cols.append("who")
    personas = pd.read_parquet(personas_path, columns=cols)
    rename = set(zip(personas.loc[personas[reply_col] == "persona", "layer"].astype(int),
                     personas.loc[personas[reply_col] == "persona", "neuron"].astype(int)))
    present = set(zip(personas["layer"].astype(int), personas["neuron"].astype(int)))
    who_map = {}
    if "who" in personas.columns:
        for layer, neuron, who in zip(personas["layer"], personas["neuron"], personas["who"]):
            if not pd.isna(who) and str(who).strip():
                who_map.setdefault((int(layer), int(neuron)), str(who))
    sweep = load_sweep_persona_share(atlas_dir)
    print(f"atlas: {len(label_map)} labels, {len(rename)} renamers, {len(present)} neurons in personas",
          flush=True)
    return dict(label=label_map, rename=rename, present=present, who=who_map, sweep=sweep)


def load_sweep_persona_share(atlas_dir):
    path = os.path.join(atlas_dir, "sweep_stats.parquet")
    if not os.path.exists(path):
        return None
    schema = pq.read_schema(path)
    needed = ["layer", "reply_kind", "n_est"]
    if not all(name in schema.names for name in needed):
        return None
    stats = pd.read_parquet(path, columns=needed)
    grouped = stats.groupby(["layer", "reply_kind"], as_index=False)["n_est"].sum()
    out = {}
    for layer, group in grouped.groupby("layer"):
        total = float(group["n_est"].sum())
        persona = float(group.loc[group["reply_kind"] == "persona", "n_est"].sum())
        out[str(int(layer))] = dict(total=total, persona=persona,
                                    share=persona / total if total else None)
    return out


def load_lexicon(path):
    with open(path) as handle:
        obj = json.load(handle)
    rows = obj.get("neurons") if isinstance(obj, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"{path} has no 'neurons' list")
    lex = {}
    for row in rows:
        layer = int(row["layer"])
        neuron = int(row["neuron"])
        lex[(layer, neuron)] = dict(
            up=row.get("up") or {},
            down=row.get("down") or {},
            up_tokens=[str(t).strip() for t in (row.get("up_tokens") or [])],
            down_tokens=[str(t).strip() for t in (row.get("down_tokens") or [])],
        )
    print(f"lexicon: {len(lex)} neurons with a trait word", flush=True)
    return lex


def selection_masks(df):
    masks = {}
    ctrl = df["ctrl_rel"].to_numpy()
    for trait in TRAITS:
        best = np.maximum(df[f"{amp_name(trait)}_rel"].to_numpy(),
                          df[f"{sup_name(trait)}_rel"].to_numpy())
        masks[trait] = (best >= 0.5) & (ctrl < 0.5 * best)
    return masks


def random_overlap_expectation(counts, n_universe, reps, seed):
    rng = np.random.default_rng(seed + 101)
    acc_count = {}
    acc_jaccard = {}
    for i, left in enumerate(TRAITS):
        for right in TRAITS[i:]:
            acc_count[(left, right)] = 0.0
            acc_jaccard[(left, right)] = 0.0
    for _ in range(reps):
        sets = {}
        for trait in TRAITS:
            k = min(int(counts[trait]), n_universe)
            sets[trait] = set(rng.choice(n_universe, size=k, replace=False).tolist())
        for i, left in enumerate(TRAITS):
            for right in TRAITS[i:]:
                inter = len(sets[left] & sets[right])
                union = len(sets[left] | sets[right])
                acc_count[(left, right)] += inter
                acc_jaccard[(left, right)] += inter / union if union else 0.0
    expected_counts = {}
    expected_jaccard = {}
    for left in TRAITS:
        expected_counts[left] = {}
        expected_jaccard[left] = {}
        for right in TRAITS:
            key = (left, right) if (left, right) in acc_count else (right, left)
            expected_counts[left][right] = acc_count[key] / reps
            if left == right:
                expected_jaccard[left][right] = 1.0 if counts[left] else None
            else:
                expected_jaccard[left][right] = acc_jaccard[key] / reps
    return expected_counts, expected_jaccard


def analyse_selection(df, masks, overlap_reps, seed):
    counts = {trait: int(mask.sum()) for trait, mask in masks.items()}
    layer_hist = {}
    for trait, mask in masks.items():
        layer_hist[trait] = np.bincount(df.loc[mask, "layer"].to_numpy(),
                                        minlength=N_LAYERS).astype(int).tolist()
    membership = np.zeros(len(df), dtype=np.int8)
    for mask in masks.values():
        membership += mask.astype(np.int8)
    overlap_counts = {}
    overlap_jaccard = {}
    for left in TRAITS:
        overlap_counts[left] = {}
        overlap_jaccard[left] = {}
        for right in TRAITS:
            inter = int(np.logical_and(masks[left], masks[right]).sum())
            union = int(np.logical_or(masks[left], masks[right]).sum())
            overlap_counts[left][right] = inter
            overlap_jaccard[left][right] = inter / union if union else None
    expected_counts, expected_jaccard = random_overlap_expectation(
        counts, len(df), overlap_reps, seed)
    return dict(
        n_universe=int(len(df)),
        counts=counts,
        layer_hist=layer_hist,
        overlap_counts=overlap_counts,
        overlap_jaccard=overlap_jaccard,
        expected_counts=expected_counts,
        expected_jaccard=expected_jaccard,
        n_multi_trait=int((membership >= 2).sum()),
        membership_hist={str(k): int((membership == k).sum()) for k in range(len(TRAITS) + 1)},
    )


def matched_random_masks(df, selected, reps, seed):
    layers = df["layer"].to_numpy()
    positions = {int(layer): np.flatnonzero(layers == layer) for layer in np.unique(layers)}
    rng = np.random.default_rng(seed)
    masks = []
    for _ in range(reps):
        mask = np.zeros(len(df), dtype=bool)
        for layer, pool in positions.items():
            k = int(np.sum(selected[pool]))
            if k <= 0:
                continue
            picked = rng.choice(pool, size=min(k, len(pool)), replace=False)
            mask[picked] = True
        masks.append(mask)
    return masks


def finite_values(values):
    arr = np.asarray(values, dtype=np.float64)
    return arr[np.isfinite(arr)]


def value_stats(values):
    arr = finite_values(values)
    if len(arr) == 0:
        return dict(n=0, mean=None, median=None, share_negative=None, q25=None, q75=None)
    return dict(
        n=int(len(arr)),
        mean=float(np.mean(arr)),
        median=float(np.median(arr)),
        share_negative=float(np.mean(arr < 0)),
        q25=float(np.quantile(arr, 0.25)),
        q75=float(np.quantile(arr, 0.75)),
    )


def hist_share(values, edges):
    arr = finite_values(values)
    if len(arr) == 0:
        return np.zeros(len(edges) - 1, dtype=np.float64)
    counts, _ = np.histogram(arr, bins=edges)
    return counts.astype(np.float64) / len(arr)


def replicate_summary(stats, keys):
    out = {}
    for key in keys:
        vals = [s[key] for s in stats if s.get(key) is not None]
        out[f"{key}_mean"] = float(np.mean(vals)) if vals else None
        out[f"{key}_sd"] = float(np.std(vals)) if vals else None
    return out


def analyse_opposite(df, masks, reps, seed):
    out = {}
    for index, trait in enumerate(TRAITS):
        col = pair_column(df.columns, amp_name(trait), sup_name(trait))
        selected = masks[trait]
        selected_corr = value_stats(df.loc[selected, col])
        random_masks = matched_random_masks(df, selected, reps, seed + 1000 + 37 * index)
        random_stats = [value_stats(df.loc[mask, col]) for mask in random_masks]
        selected_hist = hist_share(df.loc[selected, col], CORR_EDGES)
        random_hist = np.mean([hist_share(df.loc[mask, col], CORR_EDGES)
                               for mask in random_masks], axis=0)
        quiet = selected & (df["ctrl_rel"].to_numpy() < 0.1)
        quiet_corr = value_stats(df.loc[quiet, col])
        quiet_masks = matched_random_masks(df, quiet, reps, seed + 2000 + 37 * index)
        quiet_stats = [value_stats(df.loc[mask, col]) for mask in quiet_masks]
        quiet_hist = np.mean([hist_share(df.loc[mask, col], CORR_EDGES)
                              for mask in quiet_masks], axis=0)
        out[trait] = dict(
            n_selected=int(selected.sum()),
            corr=selected_corr,
            random=dict(replicates=random_stats,
                        **replicate_summary(random_stats, ["n", "median", "share_negative"])),
            ctrl_quiet=dict(
                n_selected=int(quiet.sum()),
                corr=quiet_corr,
                random=dict(replicates=quiet_stats,
                            **replicate_summary(quiet_stats, ["n", "median", "share_negative"])),
                hist=dict(edges=CORR_EDGES.tolist(),
                          centers=((CORR_EDGES[:-1] + CORR_EDGES[1:]) / 2).tolist(),
                          selected=hist_share(df.loc[quiet, col], CORR_EDGES).tolist(),
                          random=quiet_hist.tolist()),
            ),
            hist=dict(edges=CORR_EDGES.tolist(),
                      centers=((CORR_EDGES[:-1] + CORR_EDGES[1:]) / 2).tolist(),
                      selected=selected_hist.tolist(),
                      random=random_hist.tolist()),
        )
    return out


def analyse_cross_trait(df, masks):
    out = {}
    for i, left in enumerate(TRAITS):
        out[left] = {}
        for right in TRAITS[i + 1:]:
            inter = masks[left] & masks[right]
            col = pair_column(df.columns, amp_name(left), amp_name(right))
            out[left][right] = dict(n_selected=int(inter.sum()),
                                    corr=value_stats(df.loc[inter, col]))
    return out


def analyse_control_direction(df, masks):
    out = {}
    for trait in TRAITS:
        selected = masks[trait]
        amp_shift = df.loc[selected, f"{amp_name(trait)}_shift"].to_numpy()
        ctrl_shift = df.loc[selected, "ctrl_shift"].to_numpy()
        same = np.sign(amp_shift) == np.sign(ctrl_shift)
        nonzero = (amp_shift != 0) & (ctrl_shift != 0)
        out[trait] = dict(
            n=int(selected.sum()),
            share_sign_agree=float(np.mean(same)) if len(same) else None,
            n_nonzero=int(nonzero.sum()),
            share_sign_agree_nonzero=float(np.mean(same[nonzero])) if nonzero.any() else None,
        )
    return out


def analyse_reply_start(df, masks, reps, seed):
    out = {}
    for index, trait in enumerate(TRAITS):
        out[trait] = {}
        selected = masks[trait]
        for offset, adapter in enumerate((amp_name(trait), sup_name(trait))):
            col = f"{adapter}_start"
            selected_stats = value_stats(df.loc[selected, col])
            random_masks = matched_random_masks(df, selected, reps, seed + 3000 + 37 * index + offset)
            random_stats = [value_stats(df.loc[mask, col]) for mask in random_masks]
            selected_hist = hist_share(df.loc[selected, col], START_EDGES)
            random_hist = np.mean([hist_share(df.loc[mask, col], START_EDGES)
                                   for mask in random_masks], axis=0)
            out[trait][adapter] = dict(
                n_selected=int(selected.sum()),
                selected=selected_stats,
                random=dict(replicates=random_stats,
                            **replicate_summary(random_stats, ["n", "median"])),
                hist=dict(edges=START_EDGES.tolist(),
                          centers=((START_EDGES[:-1] + START_EDGES[1:]) / 2).tolist(),
                          selected=selected_hist.tolist(),
                          random=random_hist.tolist()),
            )
    return out


def spearman(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    valid = np.isfinite(x) & np.isfinite(y)
    x = x[valid]
    y = y[valid]
    if len(x) < 3:
        return None
    xr = pd.Series(x).rank(method="average").to_numpy()
    yr = pd.Series(y).rank(method="average").to_numpy()
    if np.std(xr) == 0 or np.std(yr) == 0:
        return None
    return float(np.corrcoef(xr, yr)[0, 1])


def top_one_percent(weight, act):
    n = len(weight)
    if n < 10:
        return None, None, None
    k = max(1, int(round(0.01 * n)))
    top_weight = np.argsort(-weight, kind="mergesort")[:k]
    top_act = np.argsort(-act, kind="mergesort")[:k]
    precision = float(np.intersect1d(top_weight, top_act).size / k)
    chance = float(k / n)
    below = float(np.mean(weight[top_act] < np.median(weight)))
    return precision, chance, below


def analyse_weights_vs_acts(df):
    out = {}
    rows = []
    layer_values = df["layer"].to_numpy()
    for adapter in ADAPTERS:
        edit = df[[f"{adapter}_dgate", f"{adapter}_dup", f"{adapter}_ddown"]].max(axis=1).to_numpy(
            dtype=np.float64)
        act = df[f"{adapter}_rel"].to_numpy(dtype=np.float64)
        valid = np.isfinite(edit) & np.isfinite(act)
        overall = spearman(edit[valid], act[valid])
        layer_spearman = {}
        for layer in range(N_LAYERS):
            keep = valid & (layer_values == layer)
            value = spearman(edit[keep], act[keep])
            layer_spearman[str(layer)] = value
            rows.append(dict(adapter=adapter, layer=layer, spearman=value))
        rows.append(dict(adapter=adapter, layer=-1, spearman=overall))
        if valid.sum() >= 10:
            precision, chance, below = top_one_percent(edit[valid], act[valid])
        else:
            precision, chance, below = None, None, None
        out[adapter] = dict(
            n=int(valid.sum()),
            overall_spearman=overall,
            layer_spearman=layer_spearman,
            top1_precision=precision,
            top1_chance=chance,
            top1_act_below_median_weight_share=below,
        )
    return out, rows


def safe_mean(values):
    arr = finite_values(values)
    return float(np.mean(arr)) if len(arr) else None


def safe_sum(values):
    arr = np.asarray(values, dtype=np.float64)
    arr = arr[np.isfinite(arr)]
    return float(np.sum(arr)) if len(arr) else None


def analyse_module_profile(modules):
    present = set(modules["adapter"].unique())
    missing = [name for name in ADAPTERS if name not in present]
    if missing:
        raise ValueError(f"modules.parquet is missing adapters {missing}")
    out = {}
    for adapter in ADAPTERS:
        sub = modules.loc[modules["adapter"] == adapter]
        pivot = sub.pivot_table(index="layer", columns="module", values="rel_fro", aggfunc="mean")
        pivot = pivot.reindex(index=range(N_LAYERS), columns=MODULES)
        table = {}
        for layer in range(N_LAYERS):
            row = {}
            for module in MODULES:
                value = pivot.loc[layer, module] if layer in pivot.index else np.nan
                row[module] = float(value) if pd.notna(value) else None
            table[str(layer)] = row
        mlp_values = sub.loc[sub["module"].isin(MLP_MODULES), "rel_fro"].to_numpy()
        attn_values = sub.loc[sub["module"].isin(ATTN_MODULES), "rel_fro"].to_numpy()
        mlp_mean = safe_mean(mlp_values)
        attn_mean = safe_mean(attn_values)
        mlp_sum = safe_sum(mlp_values)
        attn_sum = safe_sum(attn_values)
        mean_total = (mlp_mean or 0.0) + (attn_mean or 0.0)
        sum_total = (mlp_sum or 0.0) + (attn_sum or 0.0)
        module_mean = {module: safe_mean(sub.loc[sub["module"] == module, "rel_fro"])
                       for module in MODULES}
        out[adapter] = dict(
            layer_module=table,
            module_mean=module_mean,
            mlp_mean=mlp_mean,
            attn_mean=attn_mean,
            mlp_share_mean=(mlp_mean / mean_total if mlp_mean is not None and mean_total else None),
            attn_share_mean=(attn_mean / mean_total if attn_mean is not None and mean_total else None),
            mlp_sum=mlp_sum,
            attn_sum=attn_sum,
            mlp_share_sum=(mlp_sum / sum_total if mlp_sum is not None and sum_total else None),
            attn_share_sum=(attn_sum / sum_total if attn_sum is not None and sum_total else None),
        )
    return out


def pair_mean(pairs, x, y, module=None):
    mask = (((pairs["a"] == x) & (pairs["b"] == y)) |
            ((pairs["a"] == y) & (pairs["b"] == x)))
    if module is not None:
        mask &= pairs["module"] == module
    sub = pairs.loc[mask, "cos"]
    if sub.empty:
        raise ValueError(f"no weight-edit cosine row for {x} vs {y}, module {module}")
    return float(sub.mean())


def analyse_weight_cosines(pairs):
    opposite = {}
    with_ctrl = {}
    between_amplifier = {}
    between_suppressor = {}
    for trait in TRAITS:
        opposite[trait] = {module: pair_mean(pairs, amp_name(trait), sup_name(trait), module)
                           for module in MODULES}
        opposite[trait]["all"] = pair_mean(pairs, amp_name(trait), sup_name(trait))
    for adapter in ADAPTERS:
        if adapter == "ctrl":
            continue
        with_ctrl[adapter] = {module: pair_mean(pairs, adapter, "ctrl", module)
                              for module in MODULES}
        with_ctrl[adapter]["all"] = pair_mean(pairs, adapter, "ctrl")
    for i, left in enumerate(TRAITS):
        for right in TRAITS[i + 1:]:
            key = f"{left}|{right}"
            between_amplifier[key] = {
                module: pair_mean(pairs, amp_name(left), amp_name(right), module)
                for module in MODULES}
            between_amplifier[key]["all"] = pair_mean(pairs, amp_name(left), amp_name(right))
            between_suppressor[key] = {
                module: pair_mean(pairs, sup_name(left), sup_name(right), module)
                for module in MODULES}
            between_suppressor[key]["all"] = pair_mean(pairs, sup_name(left), sup_name(right))
    return dict(opposite=opposite, with_ctrl=with_ctrl,
                between_traits_amplifier=between_amplifier,
                between_traits_suppressor=between_suppressor)


def atlas_shares(df, mask, trait, lex, rename, present):
    letter = SHORT[trait].upper()
    high_key = letter + "+"
    layers = df["layer"].to_numpy()
    neurons = df["neuron"].to_numpy()
    shifts = df[f"{amp_name(trait)}_shift"].to_numpy()
    indices = np.flatnonzero(mask)
    counts = dict(any_word=0, this_trait=0, naming=0, agree=0, rename=0, present=0)
    for index in indices:
        layer = int(layers[index])
        neuron = int(neurons[index])
        info = lex.get((layer, neuron))
        if info:
            up = info["up"]
            down = info["down"]
            any_word = bool(up or down)
            this_trait = any(str(key).upper().startswith(letter)
                             for key in list(up.keys()) + list(down.keys()))
        else:
            up = {}
            down = {}
            any_word = False
            this_trait = False
        if any_word:
            counts["any_word"] += 1
        if this_trait:
            counts["this_trait"] += 1
            counts["naming"] += 1
            shift = float(shifts[index])
            if (shift > 0 and high_key in up) or (shift < 0 and high_key in down):
                counts["agree"] += 1
        if (layer, neuron) in rename:
            counts["rename"] += 1
        if (layer, neuron) in present:
            counts["present"] += 1

    def share(name):
        return counts[name] / len(indices) if indices.size else None

    return dict(
        n=int(indices.size),
        n_any_trait_word=counts["any_word"],
        any_trait_word_share=share("any_word"),
        n_this_trait_word=counts["this_trait"],
        this_trait_word_share=share("this_trait"),
        n_sign_naming=counts["naming"],
        n_sign_agree=counts["agree"],
        sign_agree_share=(counts["agree"] / counts["naming"] if counts["naming"] else None),
        n_rename=counts["rename"],
        rename_share=share("rename"),
        n_present=counts["present"],
        present_share=share("present"),
    )


def top_atlas_rows(df, mask, trait, lex, label_map, rename, k=25):
    indices = np.flatnonzero(mask)
    if indices.size == 0:
        return []
    values = df.loc[indices, f"{amp_name(trait)}_rel"].to_numpy()
    order = np.argsort(-values, kind="mergesort")[:k]
    out = []
    for index in indices[order]:
        row = df.iloc[index]
        layer = int(row["layer"])
        neuron = int(row["neuron"])
        info = lex.get((layer, neuron)) or {}
        out.append(dict(
            layer=layer,
            neuron=neuron,
            label=label_map.get((layer, neuron), ""),
            amp_rel=float(row[f"{amp_name(trait)}_rel"]),
            sup_rel=float(row[f"{sup_name(trait)}_rel"]),
            ctrl_rel=float(row["ctrl_rel"]),
            amp_shift=float(row[f"{amp_name(trait)}_shift"]),
            sup_shift=float(row[f"{sup_name(trait)}_shift"]),
            ctrl_shift=float(row["ctrl_shift"]),
            amp_start=float(row[f"{amp_name(trait)}_start"]),
            sup_start=float(row[f"{sup_name(trait)}_start"]),
            up=info.get("up", {}),
            down=info.get("down", {}),
            up_tokens=info.get("up_tokens", []),
            down_tokens=info.get("down_tokens", []),
            persona_rename=(layer, neuron) in rename,
        ))
    return out


def analyse_atlas(df, masks, lex, atlas, reps, seed):
    out = {}
    for index, trait in enumerate(TRAITS):
        selected = masks[trait]
        selected_stats = atlas_shares(df, selected, trait, lex, atlas["rename"], atlas["present"])
        random_masks = matched_random_masks(df, selected, reps, seed + 4000 + 37 * index)
        random_stats = [atlas_shares(df, mask, trait, lex, atlas["rename"], atlas["present"])
                        for mask in random_masks]
        keys = ["any_trait_word_share", "this_trait_word_share", "sign_agree_share",
                "rename_share", "present_share"]
        out[trait] = dict(
            selected=selected_stats,
            random=dict(replicates=random_stats, **replicate_summary(random_stats, keys)),
            top=top_atlas_rows(df, selected, trait, lex, atlas["label"], atlas["rename"]),
        )
    return out


def build_top_neurons(df, masks, lex, label_map, rename):
    frames = []
    for trait in TRAITS:
        indices = np.flatnonzero(masks[trait])
        if indices.size == 0:
            continue
        best = np.maximum(df.loc[indices, f"{amp_name(trait)}_rel"].to_numpy(),
                          df.loc[indices, f"{sup_name(trait)}_rel"].to_numpy())
        order = np.argsort(-best, kind="mergesort")[:50]
        picked = indices[order]
        part = df.iloc[picked].copy()
        part.insert(0, "selected", True)
        part.insert(0, "max_rel", best[order])
        part.insert(0, "trait", trait)
        part["label"] = [label_map.get((int(layer), int(neuron)), "")
                         for layer, neuron in zip(part["layer"], part["neuron"])]
        part["lexicon_up"] = [json.dumps((lex.get((int(layer), int(neuron))) or {}).get("up", {}),
                                         sort_keys=True)
                              for layer, neuron in zip(part["layer"], part["neuron"])]
        part["lexicon_down"] = [json.dumps((lex.get((int(layer), int(neuron))) or {}).get("down", {}),
                                           sort_keys=True)
                                for layer, neuron in zip(part["layer"], part["neuron"])]
        part["up_tokens"] = [" ".join((lex.get((int(layer), int(neuron))) or {}).get("up_tokens", []))
                             for layer, neuron in zip(part["layer"], part["neuron"])]
        part["down_tokens"] = [" ".join((lex.get((int(layer), int(neuron))) or {}).get("down_tokens", []))
                               for layer, neuron in zip(part["layer"], part["neuron"])]
        part["persona_rename"] = [(int(layer), int(neuron)) in rename
                                  for layer, neuron in zip(part["layer"], part["neuron"])]
        frames.append(part)
    if not frames:
        columns = ["trait", "max_rel", "selected", "label", "lexicon_up", "lexicon_down",
                   "up_tokens", "down_tokens", "persona_rename"] + list(df.columns)
        return pd.DataFrame(columns=columns)
    return pd.concat(frames, ignore_index=True)


def layers_frame(selection):
    rows = []
    for trait in TRAITS:
        for layer in range(N_LAYERS):
            rows.append(dict(trait=trait, layer=layer,
                             count=int(selection["layer_hist"][trait][layer])))
    return pd.DataFrame(rows)


def overlap_frame(selection):
    rows = []
    for i, left in enumerate(TRAITS):
        for right in TRAITS[i:]:
            rows.append(dict(
                trait_a=left,
                trait_b=right,
                count=selection["overlap_counts"][left][right],
                jaccard=selection["overlap_jaccard"][left][right],
                expected_count=selection["expected_counts"][left][right],
                expected_jaccard=selection["expected_jaccard"][left][right],
            ))
    return pd.DataFrame(rows)


def corr_hist_frame(opposite):
    rows = []
    for trait in TRAITS:
        hist = opposite[trait]["hist"]
        for index, center in enumerate(hist["centers"]):
            rows.append(dict(trait=trait, bin=float(center),
                             share_selected=float(hist["selected"][index]),
                             share_random=float(hist["random"][index])))
    return pd.DataFrame(rows)


def to_jsonable(obj):
    if isinstance(obj, dict):
        return {str(key): to_jsonable(value) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(value) for value in obj]
    if isinstance(obj, np.ndarray):
        return [to_jsonable(value) for value in obj.tolist()]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        value = float(obj)
        return value if math.isfinite(value) else None
    if obj is None:
        return None
    if isinstance(obj, str):
        return obj
    if isinstance(obj, int):
        return int(obj)
    if pd.isna(obj):
        return None
    return obj


def fmt(value, digits=3):
    return "n/a" if value is None else f"{value:.{digits}f}"


def print_report(results):
    selection = results["selection"]
    print("\n=== Selection ===", flush=True)
    for trait in TRAITS:
        print(f"{trait:17s} {selection['counts'][trait]:6d}", flush=True)
    print(f"selected for >=2 traits: {selection['n_multi_trait']} (universe {selection['n_universe']})",
          flush=True)
    print("overlap: observed/expected count, observed/expected Jaccard", flush=True)
    for i, left in enumerate(TRAITS):
        parts = []
        for right in TRAITS[i + 1:]:
            parts.append(f"{right[:4]} {selection['overlap_counts'][left][right]}"
                         f"/{fmt(selection['expected_counts'][left][right], 1)} "
                         f"J={fmt(selection['overlap_jaccard'][left][right])}"
                         f"/{fmt(selection['expected_jaccard'][left][right])}")
        if parts:
            print(f"  {left:17s} " + "; ".join(parts), flush=True)

    print("\n=== Opposite adapters ===", flush=True)
    for trait in TRAITS:
        item = results["opposite"][trait]
        print(f"{trait:17s} n={item['n_selected']:5d} "
              f"median={fmt(item['corr']['median'])} share<0={fmt(item['corr']['share_negative'])} "
              f"random median={fmt(item['random']['median_mean'])} "
              f"share<0={fmt(item['random']['share_negative_mean'])}", flush=True)
    print("cross-trait T+ vs U+ on the intersection:", flush=True)
    for left in TRAITS:
        for right, item in results["cross_trait_corr"][left].items():
            print(f"  {left:17s} & {right:17s} n={item['n_selected']:5d} "
                  f"median={fmt(item['corr']['median'])} share<0={fmt(item['corr']['share_negative'])}",
                  flush=True)

    print("\n=== Control direction ===", flush=True)
    for trait in TRAITS:
        item = results["control_direction"][trait]
        print(f"{trait:17s} n={item['n']:5d} sign(T+_shift)==sign(ctrl_shift) "
              f"{fmt(item['share_sign_agree'])}", flush=True)

    print("\n=== Reply-start concentration ===", flush=True)
    for trait in TRAITS:
        for adapter in (amp_name(trait), sup_name(trait)):
            item = results["reply_start"][trait][adapter]
            print(f"{trait:17s} {adapter:5s} median={fmt(item['selected']['median'])} "
                  f"random median={fmt(item['random']['median_mean'])}", flush=True)

    print("\n=== Weights predict activations ===", flush=True)
    for adapter in ADAPTERS:
        item = results["weights_vs_acts"][adapter]
        print(f"{adapter:5s} spearman={fmt(item['overall_spearman'])} "
              f"top1% precision={fmt(item['top1_precision'])} "
              f"below-median-weight share={fmt(item['top1_act_below_median_weight_share'])}", flush=True)

    print("\n=== Module edit profile ===", flush=True)
    for adapter in ADAPTERS:
        item = results["module_profile"][adapter]
        print(f"{adapter:5s} mlp={fmt(item['mlp_mean'], 4)} attn={fmt(item['attn_mean'], 4)} "
              f"attn share(mean)={fmt(item['attn_share_mean'])} "
              f"attn share(sum)={fmt(item['attn_share_sum'])}", flush=True)

    print("\n=== Atlas join ===", flush=True)
    for trait in TRAITS:
        item = results["atlas"][trait]
        selected = item["selected"]
        random = item["random"]
        print(f"{trait:17s} any-word={fmt(selected['any_trait_word_share'])}"
              f"/{fmt(random['any_trait_word_share_mean'])} "
              f"this-trait={fmt(selected['this_trait_word_share'])}"
              f"/{fmt(random['this_trait_word_share_mean'])} "
              f"sign-agree={fmt(selected['sign_agree_share'])}"
              f"/{fmt(random['sign_agree_share_mean'])} "
              f"rename={fmt(selected['rename_share'])}"
              f"/{fmt(random['rename_share_mean'])}", flush=True)


def write_outputs(out, results, layers, overlap, corr_hist, weights_rows, top_neurons):
    os.makedirs(out, exist_ok=True)
    results_path = os.path.join(out, "results.json")
    with open(results_path, "w") as handle:
        json.dump(to_jsonable(results), handle, indent=2)
    layers.to_csv(os.path.join(out, "layers.csv"), index=False)
    overlap.to_csv(os.path.join(out, "overlap.csv"), index=False)
    corr_hist.to_csv(os.path.join(out, "corr_hist.csv"), index=False)
    pd.DataFrame(weights_rows, columns=["adapter", "layer", "spearman"]).to_csv(
        os.path.join(out, "weights_vs_acts.csv"), index=False)
    top_neurons.to_csv(os.path.join(out, "top_neurons.csv"), index=False)
    print(f"wrote {results_path} and CSVs to {out}", flush=True)


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    print(f"loading {args.weights} and {args.acts}", flush=True)
    df = load_inputs(args.weights, args.acts, args.sample, args.seed)
    print(f"{len(df)} neurons across {df['layer'].nunique()} layers", flush=True)

    masks = selection_masks(df)
    selection = analyse_selection(df, masks, args.overlap_reps, args.seed)
    opposite = analyse_opposite(df, masks, args.reps, args.seed)
    cross_trait = analyse_cross_trait(df, masks)
    control_direction = analyse_control_direction(df, masks)
    reply_start = analyse_reply_start(df, masks, args.reps, args.seed)
    weights_vs_acts, weights_rows = analyse_weights_vs_acts(df)

    print(f"loading {args.weights}/modules.parquet and pairs.parquet", flush=True)
    modules = load_modules(args.weights)
    weight_pairs = load_weight_pairs(args.weights)
    module_profile = analyse_module_profile(modules)
    module_cosine = analyse_weight_cosines(weight_pairs)

    print(f"loading {args.lexicon} and {args.atlas}", flush=True)
    lex = load_lexicon(args.lexicon)
    atlas = load_atlas(args.atlas)
    atlas_join = analyse_atlas(df, masks, lex, atlas, args.reps, args.seed)
    top_neurons = build_top_neurons(df, masks, lex, atlas["label"], atlas["rename"])

    results = dict(
        model=MODEL,
        n_neurons=int(len(df)),
        n_all_neurons=N_ALL_NEURONS,
        n_layers=N_LAYERS,
        d_mlp=D_MLP,
        sample=args.sample,
        seed=args.seed,
        adapters=ADAPTERS,
        traits=TRAITS,
        selection=selection,
        opposite=opposite,
        cross_trait_corr=cross_trait,
        control_direction=control_direction,
        reply_start=reply_start,
        weights_vs_acts=weights_vs_acts,
        module_profile=module_profile,
        module_cosine=module_cosine,
        atlas=atlas_join,
        atlas_persona_sweep=atlas["sweep"],
    )

    layers = layers_frame(selection)
    overlap = overlap_frame(selection)
    corr_hist = corr_hist_frame(opposite)
    write_outputs(args.out, results, layers, overlap, corr_hist, weights_rows, top_neurons)
    print_report(results)


if __name__ == "__main__":
    main()
