# Extending Windtunnel

The platform story for researchers and users: every extension point is a
named registry slot, populated per-run (no globals), fillable three ways —

1. **In your spec:** `uses = ["your_package.your_domain"]` — the module's
   `register(registry)` runs before the world builds.
2. **In your package:** expose an entry point in group `windtunnel.domains`
   (or `windtunnel.policies` / `windtunnel.verifiers`); discovered automatically.
3. **In code:** `registry = build_registry(); registry.X["name"] = ...` and
   pass it to `engine.run(spec, seed, registry=registry)`.

## Extension points

| Slot | Shape | You'd add one to… |
|---|---|---|
| `policies` | `params -> Policy` (async `decide(obs, ctx) -> Decision`) | wrap your agent/SDK as a system-under-test; add NPC behaviors |
| `model_clients` | `params -> ModelClient` (one `complete()` method) | support a new model provider or local runtime |
| `mechanics` | `(world, actor_id, intent) -> [Event]` | new action types (e.g. `transfer_funds`, `click`) |
| `reducers` | `(store, event) -> None` | new state-change semantics for your events |
| `tools` | `(store, args, rng) -> result` | stateful simulated capabilities (or skip Python entirely: put a canned `response` on the tool entity — tools-as-data) |
| `verifiers` | `(name, params) -> Verifier` | new contract vocabulary (e.g. an LLM judge) |
| `generators` | `(brief, seed) -> WorldSpec` | procedural or LLM-backed world families |
| `adapters` | `(rows, brief) -> [WorldSpec]` | ingest an existing benchmark format |
| `Surface` implementations | `render(view) -> Observation`, `interpret(raw) -> [Intent]` | new modalities (browser, voice, desktop) |

## Worked example: bring your own agent (5 minutes)

```python
# my_agent.py
from windtunnel import Decision, Intent

class MyAgentPolicy:
    def __init__(self, params): ...
    async def decide(self, obs, ctx):
        reply = my_existing_agent.respond(obs.parts)      # your code, any I/O
        return Decision(intents=[Intent(kind="send_message",
            payload={"to": "user-1", "content": [{"kind": "text", "text": reply}]})])

def register(registry):
    registry.policies["my_agent"] = MyAgentPolicy
```

```toml
# in your world spec
uses = ["my_agent"]
[[actors]]
id = "agent-1"
role = "system_under_test"
policy = { type = "my_agent", params = {} }
```

Your agent now runs inside any Windtunnel world — chaos, hidden state, contracts,
replay included. If it's a chat+tool-calling model, skip the custom policy
entirely and use `policy = { type = "model", params = { client = {...} } }`.

## Worked example: bring a benchmark

Write `(rows, brief) -> list[WorldSpec]`, register it under
`registry.adapters`, and include an oracle policy (the agent that performs
the task's known-correct actions). Then `windtunnel adapt your_format tasks.jsonl
--run` self-validates every converted task before any model sees it. See
`adapters.py` (`bfcl_style`) for the ~120-line reference.

## Ground rules for extensions

- Draw randomness only from the `rng`/`ctx.rng` you're handed (replay breaks
  silently otherwise — this is the one discipline the kernel can't enforce).
- Reducers: no I/O, no randomness, no rejection — pure folds.
- Policies may do arbitrary I/O; it's quarantined by decision recording.
- State changes must flow through events; a tool that "updates the database"
  should return a result and let the agent `set_fact` (or add a mechanic).
