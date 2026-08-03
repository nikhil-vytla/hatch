"""Grader: DB query task. Checks the report and, because the final DB file
is part of the captured state, verifies it independently. This grader is
the demonstration that grading works from filesystem state alone."""
import os
import sqlite3
import sys

work = sys.argv[1]
score = 0.0

report = os.path.join(work, "top_customers.txt")
rows = []
if os.path.isfile(report):
    for line in open(report):
        parts = line.split()
        if len(parts) == 2:
            rows.append((parts[0], float(parts[1])))
if len(rows) == 5 and all(rows[i][1] >= rows[i + 1][1] for i in range(4)):
    score += 0.5

db = os.path.join(work, "shop.db")
if rows and os.path.isfile(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    truth = con.execute("SELECT cust, ROUND(SUM(amt),2) s FROM orders "
                        "GROUP BY cust ORDER BY s DESC LIMIT 5").fetchall()
    if [(c, round(s, 2)) for c, s in rows] == \
       [(c, round(s, 2)) for c, s in truth]:
        score += 0.5
print(score)
