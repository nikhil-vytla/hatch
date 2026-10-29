"""Thin adapter over Hugging Face causal LMs: find each layer's MLP down projection, read and push its neurons.

A "neuron" is one input channel of the MLP down projection (down_proj / c_proj / fc2 / dense_4h_to_h). Its
activation is what enters that projection; its output direction is the matching column of the weight. This covers
Llama, Qwen2/3, Mistral, OLMo, Gemma, SmolLM (gated: act(gate)·up) and GPT-2/GPT-NeoX/Phi (act(fc1)).
"""
import re
import torch
from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer

try:
    from transformers import AutoModelForImageTextToText
except ImportError:  # older transformers: image-text checkpoints will fail at load time
    AutoModelForImageTextToText = None

DOWN_RE = re.compile(r"\.(\d+)\.mlp\.(down_proj|c_proj|fc2|dense_4h_to_h)$")
TERM_RE = re.compile(r"L(\d+)N(\d+)\s*([=*+\-])?\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)", re.I)
SKIP_TOWERS = ("visual", "vision", "audio", "mm_projector")


def parse_recipe(text):
    """'L13N7956-0.7 L14N8949+0.7' -> [(13, 7956, 'add', -0.7), (14, 8949, 'add', 0.7)].

    The op is + (add), = (set) or * (multiply); a bare number means add."""
    out = []
    for m in TERM_RE.finditer(text or ""):
        op = {"=": "set", "*": "mul", "-": "add", "+": "add", None: "add"}[m.group(3)]
        value = float(m.group(4))
        if m.group(3) == "-":
            value = -abs(value)
        out.append((int(m.group(1)), int(m.group(2)), op, value))
    return out


def format_recipe(terms):
    """[(13, 7956, 'add', -0.7), ...] -> 'L13N7956-0.7 ...'. Three-tuples are add terms."""
    out = []
    for t in terms:
        layer, neuron = t[0], t[1]
        op, value = (t[2], t[3]) if len(t) == 4 else ("add", t[2])
        num = f"{float(value):g}"
        out.append(f"L{layer}N{neuron}" + ({"set": "=", "mul": "*"}.get(op, "") + num if op != "add"
                                           else f"{float(value):+g}"))
    return " ".join(out)


def pick_device():
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class NeuronModel:
    def __init__(self, name: str, device: str | None = None, dtype=None, where: str = "llm"):
        if where not in ("llm", "vision"):
            raise ValueError(f"where must be 'llm' or 'vision', got {where!r}")
        self.name = name
        self.where = where
        self.device = device or pick_device()
        if dtype is None:
            dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        self.processor = None
        try:
            self.processor = AutoProcessor.from_pretrained(name)
        except Exception:
            self.processor = None
        try:
            self.tok = AutoTokenizer.from_pretrained(name)
        except Exception:
            proc = self.processor or AutoProcessor.from_pretrained(name)
            self.processor = self.processor or proc
            self.tok = getattr(proc, "tokenizer", None) or proc
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        try:
            self.model = AutoModelForCausalLM.from_pretrained(name, dtype=dtype)
        except Exception:
            if AutoModelForImageTextToText is None:
                raise
            self.model = AutoModelForImageTextToText.from_pretrained(name, dtype=dtype)
        self.model = self.model.to(self.device).eval()
        self.model.requires_grad_(False)
        found = []
        for mod_name, mod in self.model.named_modules():
            m = DOWN_RE.search(mod_name)
            if not m or ".experts." in mod_name:
                continue
            low = mod_name.lower()
            is_vision = any(t in low for t in ("visual", "vision"))
            if where == "llm" and any(t in low for t in SKIP_TOWERS):
                continue
            if where == "vision" and not is_vision:
                continue
            found.append((int(m.group(1)), mod_name, mod))
        if not found:
            what = "vision-tower" if where == "vision" else "dense"
            raise ValueError(f"no {what} MLP down projections found in {name} (MoE models are not supported)")
        found.sort(key=lambda x: (x[0], x[1]))
        self.down_names = [n for _, n, _ in found]
        self.downs = [m for _, _, m in found]
        self.layer_modules = [self._layer_module(n) for n in self.down_names]
        self.n_layers = len(self.downs)
        self.conv1d = type(self.downs[0]).__name__ == "Conv1D"  # GPT-2 stores weight as (in, out)
        w = self.downs[0].weight
        self.d_mlp, self.d_model = (w.shape[0], w.shape[1]) if self.conv1d else (w.shape[1], w.shape[0])
        self.model_type = self.model.config.model_type
        self._steer = {}  # layer -> {op: (batch LongTensor, neuron LongTensor, value FloatTensor)}
        self._programs = {}  # layer -> compiled terms, applied in list order
        self._t_in = 0
        self._gen_step = 0
        self._prefill = False
        self._phase_hook = self.model.register_forward_pre_hook(self._note_phase, with_kwargs=True)
        self._hooks = [d.register_forward_pre_hook(self._make_steer_hook(i)) for i, d in enumerate(self.downs)]

    def _layer_module(self, name):
        """The transformer block that owns a down projection (its output is that layer's residual stream)."""
        parts = name.split(".")
        if "mlp" not in parts:
            return None
        path = ".".join(parts[:len(parts) - 1 - parts[::-1].index("mlp")])
        obj = self.model
        try:
            for p in path.split("."):
                obj = getattr(obj, p)
            return obj
        except AttributeError:
            return None

    # ---- weights ---------------------------------------------------------------------------------
    @torch.no_grad()
    def down_cols(self, layer: int) -> torch.Tensor:
        """(d_mlp, d_model): row n is what neuron n writes to the residual stream per unit of activation."""
        w = self.downs[layer].weight
        return (w if self.conv1d else w.T).float()

    @torch.no_grad()
    def unembed(self):
        """(W_U (V, d_model), gamma (d_model,) or None): the final norm's scale folded into the logit lens."""
        W_U = self.model.get_output_embeddings().weight.float()
        norm = None
        for path in ("model.norm", "transformer.ln_f", "model.final_layernorm", "gpt_neox.final_layer_norm",
                     "model.language_model.norm", "language_model.model.norm"):
            obj = self.model
            try:
                for p in path.split("."):
                    obj = getattr(obj, p)
                norm = obj
                break
            except AttributeError:
                continue
        gamma = None
        if norm is not None and getattr(norm, "weight", None) is not None:
            gamma = norm.weight.float()
            if self.model_type.startswith("gemma"):
                gamma = 1.0 + gamma
        return W_U, gamma

    # ---- steering ----------------------------------------------------------------------------------
    def _note_phase(self, module, args, kwargs):
        """One forward pre-hook on the whole model: mark prefill vs. generated-token forwards."""
        ids = kwargs.get("input_ids")
        if ids is None and args and torch.is_tensor(args[0]) and args[0].dim() >= 2:
            ids = args[0]
        emb = kwargs.get("inputs_embeds")
        if ids is not None:
            length = ids.shape[1]
        elif emb is not None:
            length = emb.shape[1]
        else:
            length = 1
        self._t_in = length
        if length > 1:
            self._gen_step = 0
            self._prefill = True
        else:
            self._gen_step += 1
            self._prefill = False
        return None

    def _apply_programs(self, x, orig, terms):
        B, T = x.shape[0], x.shape[1]
        g = 0 if self._prefill else max(0, self._gen_step - 1)
        pos = torch.arange(T, device=x.device)[None, :]
        for i, op in enumerate(terms["op"]):
            b, n = terms["b"][i], terms["n"][i]
            keep = b < B
            if not bool(keep.any()):
                continue
            b, n = b[keep], n[keep]
            value = terms["value"][i][keep]
            when, sched_s = terms["when"][i], terms["schedule"][i]
            if sched_s == "const":
                sched = 1.0
            elif sched_s.startswith("decay:"):
                sched = 0.5 ** (g / float(sched_s[6:]))
            elif sched_s.startswith("ramp:"):
                sched = min(1.0, (g + 1) / float(sched_s[5:]))
            else:
                raise ValueError(f"unknown schedule {sched_s!r}")
            if when == "all":
                mask = torch.ones((len(b), T), dtype=torch.bool, device=x.device)
            elif when == "prompt":
                mask = torch.full((len(b), T), self._prefill, dtype=torch.bool, device=x.device)
            elif when == "gen":
                mask = torch.full((len(b), T), not self._prefill, dtype=torch.bool, device=x.device)
            elif when.startswith("first:"):
                k = int(when[6:])
                mask = torch.full((len(b), T), (not self._prefill) and g < k,
                                  dtype=torch.bool, device=x.device)
            elif when.startswith("fires:"):
                z = float(when[6:])
                sd = terms["std"][i][keep].to(x.device)
                mask = orig[b[:, None], pos, n[:, None]] > (z * sd)[:, None]
            else:
                raise ValueError(f"unknown when {when!r}")
            if op == "add":
                v = value.to(x.device).to(x.dtype) * sched
                bb = b[:, None].expand(-1, T).reshape(-1)
                nn = n[:, None].expand(-1, T).reshape(-1)
                pp = pos.expand(len(b), T).reshape(-1)
                sel = mask.reshape(-1)
                if bool(sel.any()):
                    x.index_put_((bb[sel], pp[sel], nn[sel]),
                                 v[:, None].expand(-1, T).reshape(-1)[sel], accumulate=True)
            elif op in ("set", "mean"):
                v = (terms["mean"][i][keep].to(x.device) if op == "mean"
                     else value.to(x.device).to(x.dtype) * sched)
                ei, pp = mask.nonzero(as_tuple=True)
                if ei.numel():
                    x[b[ei], pp, n[ei]] = v[ei].to(x.dtype)
            else:
                v = (1 + (value.to(x.device) - 1) * sched).to(x.dtype)
                ei, pp = mask.nonzero(as_tuple=True)
                if ei.numel():
                    x[b[ei], pp, n[ei]] *= v[ei]

    def _make_steer_hook(self, layer):
        def hook(mod, args):
            ops = self._steer.get(layer)
            terms = self._programs.get(layer)
            if not ops and not terms:
                return None
            orig = args[0]
            x = orig.clone()
            if ops:
                B = x.shape[0]
                for op, (b, n, v) in ops.items():
                    keep = b < B
                    b, n, v = b[keep], n[keep], v[keep]
                    if b.numel() == 0:
                        continue
                    v = v.to(x.dtype)
                    if op == "add":
                        T = x.shape[1]
                        bb = b[:, None].expand(-1, T).reshape(-1)
                        nn = n[:, None].expand(-1, T).reshape(-1)
                        pp = torch.arange(T, device=x.device)[None, :].expand(len(b), T).reshape(-1)
                        x.index_put_((bb, pp, nn), v[:, None].expand(-1, T).reshape(-1), accumulate=True)
                    elif op == "set":
                        x[b, :, n] = v[:, None]
                    else:
                        x[b, :, n] *= v[:, None]
            if terms:
                self._apply_programs(x, orig, terms)
            return (x,) + tuple(args[1:])
        return hook

    def set_steer(self, layer: int, neurons, coeffs):
        """Add coeffs[b] to neuron neurons[b] of `layer` for batch row b, at every position (prompt and generation)."""
        if isinstance(neurons, int):
            neurons = [neurons]
        if isinstance(coeffs, (int, float)):
            coeffs = [coeffs]
        self._programs = {}
        self._steer[layer] = {"add": (torch.arange(len(neurons), device=self.device),
                                      torch.as_tensor(neurons, device=self.device, dtype=torch.long),
                                      torch.as_tensor(coeffs, device=self.device, dtype=torch.float32))}

    def set_recipes(self, rows, resid_median):
        """Apply one term list per batch row. Terms are (layer, neuron, op, value) from `parse_recipe`.

        add/set values are doses in units of median residual norm; mul values multiply the activation."""
        self._steer.clear()
        self._programs = {}
        norms, acc = {}, {}
        for b, terms in enumerate(rows):
            for t in terms:
                layer, neuron = t[0], t[1]
                op, value = (t[2], t[3]) if len(t) == 4 else ("add", t[2])
                if op not in ("add", "set", "mul"):
                    raise ValueError(f"unknown recipe op {op!r}")
                if op != "mul":
                    if layer not in norms:
                        norms[layer] = self.down_cols(layer).norm(dim=1).cpu()
                    value = value * resid_median[layer] / float(norms[layer][neuron])
                slot = acc.setdefault(layer, {}).setdefault(op, ([], [], []))
                slot[0].append(b)
                slot[1].append(neuron)
                slot[2].append(float(value))
        for layer, ops in acc.items():
            self._steer[layer] = {op: (torch.tensor(b, device=self.device, dtype=torch.long),
                                       torch.tensor(n, device=self.device, dtype=torch.long),
                                       torch.tensor(v, device=self.device, dtype=torch.float32))
                                  for op, (b, n, v) in ops.items()}

    def set_programs(self, rows, resid_median, stats=None):
        """Apply one program (or None) per batch row, with per-term units, position gates and schedules."""
        self._steer.clear()
        self._programs = {}
        norms, acc = {}, {}

        def stat(layer, neuron):
            if stats is None or (layer, neuron) not in stats:
                raise ValueError(f"stats required for L{layer}N{neuron}")
            return stats[(layer, neuron)]

        for b, prog in enumerate(rows):
            if not prog:
                continue
            for t in prog.get("terms", []):
                layer, neuron = int(t["layer"]), int(t["neuron"])
                op, value = t.get("op", "add"), float(t.get("value", 0.0))
                unit, when, schedule = t.get("unit", "resid"), t.get("when", "all"), t.get("schedule", "const")
                if op not in ("add", "set", "mul", "mean"):
                    raise ValueError(f"unknown program op {op!r}")
                if unit not in ("resid", "std", "max", "raw"):
                    raise ValueError(f"unknown program unit {unit!r}")
                if op == "mean":
                    mean, std = stat(layer, neuron)[:2]
                    coef = mean
                elif op == "mul":
                    coef = value
                    std = stat(layer, neuron)[1] if when.startswith("fires:") else 0.0
                    mean = 0.0
                else:
                    if unit == "resid":
                        if layer not in norms:
                            norms[layer] = self.down_cols(layer).norm(dim=1).cpu()
                        u = float(resid_median[layer]) / float(norms[layer][neuron])
                    elif unit == "std":
                        u = stat(layer, neuron)[1]
                    elif unit == "max":
                        u = stat(layer, neuron)[2]
                    else:
                        u = 1.0
                    coef = value * u
                    std = stat(layer, neuron)[1] if when.startswith("fires:") else 0.0
                    mean = 0.0
                slot = acc.setdefault(layer, {"b": [], "n": [], "op": [], "value": [], "when": [],
                                              "schedule": [], "std": [], "mean": []})
                slot["b"].append(b)
                slot["n"].append(neuron)
                slot["op"].append(op)
                slot["value"].append(float(coef))
                slot["when"].append(when)
                slot["schedule"].append(schedule)
                slot["std"].append(float(std))
                slot["mean"].append(float(mean))
        for layer, s in acc.items():
            self._programs[layer] = {
                "b": torch.tensor(s["b"], device=self.device, dtype=torch.long),
                "n": torch.tensor(s["n"], device=self.device, dtype=torch.long),
                "op": s["op"], "when": s["when"], "schedule": s["schedule"],
                "value": torch.tensor(s["value"], device=self.device, dtype=torch.float32),
                "std": torch.tensor(s["std"], device=self.device, dtype=torch.float32),
                "mean": torch.tensor(s["mean"], device=self.device, dtype=torch.float32)}

    def clear_steer(self):
        self._steer.clear()
        self._programs = {}

    # ---- text ----------------------------------------------------------------------------------------
    def render(self, doc) -> str:
        if "messages" in doc:
            if self.tok.chat_template:
                return self.tok.apply_chat_template(doc["messages"], tokenize=False)
            return "".join(f"{m['role'].title()}: {m['content']}\n\n" for m in doc["messages"])
        return doc["text"]

    def chat_prompt(self, user: str) -> str:
        if self.tok.chat_template:
            # enable_thinking=False: Qwen3-style templates otherwise open every reply with a <think> block;
            # other templates ignore the extra variable
            return self.tok.apply_chat_template([{"role": "user", "content": user}], tokenize=False,
                                                add_generation_prompt=True, enable_thinking=False)
        return f"User: {user}\n\nAssistant:"

    def token_strings(self, ids) -> list[str]:
        cache = getattr(self, "_tcache", None)
        if cache is None:
            cache = self._tcache = {}
        out = []
        for i in ids:
            s = cache.get(i)
            if s is None:
                s = cache[i] = self.tok.decode([i])
            out.append(s)
        return out
