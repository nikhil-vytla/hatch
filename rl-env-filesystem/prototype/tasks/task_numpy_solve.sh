#!/bin/sh
# Stand-in agent task: numeric work against the dependency layer.
# Touches numpy's shared objects but none of pandas.
set -e
mkdir -p /work
PYTHONPATH=/opt/pylibs /usr/local/bin/python3 - << 'EOF'
import numpy as np
rng = np.random.default_rng(3)
a = rng.standard_normal((400, 400))
b = rng.standard_normal(400)
x = np.linalg.solve(a, b)
residual = float(np.abs(a @ x - b).max())
np.save("/work/solution.npy", x)
with open("/work/residual.txt", "w") as f:
    f.write(f"{residual:.3e}\n")
print("residual", residual)
EOF
