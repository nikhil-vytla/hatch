"""Gemma 4 E4B audio-encoder pushes: what does the model hear when one audio-tower neuron is pushed?

Judge-free. Each answer to "What do you hear?" is normalized ("I hear the sound of rain." -> "rain"). Per push:
changed = the normalized answer differs from the unpushed answer for that clip. Per neuron and dose: the modal pushed
answer across the 22 clips and how many clips it takes over (clips whose unpushed answer was something else), i.e.
whether one neuron forces one sound onto everything. Writes the experiment summary and site/hear.json for the page.

  python analysis/gemma_audio.py OUT_DIR
"""
import collections, json, os, re, sys

import duckdb
from huggingface_hub import HfApi, hf_hub_download

R, M = "nikhilxvytla/neuron-atlas", "google__gemma-4-E4B-it"
URL = f"https://huggingface.co/datasets/{R}/resolve/main/{M}/audio/stimuli/"


def norm(t):
    t = t.strip().lower()
    t = re.sub(r"^(?:i (?:can )?hear|it sounds like|this (?:is|sounds like)|that sounds like)\s+", "", t)
    t = re.sub(r"^(?:the )?sounds? of\s+", "", t)
    t = re.sub(r"^(?:a|an|the|some)\s+", "", t)
    return re.sub(r"[.!?\s]+$", "", t)[:60]


# what counts as hearing an ESC-50 clip correctly (class -> words)
OK = {"dog": r"\bdog|bark", "rooster": r"rooster|crow", "rain": r"\brain", "siren": r"siren", "church": r"bell",
      "crying": r"cry|crying|wail", "clock": r"tick|clock", "door": r"knock", "laughing": r"laugh", "engine": r"engine|motor",
      "cat": r"\bcat|meow", "thunderstorm": r"thunder|storm", "sea": r"wave|ocean|\bsea\b|surf", "chirping": r"bird|chirp|tweet",
      "keyboard": r"typing|keyboard", "car": r"horn|\bcar\b"}


def correct(stim, text):
    pat = OK.get(stim["expected"]) if stim["kind"] == "esc50" else None
    return None if pat is None else bool(re.search(pat, text, re.I))


def main(out):
    os.makedirs(out, exist_ok=True)
    files = [f for f in HfApi().list_repo_files(R, repo_type="dataset") if f.startswith(f"{M}/audio/vlm/") and f.endswith(".parquet")]
    rows = []
    for f in files:
        rows += duckdb.sql(f"select id, expected, layer, neuron, dose, text from '{hf_hub_download(R, f, repo_type='dataset')}'").fetchall()
    stim = json.load(open(hf_hub_download(R, f"{M}/audio/stimuli/stimuli.json", repo_type="dataset")))
    base = {i: t for i, e, L, n, d, t in rows if L < 0}
    bn = {i: norm(t) for i, t in base.items()}
    groups = collections.defaultdict(dict)
    by_layer = collections.defaultdict(lambda: [0, 0])
    for i, e, L, n, d, t in rows:
        if L < 0:
            continue
        groups[(L, n, d)][i] = t
        by_layer[L][0] += norm(t) != bn[i]; by_layer[L][1] += 1
    summary = []
    for (L, n, d), rep in groups.items():
        labs = collections.Counter(norm(t) for i, t in rep.items() if norm(t) != bn[i])
        top, k = (labs.most_common(1)[0] if labs else ("", 0))
        changed = sum(norm(t) != bn[i] for i, t in rep.items())
        summary.append(dict(layer=L, neuron=n, dose=d, changed=changed, n=len(rep), forced=top, forced_k=k,
                            replies={i: t[:120] for i, t in rep.items()}))
    summary.sort(key=lambda g: (-g["forced_k"], -g["changed"]))
    sd = {x["id"]: x for x in stim}
    fix = brk = n_esc = 0
    for g in summary:
        for i, t in g["replies"].items():
            b, p = correct(sd[i], base[i]), correct(sd[i], t)
            if b is None:
                continue
            n_esc += 1; fix += (not b) and p; brk += b and (not p)
    base_acc = [correct(sd[i], t) for i, t in base.items() if correct(sd[i], t) is not None]
    res = dict(model="google/gemma-4-E4B-it", question=stim[0]["question"], n_pushes=sum(g["n"] for g in summary),
               changed=sum(g["changed"] for g in summary),
               by_layer={L: dict(changed=a, n=b) for L, (a, b) in sorted(by_layer.items())},
               stimuli=[dict(id=s["id"], kind=s["kind"], expected=s["expected"], url=URL + s["file"], baseline=base.get(s["id"], ""))
                        for s in stim],
               esc=dict(base_correct=sum(base_acc), of=len(base_acc), pushes=n_esc, fixed=fix, broke=brk),
               groups=summary)
    json.dump(res, open(os.path.join(out, "hear.json"), "w"))
    print(f"{res['changed']} of {res['n_pushes']} pushes change what it hears")
    print({L: round(v["changed"] / v["n"], 3) for L, v in res["by_layer"].items()})
    print("ESC-50:", res["esc"])
    for g in summary[:15]:
        print(g["layer"], g["neuron"], g["dose"], g["changed"], "forced:", repr(g["forced"]), g["forced_k"])


if __name__ == "__main__":
    main(sys.argv[1])
