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
    def __init__(self, name: str, device: str | None = None, dtype=None):
        self.name = name
        self.device = device or pick_device()
        if dtype is None:
            dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        try:
            self.tok = AutoTokenizer.from_pretrained(name)
        except Exception:
            proc = AutoProcessor.from_pretrained(name)
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
            if m and ".experts." not in mod_name and not any(t in mod_name.lower() for t in SKIP_TOWERS):
                found.append((int(m.group(1)), mod))
        if not found:
            raise ValueError(f"no dense MLP down projections found in {name} (MoE models are not supported)")
        found.sort(key=lambda x: x[0])
        self.downs = [m for _, m in found]
        self.n_layers = len(self.downs)
        self.conv1d = type(self.downs[0]).__name__ == "Conv1D"  # GPT-2 stores weight as (in, out)
        w = self.downs[0].weight
        self.d_mlp, self.d_model = (w.shape[0], w.shape[1]) if self.conv1d else (w.shape[1], w.shape[0])
        self.model_type = self.model.config.model_type
        self._steer = {}  # layer -> {op: (batch LongTensor, neuron LongTensor, value FloatTensor)}
        self._hooks = [d.register_forward_pre_hook(self._make_steer_hook(i)) for i, d in enumerate(self.downs)]

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
    def _make_steer_hook(self, layer):
        def hook(mod, args):
            ops = self._steer.get(layer)
            if not ops:
                return None
            x = args[0]
            B = x.shape[0]
            x = x.clone()
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
            return (x,) + tuple(args[1:])
        return hook

    def set_steer(self, layer: int, neurons, coeffs):
        """Add coeffs[b] to neuron neurons[b] of `layer` for batch row b, at every position (prompt and generation)."""
        if isinstance(neurons, int):
            neurons = [neurons]
        if isinstance(coeffs, (int, float)):
            coeffs = [coeffs]
        self._steer[layer] = {"add": (torch.arange(len(neurons), device=self.device),
                                      torch.as_tensor(neurons, device=self.device, dtype=torch.long),
                                      torch.as_tensor(coeffs, device=self.device, dtype=torch.float32))}

    def set_recipes(self, rows, resid_median):
        """Apply one term list per batch row. Terms are (layer, neuron, op, value) from `parse_recipe`.

        add/set values are doses in units of median residual norm; mul values multiply the activation."""
        self._steer.clear()
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

    def clear_steer(self):
        self._steer.clear()

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
