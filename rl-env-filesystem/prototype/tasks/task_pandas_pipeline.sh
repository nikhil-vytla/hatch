#!/bin/sh
# Stand-in agent task: dataframe pipeline against the dependency layer.
# Touches pandas (which drags in most of numpy too).
set -e
mkdir -p /work
PYTHONPATH=/opt/pylibs /usr/local/bin/python3 - << 'EOF'
import numpy as np
import pandas as pd
rng = np.random.default_rng(5)
df = pd.DataFrame({
    "store": rng.integers(1, 40, 50000),
    "sku": rng.integers(1, 500, 50000),
    "qty": rng.integers(1, 20, 50000),
    "price": rng.uniform(1, 80, 50000).round(2),
})
df["revenue"] = df.qty * df.price
summary = (df.groupby("store").revenue.agg(["sum", "mean", "count"])
             .sort_values("sum", ascending=False))
summary.head(10).to_csv("/work/store_summary.csv")
print(summary.head(3))
EOF
