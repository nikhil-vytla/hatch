"""Grader: dataframe pipeline task. Reads only final filesystem state."""
import csv
import os
import sys

work = sys.argv[1]
path = os.path.join(work, "store_summary.csv")
if not os.path.isfile(path):
    print(0.0)
    raise SystemExit

with open(path) as f:
    reader = csv.reader(f)
    header = next(reader, [])
    rows = list(reader)

score = 0.0
if header[:1] == ["store"] and {"sum", "mean", "count"} <= set(header):
    score += 0.25
if len(rows) == 10:
    score += 0.25
try:
    sums = [float(r[header.index("sum")]) for r in rows]
    if all(sums[i] >= sums[i + 1] for i in range(len(sums) - 1)):
        score += 0.5
except (ValueError, IndexError):
    pass
print(score)
