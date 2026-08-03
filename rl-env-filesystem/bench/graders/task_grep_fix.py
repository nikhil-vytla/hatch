"""Grader: code search + edit task. Reads only final filesystem state."""
import os
import sys

work = sys.argv[1]
score = 0.0

hits = os.path.join(work, "hits.txt")
if os.path.isfile(hits) and any(
        "bisect" in line for line in open(hits, errors="replace")):
    score += 0.5

patched = os.path.join(work, "bisect_patched.py")
if os.path.isfile(patched):
    text = open(patched, errors="replace").read()
    if "def bisect_right_patched" in text:
        score += 0.5
print(score)
