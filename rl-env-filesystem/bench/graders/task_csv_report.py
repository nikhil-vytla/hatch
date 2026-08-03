"""Grader: CSV report task. Reads only final filesystem state.
Contract: print reward in [0,1] on the last stdout line."""
import os
import re
import sys

work = sys.argv[1]
path = os.path.join(work, "report.txt")
if not os.path.isfile(path):
    print(0.0)
    raise SystemExit

pat = re.compile(r"^([NESW]) total=(\d+\.\d+) mean=(\d+\.\d+) stdev=(\d+\.\d+)$")
good = 0
seen = set()
with open(path) as f:
    for line in f:
        m = pat.match(line.strip())
        if m and m.group(1) not in seen and float(m.group(2)) > 0:
            seen.add(m.group(1))
            good += 1
print(good / 4)
