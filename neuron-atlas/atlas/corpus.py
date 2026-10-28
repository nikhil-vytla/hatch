"""Build a small mixed text corpus (web prose + chat) as JSONL: {"id", "kind", "text"} or {"id", "kind", "messages"}.

    python -m atlas.corpus --out corpus.jsonl --web 1500 --chat 1000

Web docs come from FineWeb-Edu, chats from smol-smoltalk. Chats are stored as message lists so each model can
render them with its own chat template.
"""
import argparse, json, itertools
from datasets import load_dataset


def build(n_web: int, n_chat: int, seed: int = 0):
    rows = []
    web = load_dataset("HuggingFaceFW/fineweb-edu", name="sample-10BT", split="train", streaming=True)
    for r in itertools.islice(web.shuffle(seed=seed, buffer_size=5000), n_web):
        rows.append({"kind": "web", "text": r["text"][:2000]})
    chat = load_dataset("HuggingFaceTB/smol-smoltalk", split="train", streaming=True)
    for r in itertools.islice(chat.shuffle(seed=seed, buffer_size=5000), n_chat):
        msgs = [{"role": m["role"], "content": m["content"][:1500]} for m in r["messages"] if m["role"] != "system"][:4]
        if msgs:
            rows.append({"kind": "chat", "messages": msgs})
    for i, r in enumerate(rows):
        r["id"] = i
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="corpus.jsonl")
    ap.add_argument("--web", type=int, default=1500)
    ap.add_argument("--chat", type=int, default=1000)
    a = ap.parse_args()
    rows = build(a.web, a.chat)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} docs to {a.out}")
