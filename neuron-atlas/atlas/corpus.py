"""Build a small mixed text corpus (web prose + chat) as JSONL: {"id", "kind", "text"} or {"id", "kind", "messages"}.

    python -m atlas.corpus --out corpus.jsonl --web 1500 --chat 1000 --wildchat 1000 --lmsys 1000

Web docs come from FineWeb-Edu; chats from smol-smoltalk, WildChat and LMSYS-Chat. Chats are stored as message lists
so each model can render them with its own chat template.
"""
import argparse, json, itertools
from datasets import load_dataset


def build(n_web: int, n_chat: int, n_wildchat: int = 0, n_lmsys: int = 0, seed: int = 0):
    rows = []
    if n_web:
        web = load_dataset("HuggingFaceFW/fineweb-edu", name="sample-10BT", split="train", streaming=True)
        for r in itertools.islice(web.shuffle(seed=seed, buffer_size=5000), n_web):
            rows.append({"kind": "web", "source": "fineweb", "text": r["text"][:2000]})
    sources = [
        ("HuggingFaceTB/smol-smoltalk", n_chat, "smoltalk", "messages"),
        ("allenai/WildChat-1M", n_wildchat, "wildchat", "conversation"),
        ("lmsys/lmsys-chat-1m", n_lmsys, "lmsys", "conversation"),
    ]
    for name, n, source, key in sources:
        if not n:
            continue
        ds = load_dataset(name, split="train", streaming=True)
        stream = (r for r in ds.shuffle(seed=seed, buffer_size=5000) if not r.get("redacted"))
        for r in itertools.islice(stream, n):
            msgs = [{"role": m["role"], "content": m["content"][:1500]} for m in r[key] if m["role"] != "system"][:4]
            if msgs:
                rows.append({"kind": "chat", "source": source, "messages": msgs})
    for i, r in enumerate(rows):
        r["id"] = i
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="corpus.jsonl")
    ap.add_argument("--web", type=int, default=1500)
    ap.add_argument("--chat", type=int, default=1000)
    ap.add_argument("--wildchat", type=int, default=0)
    ap.add_argument("--lmsys", type=int, default=0)
    a = ap.parse_args()
    rows = build(a.web, a.chat, a.wildchat, a.lmsys)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} docs to {a.out}")
