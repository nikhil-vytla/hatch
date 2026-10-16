# events.py SCENARIO_DIR -> SCENARIO_DIR/session.events.json
# Timed events for the video, from the forge's own OptChat chat log (every entry carries its date) and the cast header
# (the recording's start, in whole seconds). Kinds: propose, verdict (accepted/rejected with the gate stage that decided
# it), art (a tool result that is an ASCII drawing).
import glob, json, os, re, sys
from datetime import datetime

d = sys.argv[1]
cast = os.path.join(d, "session.cast")
t0 = json.loads(open(cast).readline())["timestamp"]
entries = []
for f in sorted(glob.glob(os.path.join(d, "data", "chat", "main", "*.jsonl"))):
    for line in open(f):
        try: entries.append(json.loads(line))
        except Exception: pass
entries.sort(key=lambda e: e["i"])

def secs(e):
    return datetime.fromisoformat(e["date"].replace("Z", "+00:00")).timestamp() - t0

KERNEL = {"cell_propose", "cell_rollback", "cell_list", "cell_source", "zoom", "date", "result_read", "result_grep", "result_query"}

def stage_of(reason):
    r = reason.lower()
    if r.startswith("stale"): return "stale"
    if "do not exercise" in r: return "coverage"
    if r.startswith("replay"): return "replay"
    if r.startswith("fuzz"): return "fuzz"
    if "rule " in r or "never fails" in r: return "properties"
    if "invariant" in r: return "invariants"
    if "migration" in r: return "migration"
    if "you sent this exact" in r or "refused" in r: return "repeat"
    return "checks"

def strings(v):
    if isinstance(v, str): yield v
    elif isinstance(v, list):
        # a grid returned as a list of row strings is a drawing too
        if len(v) >= 3 and all(isinstance(x, str) and "\n" not in x for x in v): yield "\n".join(v)
        for x in v: yield from strings(x)
    elif isinstance(v, dict):
        for x in v.values(): yield from strings(x)

def art_of(text):
    """The longest multi-line string in a tool result that looks like a drawing."""
    try: values = list(strings(json.loads(text)))
    except Exception: values = [text]
    best = None
    for s in values:
        lines = [l.rstrip() for l in s.split("\n")]
        while lines and not lines[-1]: lines.pop()
        if len(lines) < 3: continue
        drawn = sum(1 for l in lines if re.search(r"[#.@^█▁▂▃▄▅▆▇|*=-]{3,}", l))
        if drawn >= 2 and (best is None or len(lines) > len(best)): best = lines
    return best

events, last_tool = [], None
for e in entries:
    t = round(secs(e), 3)
    if e["kind"] == "tool":
        name, _, rest = e["text"].partition(" ")
        last_tool = name
        if name == "cell_propose":
            m = re.search(r'"name"\s*:\s*"([^"]+)"', rest)
            events.append({"t": t, "kind": "propose", "cell": m.group(1) if m else "?"})
    elif e["kind"] == "echo":
        text = e["text"]
        m = re.match(r"(ACCEPTED|REJECTED)\s+([A-Za-z0-9_-]+)@([0-9a-f]+)[ :]*(.*)", text, re.S)
        if m:
            ok = m.group(1) == "ACCEPTED"
            checks = re.search(r"passed (\d+) checks", text)
            events.append({"t": t, "kind": "verdict", "ok": ok, "cell": m.group(2), "version": m.group(3),
                           "stage": "accepted" if ok else stage_of(m.group(4)),
                           "detail": (f"{checks.group(1)} checks" if ok and checks else m.group(4).split(". The live")[0])[:150]})
        elif re.match(r"REJECTED:|REFUSED:", text):
            events.append({"t": t, "kind": "verdict", "ok": False, "cell": "?", "version": "", "stage": "repeat", "detail": text[:150]})
        elif last_tool and last_tool not in KERNEL:
            art = art_of(text)
            if art: events.append({"t": t, "kind": "art", "tool": last_tool, "lines": art[:24]})
json.dump(events, open(os.path.join(d, "session.events.json"), "w"), indent=1)
print(len(events), "events:", ", ".join(f'{e["kind"]}' for e in events[:40]))
