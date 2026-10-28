"""General steering programs: neuronary recipes are the plain add/set/mul, resid, all, const case.

    {"name": "warmer", "terms": [{"layer": 13, "neuron": 7956, "value": 0.7},
                                 {"layer": 14, "neuron": 8949, "op": "mul", "value": 1.2,
                                  "when": "gen", "schedule": "decay:8"}]}
"""
import json
import duckdb

from . import neurons_src
from .model import format_recipe, parse_recipe

OPS = ("add", "set", "mul", "mean")
UNITS = ("resid", "std", "max", "raw")


def _term(t):
    d = {"layer": int(t["layer"]), "neuron": int(t["neuron"]), "op": t.get("op", "add"),
         "value": float(t.get("value", 0.0)), "unit": t.get("unit", "resid"),
         "when": t.get("when", "all"), "schedule": t.get("schedule", "const")}
    if d["op"] not in OPS:
        raise ValueError(f"unknown program op {d['op']!r}")
    if d["unit"] not in UNITS:
        raise ValueError(f"unknown program unit {d['unit']!r}")
    return d


def _program(p):
    return {"name": p.get("name", ""), "terms": [_term(t) for t in p.get("terms", [])]}


def from_recipe(text, name=""):
    """Neuronary string -> program with plain add/set/mul, resid units."""
    return {"name": name, "terms": [
        {"layer": L, "neuron": n, "op": op, "value": float(v), "unit": "resid",
         "when": "all", "schedule": "const"} for L, n, op, v in parse_recipe(text)]}


def to_recipe(program):
    """Back to a neuronary string when every term is plain; otherwise None."""
    terms = []
    for t in program.get("terms", []):
        t = _term(t)
        if t["op"] not in ("add", "set", "mul") or t["unit"] != "resid" or t["when"] != "all" \
                or t["schedule"] != "const":
            return None
        terms.append((t["layer"], t["neuron"], t["op"], t["value"]))
    return format_recipe(terms)


def load_programs(path):
    """JSON list of programs (strings are recipes), or {"programs": [...]}."""
    data = json.load(open(path))
    items = data.get("programs", []) if isinstance(data, dict) else data
    return [from_recipe(x) if isinstance(x, str) else _program(x) for x in items]


def scale(program, s):
    """Scale add/set doses, and mul gaps: v -> 1 + (v - 1) * s."""
    out = {"name": program.get("name", ""), "terms": []}
    for t in program.get("terms", []):
        t = _term(t)
        if t["op"] in ("add", "set"):
            t["value"] *= s
        elif t["op"] == "mul":
            t["value"] = 1 + (t["value"] - 1) * s
        out["terms"].append(t)
    return out


def neuron_stats(atlas, keys):
    """{(layer, neuron): (mean, std, max)} for the given keys, read from the atlas neuron table."""
    keys = list(dict.fromkeys((int(L), int(n)) for L, n in keys))
    out = {}
    if not keys:
        return out
    src = neurons_src(atlas)
    for i in range(0, len(keys), 1000):
        part = keys[i:i + 1000]
        vals = ",".join(f"({L},{n})" for L, n in part)
        q = f"select layer, neuron, mean, std, max from {src} where (layer, neuron) in ({vals})"
        for L, n, m, s, mx in duckdb.sql(q).fetchall():
            out[(int(L), int(n))] = (float(m), float(s), float(mx))
    return out
