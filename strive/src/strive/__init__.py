"""strive: durable mechanisms for model-led adaptation.

Strive lets an agent revise its code, prompts and memory while a fixed
execution core enforces permissions, accounts for effects, records exact
revisions and recovers without hiding uncertainty. Comparative evaluation is
optional, not a universal promotion gate.

The current implementation lives in `strive.vnext`; see `strive.vnext.cli`
for the manifest-shaped CLI and `docs/ARCHITECTURE.md` for the five integrity
guarantees.
"""

__version__ = "0.2.0"
