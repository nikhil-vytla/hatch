#!/bin/sh
# Stand-in agent task: seed a relational DB, run queries, write results.
# The final DB file in /work is exactly what a grader would inspect.
set -e
mkdir -p /work
/usr/local/bin/python3 - << 'EOF'
import sqlite3, random
random.seed(11)
con = sqlite3.connect("/work/shop.db")
con.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, cust TEXT, amt REAL)")
con.executemany("INSERT INTO orders (cust, amt) VALUES (?, ?)",
                [(f"c{random.randint(1,200)}", round(random.uniform(5, 500), 2))
                 for _ in range(30000)])
con.commit()
top = con.execute("SELECT cust, SUM(amt) s FROM orders GROUP BY cust "
                  "ORDER BY s DESC LIMIT 5").fetchall()
with open("/work/top_customers.txt", "w") as f:
    for cust, s in top:
        f.write(f"{cust} {s:.2f}\n")
print(open("/work/top_customers.txt").read())
EOF
