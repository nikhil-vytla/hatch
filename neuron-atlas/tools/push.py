"""Push one MLP neuron, or a small recipe, while a chat model answers — a single-file neuron-atlas reproduction.
Rule: add dose * median|resid_L| / |W_down[:, n]| to the neuron, at every position. Three atlas examples:
  Qwen/Qwen3-8B     L8N7846+0.5   "Who are you?"  -> the Dickens / Victorian-literature neuron ("I am a ghost ... Scrooge")
  Qwen/Qwen3.5-4B   L3N2410-0.8   "Who am I?"     -> the "You are Qwen3.5, the large language model ..." role swap
  Qwen/Qwen3.5-4B   L15N4041+0.8  neuronary's Jesus recipe
  python push.py --model Qwen/Qwen3.5-4B --recipe "L3N2410-0.8" --prompt "Who am I?"
  python push.py --model Qwen/Qwen3-8B --recipe "L8N7846+0.5" --prompt "Who are you?"
  python push.py --program program.json --prompt "Who are you?"
"""
import argparse, json, re, torch
from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer
from huggingface_hub import hf_hub_download
try: from transformers import AutoModelForImageTextToText
except ImportError: AutoModelForImageTextToText = None
REPO = "nikhilxvytla/neuron-atlas"
ATLAS_MODELS = ["HuggingFaceTB/SmolLM2-135M-Instruct", "Qwen/Qwen3-0.6B", "Qwen/Qwen3.5-4B", "Qwen/Qwen3-8B", "openai-community/gpt2"]
DOWN_RE = re.compile(r"\.(\d+)\.mlp\.(down_proj|c_proj|fc2|dense_4h_to_h)$")
TERM_RE = re.compile(r"L(\d+)N(\d+)\s*([=*+\-])?\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)", re.I)
SKIP = ("visual", "vision", "audio", "mm_projector")
def fail(msg): raise SystemExit(msg)
def find_downs(model):
    found = sorted(((int(m.group(1)), mod) for name, mod in model.named_modules()
                    if (m := DOWN_RE.search(name)) and ".experts." not in name
                    and not any(t in name.lower() for t in SKIP)), key=lambda x: x[0])
    if not found: fail("no dense MLP down projections found (MoE models are not supported)")
    return [mod for _, mod in found]
def recipe_terms(text):
    out = []
    for m in TERM_RE.finditer(text or ""):
        op = {"=": "set", "*": "mul", "-": "add", "+": "add", None: "add"}[m.group(3)]
        value = float(m.group(4))
        if m.group(3) == "-": value = -abs(value)
        out.append({"layer": int(m.group(1)), "neuron": int(m.group(2)), "op": op, "value": value,
                    "unit": "resid", "when": "all", "schedule": "const"})
    return out
def load_program(path):
    data = json.load(open(path))
    data = data.get("programs", data) if isinstance(data, dict) else data
    if isinstance(data, list):
        if not data: fail("empty program file")
        data = data[0]
    return [{"layer": int(t["layer"]), "neuron": int(t["neuron"]), "op": t.get("op", "add"), "value": float(t.get("value", 0.0)), "unit": t.get("unit", "resid"), "when": t.get("when", "all"), "schedule": t.get("schedule", "const")} for t in data.get("terms", [])]
class Steer:
    def __init__(self, model):
        self.downs = find_downs(model); self.handles = []
        self.norms = [(m.weight.float().norm(dim=1) if type(m).__name__ == "Conv1D" else m.weight.float().norm(dim=0)).cpu() for m in self.downs]
    def set(self, terms):
        self.clear(); groups = {}
        for t in terms: groups.setdefault(t["layer"], []).append((t["neuron"], t["coef"]))
        for layer, items in groups.items():
            def hook(mod, args, items=items):
                x = args[0].clone()
                for neuron, coef in items: x[:, :, neuron] += coef
                return (x,) + tuple(args[1:])
            self.handles.append(self.downs[layer].register_forward_pre_hook(hook))
    def clear(self):
        for h in self.handles: h.remove()
        self.handles = []
def compile_terms(raw, resid, norms):
    out = []
    for t in raw:
        layer, neuron, op = int(t["layer"]), int(t["neuron"]), t.get("op", "add")
        unit, when, schedule = t.get("unit", "resid"), t.get("when", "all"), t.get("schedule", "const")
        for key, val, ok in (("op", op, ("add", "sub")), ("unit", unit, ("resid", "raw")),
                             ("when", when, ("all",)), ("schedule", schedule, ("const",))):
            if val not in ok: fail(f'{key} "{val}" not supported in push.py, use atlas.steer')
        if not 0 <= layer < len(norms) or not 0 <= neuron < norms[layer].numel():
            fail(f"L{layer}N{neuron} is outside this model")
        coef = float(t.get("value", 0.0)) * (-1 if op == "sub" else 1)
        if unit == "resid": coef *= float(resid[layer]) / float(norms[layer][neuron])
        out.append({"layer": layer, "neuron": neuron, "coef": coef})
    return out
def load_model(name):
    device = ("cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    try: tok = AutoTokenizer.from_pretrained(name)
    except Exception:
        proc = AutoProcessor.from_pretrained(name); tok = getattr(proc, "tokenizer", None) or proc
    if tok.pad_token is None: tok.pad_token = tok.eos_token
    try: model = AutoModelForCausalLM.from_pretrained(name, dtype=dtype)
    except Exception:
        if AutoModelForImageTextToText is None: raise
        model = AutoModelForImageTextToText.from_pretrained(name, dtype=dtype)
    return model.to(device).eval().requires_grad_(False), tok, device
def load_resid_median(name):
    try:
        path = hf_hub_download(REPO, f"{name.replace('/', '__')}/meta.json", repo_type="dataset")
        return [float(x) for x in json.load(open(path))["resid_median"]]
    except Exception: return None
def parse_resid(text, n):
    try: vals = json.loads(text)
    except Exception: vals = [float(x) for x in text.split(",") if x.strip()]
    if isinstance(vals, (int, float)): vals = [float(vals)]
    vals = [float(x) for x in vals]
    if len(vals) == 1: vals *= n
    if len(vals) != n: fail(f"--resid-median needs 1 or {n} values, got {len(vals)}")
    return vals
@torch.no_grad()
def estimate_resid_median(model, tok, device, text):
    enc = tok(text, return_tensors="pt", add_special_tokens=False).to(device)
    hs = model(**enc, output_hidden_states=True, use_cache=False).hidden_states[1:]
    return [float((h[0, 2:] if h.shape[1] > 2 else h[0]).float().norm(dim=-1).median()) for h in hs]
def chat_prompt(tok, user):
    return (tok.apply_chat_template([{"role": "user", "content": user}], tokenize=False, add_generation_prompt=True,
                                    enable_thinking=False) if tok.chat_template else f"User: {user}\n\nAssistant:")
@torch.no_grad()
def generate(model, tok, device, text, max_new):
    enc = tok([text], return_tensors="pt", add_special_tokens=False).to(device)
    out = model.generate(**enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                         pad_token_id=tok.pad_token_id)
    return tok.decode(out[0, enc["input_ids"].shape[1]:], skip_special_tokens=True)
def main():
    ap = argparse.ArgumentParser(description="Push MLP neurons while a chat model answers.")
    ap.add_argument("--model", default="Qwen/Qwen3.5-4B"); ap.add_argument("--recipe", help='e.g. "L3N2410-0.8"')
    ap.add_argument("--program", metavar="FILE", help="JSON steering program (atlas/program.py format)"); ap.add_argument("--prompt", default="Who are you?")
    ap.add_argument("--max-new", type=int, default=64); ap.add_argument("--resid-median", help="per-layer values: JSON list, comma list, or one value")
    ap.add_argument("--interactive", action="store_true", help="REPL: prompt per line, :recipe, :quit")
    a = ap.parse_args()
    if not a.recipe and not a.program: ap.error("give --recipe or --program")
    print(f"loading {a.model} ...", flush=True)
    model, tok, device = load_model(a.model); steer = Steer(model)
    if a.resid_median:
        resid = parse_resid(a.resid_median, len(steer.downs)); print("using --resid-median", flush=True)
    else:
        resid = load_resid_median(a.model)
        if resid is None:
            resid = estimate_resid_median(model, tok, device, chat_prompt(tok, a.prompt))
            print("no published atlas meta for this model: estimated resid_median from the prompt", flush=True)
        else: print("using the published atlas resid_median", flush=True)
    resid = ([float(x) for x in resid] + [float(resid[-1])] * len(steer.downs))[:len(steer.downs)]
    raw = recipe_terms(a.recipe) if a.recipe else load_program(a.program)
    terms = compile_terms(raw, resid, steer.norms)
    def run(prompt):
        text = chat_prompt(tok, prompt); steer.clear()
        normal = generate(model, tok, device, text, a.max_new)
        steer.set(terms); pushed = generate(model, tok, device, text, a.max_new); steer.clear()
        print(f"\nprompt: {prompt}\nnormal: {normal}\n\npushed: {pushed}\n", flush=True)
    if not a.interactive:
        run(a.prompt); return
    print("Type a prompt; ':recipe L3N2410-0.8' changes the recipe; ':quit' exits.")
    while True:
        try: line = input("> ")
        except (EOFError, KeyboardInterrupt): break
        if line.strip() == ":quit": break
        if line.startswith(":recipe"):
            raw = recipe_terms(line[7:].strip()); terms = compile_terms(raw, resid, steer.norms)
            print("recipe:", line[7:].strip() or "(none)", flush=True)
        elif line.strip(): run(line)
if __name__ == "__main__": main()
