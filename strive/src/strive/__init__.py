"""strive: durable mechanisms for model-led adaptation (vNext, Phase A).

Strive provides Exo-like durable mechanisms — one revision-native event and
artifact substrate plus a resumable policy command boundary — that let a
policy apply, observe, checkpoint, and revert EXACT composite changes to
allowlisted surfaces. Comparative evaluation is an optional mechanism a
policy may request, not a universal activation prerequisite.

- `strive.substrate` — the append-only event store + CAS + composite state.
- `strive.policy` — the policy/strategy protocols, kernel commands, catalog.
- `strive.kernel` — the resumable command loop.
- `strive.policies.*` — policy packages (code + TOML config + prompts).
"""

__version__ = "0.2.0"
