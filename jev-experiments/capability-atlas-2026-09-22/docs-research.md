# What the API makes possible

Documentation inspected on September 22, 2026. These are provider interface claims, not measurements from this lab. [Source metadata](documentation-sources.json) records the retrieved page hashes. TypeSafe AI authored the documentation.

## Structure belongs inside the question too

Jev accepts strings, objects, arrays and null in instructions and criterion descriptions. That includes Choice option values, individual Score levels and the true/false boundaries of a Noul. An object in the request's `state` is a separate capability. A map from option ids to flat strings also does not demonstrate nested criterion content. Structured descriptions can retain field definitions, examples and exclusions; the documentation also illustrates walking a taxonomy whose option descriptions contain subtrees. Whether those representations improve our tasks requires matched comparisons. [Advanced structure](https://docs.typesafe.ai/primitives/advanced).

## Scores need meaningful levels

A Score has two to ten ordered descriptions. The returned score is the expectation of the zero-based level index, so it can fall between levels. Its distribution and legend preserve information that the expectation alone loses. Each description needs enough meaning on its own; a numeric label or a reference to its neighbor does not supply that meaning. Separate dimensions can be scored independently and combined in code. Any application mapping to a physical unit or another scale is an explicit transformation. [Score](https://docs.typesafe.ai/primitives/score).

## Certainty is not success

Choice and Score responses include distributions and a confidence statistic derived from their shape. Noul has no corresponding confidence field. Concentrated probability is a model output, not evidence of correctness on a particular task. Our experiments should distinguish provider confidence, maximum probability, margin, entropy and calibration against labels. They need their own action/review thresholds and coverage reporting. [Confidence](https://docs.typesafe.ai/confidence).

## A call can ask independent questions

Speculative fan-out places several potentially useful questions against the same state in one request. Code consumes the relevant answers after the call. It cannot make one answer become another question's input within that same request. Dependent state changes still need another step. The cost and latency claims in the documentation need measurements under our workloads. [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out).

Composite scoring separates dimensions and lets application code combine their results using explicit weights. This suggests useful controls for readers: change a preference without asking the model to reconsider unchanged evidence. Hard restrictions still belong in code before ranking. [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring).

## What would count as deeper exploration?

For this lab, depth means testing a capability's contribution to a useful outcome. Native structured criteria, behavioral use of distributions, dependent decisions and measured closed-loop results are separate dimensions. Counting API calls or adding more simultaneous questions is not a quality measure. A simple, well-tested binary decision can be the right design.

Start with the wrapper restrictions identified in [runtime-audit.md](runtime-audit.md), then deepen existing experiments with controlled representations and independent success checks. The atlas records current call sites so those changes have a baseline.
