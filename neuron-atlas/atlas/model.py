"""Thin adapter over Hugging Face causal LMs: find each layer's MLP down projection, read and push its neurons.

A "neuron" is one input channel of the MLP down projection (down_proj / c_proj / fc2 / dense_4h_to_h). Its
activation is what enters that projection; its output direction is the matching column of the weight. This covers
Llama, Qwen2/3, Mistral, OLMo, Gemma, SmolLM (gated: act(gate)·up) and GPT-2/GPT-NeoX/Phi (act(fc1)).
"""
import re
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

DOWN_RE = re.compile(r"\.(\d+)\.mlp\.(down_proj|c_proj|fc2|dense_4h_to_h)$")


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
        self.tok = AutoTokenizer.from_pretrained(name)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.model = AutoModelForCausalLM.from_pretrained(name, dtype=dtype).to(self.device).eval()
        self.model.requires_grad_(False)
        found = []
        for mod_name, mod in self.model.named_modules():
            m = DOWN_RE.search(mod_name)
            if m and ".experts." not in mod_name:
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
        self._steer = {}  # layer -> (neuron idx LongTensor[B], coeff FloatTensor[B])
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
                     "model.language_model.norm"):
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
            s = self._steer.get(layer)
            if s is None:
                return None
            x = args[0]
            idx, coeff = s
            B = x.shape[0]
            rows = torch.arange(B, device=x.device)
            x = x.clone()
            x[rows, :, idx[:B]] += coeff[:B, None].to(x.dtype)
            return (x,) + tuple(args[1:])
        return hook

    def set_steer(self, layer: int, neurons, coeffs):
        """Add coeffs[b] to neuron neurons[b] of `layer` for batch row b, at every position (prompt and generation)."""
        self._steer[layer] = (torch.as_tensor(neurons, device=self.device, dtype=torch.long),
                              torch.as_tensor(coeffs, device=self.device, dtype=torch.float32))

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
            return self.tok.apply_chat_template([{"role": "user", "content": user}], tokenize=False,
                                                add_generation_prompt=True)
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
