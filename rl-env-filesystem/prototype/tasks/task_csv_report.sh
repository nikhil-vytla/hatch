#!/bin/sh
# Stand-in agent task: seed a CSV dataset, then compute a stats report with
# the standard library. Mimics setup phase (seed) + agent phase (work).
set -e
mkdir -p /work
/usr/local/bin/python3 - << 'EOF'
import csv, random
random.seed(7)
with open("/work/sales.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["region", "product", "units", "price"])
    for i in range(20000):
        w.writerow([random.choice("NESW"), f"p{i%50}",
                    random.randint(1, 90), round(random.uniform(2, 300), 2)])
EOF
/usr/local/bin/python3 - << 'EOF'
import csv, statistics
from collections import defaultdict
rev = defaultdict(list)
with open("/work/sales.csv") as f:
    for row in csv.DictReader(f):
        rev[row["region"]].append(int(row["units"]) * float(row["price"]))
with open("/work/report.txt", "w") as out:
    for region in sorted(rev):
        vals = rev[region]
        out.write(f"{region} total={sum(vals):.2f} "
                  f"mean={statistics.mean(vals):.2f} "
                  f"stdev={statistics.stdev(vals):.2f}\n")
print(open("/work/report.txt").read())
EOF
