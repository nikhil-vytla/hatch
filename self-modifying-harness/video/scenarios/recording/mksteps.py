import json, sys
steps = [["wait", 4], ["snap", "Starting forge: a fresh session on deepseek-flash"]]
for line in open(sys.argv[1]):
    if not line.strip(): continue
    title, text = line.rstrip("\n").split("|", 1)
    steps += [["snap", title], ["type", text + "\r"], ["until", "ready |", 900], ["wait", 2]]
steps += [["snap", "Done"], ["wait", 2], ["type", "/quit\r"], ["wait", 4]]
print(json.dumps(steps))
