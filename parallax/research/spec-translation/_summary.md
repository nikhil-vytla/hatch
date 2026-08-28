Turning Parallax's formal task model into platform artifacts currently fails
at the translation boundary, not the modeling layer: the HUD SWE build
hand-assembles `instance.json` with the sealed verifier copied into the
agent's own image and grades by returncode alone, even though the frozen
Pydantic models already separate public from sealed fields and verdicts
from run failures. A survey of upstream encodings
([microsoft/evolving-intent](https://github.com/microsoft/evolving-intent),
SprocketLab/slop-code-bench) and current platforms (HUD v6, [Prime
Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers),
Inspect AI, OpenEnv) found no existing standard that expresses sealed
authority, matched arms, or failure-separated verdicts. METR's Task
Standard decayed into a one-way Inspect bridge, Harbor adapts many
benchmarks into one harness, and CUBE standardizes only the runtime
protocol. The recommendation is a three-piece lever rather than a
framework: a versioned TaskSpec/EnvSpec schema whose public/sealed split is
structural, one deterministic compile function per platform with a digest
receipt, and a conformance harness that runs identical fixture submissions
through the reference grader and each compiled grader.

- Second-consumer bar: met for the schema and conformance check (the HUD
  build and the in-process GSM8K runner already consume the same spec
  shapes and have diverged); not met for a general N-platform compiler.
- Sequencing: schema, HUD compiler refactor, and conformance harness land
  before paid SWE screening, whose evidence is uninterpretable under
  returncode-only grading; the GSM8K-to-verifiers port is the offline
  second-consumer proof and can proceed in parallel.
- The conformance fixtures (harness-crash and sealed-test-file submissions)
  would have caught both known bugs at compile time.
