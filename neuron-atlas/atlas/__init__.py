import os


def neurons_src(atlas: str) -> str:
    """DuckDB source for an atlas's neuron table: the single local file, or the per-layer shards that
    `atlas.export` publishes (neurons/Lxx.parquet)."""
    one = os.path.join(atlas, "neurons.parquet")
    return f"'{one}'" if os.path.exists(one) else f"'{os.path.join(atlas, 'neurons', '*.parquet')}'"
