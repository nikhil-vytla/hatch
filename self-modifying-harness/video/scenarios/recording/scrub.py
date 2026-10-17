# scrub.py CAST: replace this machine's paths in a recording with neutral ones of the same width, so the replayed
# screens line up exactly as recorded. Keeps the original as CAST.raw the first time.
import json, os, re, shutil, sys
cast = sys.argv[1]
raw = cast + ".raw"
if not os.path.exists(raw): shutil.copy(cast, raw)
lines = open(raw).read().splitlines()
pattern = re.compile(r"/tmp/claude-0/[^\x1b\r\n| \"']*|/home/user/hatch/[^\x1b\r\n| \"']*")
def neutral(m):
    s = m.group(0)
    name = "./data" + ("..." if s.endswith("...") else "")
    return name.ljust(len(s)) if len(s) >= len(name) else name[: len(s)]
out = [lines[0]]
for l in lines[1:]:
    ev = json.loads(l)
    ev[2] = pattern.sub(neutral, ev[2])
    out.append(json.dumps(ev, ensure_ascii=False, separators=(",", ":")))
open(cast, "w").write("\n".join(out) + "\n")
left = sum(1 for l in out if "/tmp/claude" in l or "/home/user" in l or "scratchpad" in l)
print(cast, "scrubbed; lines still mentioning a local path:", left)
