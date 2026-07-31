+++
id = "source.zhang-khattab-harnesses"
kind = "source"
title = "Language model harnesses are compositional generalizers"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["harnesses", "generalization", "long-context", "rl"]
source_type = "research-blog"
authors = ["Alex Zhang", "Omar Khattab"]
year = 2026
url = "https://alexzhang13.github.io/blog/2026/harness/"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.prime-verifiers-v1"]
supported_by = []
challenges = []
+++

# Language model harnesses are compositional generalizers

## Why it matters

The work argues that a harness can induce reusable decomposition behavior
rather than merely transport model inputs and outputs.

## Supported claims

### C1. Harness structure changed length generalization in the studied tasks

Training a Recursive Language Model harness on short tasks generalized to held
out tasks reported as 8 to 32 times longer.

### C2. The harness can map different tasks to similar local interactions

The proposed mechanism is that context offloading and recursive subcalls turn
large problems into sequences of locally familiar model calls.

### C3. Harness choice is part of the effective learning problem

Context retention, decomposition, and subcall routing affect what trajectories
the root model encounters during RL.

## Limitations

- The results cover the reported task families and harness.
- The proposed equivalence over trajectories is an explanatory hypothesis, not
  a general theorem.
- Some experiments used decomposition hints.
- Better harness generalization can hide rather than solve weak environment
  diversity if train and test tasks share decomposition structure.

## Parallax implications

Harness revision must be part of every difficulty claim. Future experiments
should hold out both task semantics and decomposition structure.
