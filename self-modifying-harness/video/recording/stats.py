# stats.py CAST DATA_DIR -> writes CAST-stem.stats.json for the closing card. Counts come from the transcript the TUI
# prints when it exits; the tools and their versions come from the forge's own catalog (session.sqlite).
import json, re, sys, sqlite3
cast, data = sys.argv[1], sys.argv[2]
lines = open(cast).read().splitlines()
events = [json.loads(l) for l in lines[1:]]
text = "".join(e[2] for e in events)
tail = text[text.rfind("\x1b[?1049l"):]
plain = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]", "", tail)
accepted = len(re.findall(r"result ACCEPTED", plain))
rejected = len(re.findall(r"result REJECTED", plain))
refused = len(re.findall(r"result REFUSED", plain))
footers = re.findall(r"(\d+)/\d+ calls \$([0-9.]+)", text)
calls = footers[-1] if footers else None
import os
tools = sorted(f[: -len(".sqlite")] for f in os.listdir(os.path.join(data, "cells", "state")) if f.endswith(".sqlite"))
real = events[-1][0] if events else 0
stats = [
    ["messages typed", "5"],
    ["tools it grew", ", ".join(tools)],
    ["versions accepted by the gate", str(accepted)],
    ["proposals rejected", str(rejected + refused)],
    ["model calls (most are memory)", calls[0] if calls else "?"],
    ["cost", f"${float(calls[1]):.3f}" if calls else "?"],
    ["real time", f"{int(real // 60)} min {int(real % 60)} s"],
]
print(json.dumps(stats, indent=1))
json.dump(stats, open(cast[: -len(".cast")] + ".stats.json", "w"))
