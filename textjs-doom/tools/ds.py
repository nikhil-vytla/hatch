#!/usr/bin/env python3
"""Delegate a coding task to deepseek-flash (DeepSeek-V4.1-Flash, OpenAI-compatible API).
The session proxy injects the real API key; "dummy" is a placeholder.
   ds.py TASK_FILE [CONTEXT_FILE ...] > answer.md
TASK_FILE holds the instructions; each CONTEXT_FILE is appended verbatim with its path."""
import json, sys, urllib.request
task = open(sys.argv[1]).read()
ctx = "".join(f"\n\n=== FILE: {p} ===\n{open(p).read()}" for p in sys.argv[2:])
body = {"model": "deepseek-flash", "max_tokens": 32000,
        "messages": [{"role": "system", "content": "You are a careful senior engineer. Output only what is asked: complete files in fenced code blocks labeled with their path, or a unified diff if asked. No commentary unless asked."},
                     {"role": "user", "content": task + ctx}]}
req = urllib.request.Request("https://api.deepseek.com/chat/completions", json.dumps(body).encode(),
                             {"Content-Type": "application/json", "Authorization": "Bearer dummy"})
r = json.load(urllib.request.urlopen(req, timeout=600))
print(r["choices"][0]["message"]["content"])
u = r.get("usage", {}); print(f"[deepseek-flash tokens in={u.get('prompt_tokens')} out={u.get('completion_tokens')}]", file=sys.stderr)
