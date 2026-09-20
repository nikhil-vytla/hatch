"""Run the saved SmolLM2 pilot weights. No Jev or writer API call is made."""

import argparse
import json
import os
from pathlib import Path

from .core import ROOT
from .replica import BASE, build_model, pack

REVISION = "f8027fd0eaeea54caa13c31d31b9fdc459c38b49"


def load_model(weights=None):
    os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))
    import torch
    from transformers import AutoTokenizer

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(BASE, revision=REVISION)
    model = build_model(REVISION, device)
    state = torch.load(
        weights or ROOT / "artifacts/smollm2-decisions.pt", map_location="cpu", weights_only=True
    )
    expected = {name for name, value in model.named_parameters() if value.requires_grad}
    if set(state) != expected:
        raise ValueError("Saved parameters do not match the pilot architecture")
    with torch.no_grad():
        for name, parameter in model.named_parameters():
            if name in state:
                parameter.copy_(state[name].to(device))
    return tokenizer, model.eval()


def decide(tokenizer, model, text, questions):
    import torch

    if not 1 <= len(questions) <= 16:
        raise ValueError("Supply 1–16 questions")
    if any(not 2 <= len(q["options"]) <= 32 for q in questions):
        raise ValueError("Supply 2–32 options per question")
    record = {"text": text, "questions": [{**q, "label": 0} for q in questions]}
    encoded = pack(tokenizer, record)
    if len(encoded["ids"]) > 2048:
        raise ValueError("Packed request exceeds the pilot's 2048-token inference limit")
    with torch.no_grad():
        logits = model(encoded)
    result = []
    for question, values in zip(questions, logits):
        probabilities = torch.softmax(values, -1).cpu().tolist()
        result.append(
            {
                "instruction": question["instruction"],
                "choice": question["options"][values.argmax().item()],
                "probabilities": dict(zip(question["options"], probabilities)),
            }
        )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text")
    parser.add_argument("--question", default="Which intent is expressed by the customer?")
    parser.add_argument(
        "--options",
        nargs="+",
        default=["request refund", "card arrival", "pending transfer", "exchange rate"],
    )
    parser.add_argument("--weights", type=Path)
    args = parser.parse_args()
    tokenizer, model = load_model(args.weights)
    print(
        json.dumps(
            decide(
                tokenizer,
                model,
                args.text,
                [{"instruction": args.question, "options": args.options}],
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
