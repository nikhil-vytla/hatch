# Run a conversational arm

## Sub-features

- Select a built static, matched, or evolved arm.
- Deliver each planned user turn to a synchronous or asynchronous callback.
- Parse the callback's final answer with the GSM8K evaluator.
- Return outcome, reward, response, parsed answer, and completed turn count.

## How to get to it (user POV)

Import `parallax`, load a `Gsm8k` source and frozen `EvolvingIntent` strategy,
then call `parallax.build`. Select an arm by name and provide the model callback
to `await parallax.run(...)`.

## Driving it with the Python library

```python
import asyncio
from pathlib import Path

import parallax

fixture = Path("tests/fixtures/synthesis_kernel")
source = parallax.Gsm8k.load(fixture / "gsm8k.json")
strategy = parallax.EvolvingIntent.frozen(fixture / "proposal.json")
family = parallax.build(source=source, strategy=strategy)

def agent(messages):
    return "#### 72" if len(messages) == 5 else "Acknowledged."

verdict = asyncio.run(parallax.run(family.arm("evolved"), agent=agent))
assert verdict.reward == 1.0
assert verdict.turns_completed == 3
```

Capture the callback inputs or their safe transcript, final verdict, selected
arm task ID, and family ID. The returned reward and turn count are the
observable result.

## Gotchas

The callback is caller-owned. This path does not provide a model provider,
retry policy, token enforcement, trace store, or network isolation. Only
conversation arms execute. `CheckpointSequence` and other non-conversation
runtimes raise `NotImplementedError`. The frozen fixture still does not prove
Microsoft Evolving Intent generation.
