"""Grader: numeric solve task. Dependency-free: checks the residual claim
and the npy artifact's magic header rather than importing numpy."""
import os
import sys

work = sys.argv[1]
score = 0.0

res = os.path.join(work, "residual.txt")
try:
    if float(open(res).read().strip()) < 1e-8:
        score += 0.5
except (OSError, ValueError):
    pass

sol = os.path.join(work, "solution.npy")
if os.path.isfile(sol):
    with open(sol, "rb") as f:
        if f.read(6) == b"\x93NUMPY":
            score += 0.5
print(score)
