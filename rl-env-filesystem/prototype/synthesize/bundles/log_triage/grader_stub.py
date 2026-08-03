#!/usr/bin/env python3
"""Grader for task: log_triage

Contract: run with the rollout's final /work as cwd, read-only access to the
seed manifest, print a float reward in [0, 1] on the last line of stdout.
Generated as a stub; the synthesis step (see synthesis_prompt.md) fills in
the checks. Sanity contract from the design doc: unchanged seed state must
score 0.0; a correct completion must score 1.0.
"""
import json, os, sys

MANIFEST = json.load(open(os.path.join(os.path.dirname(__file__), "manifest.json")))

def grade() -> float:
    # TODO(synthesis): replace with checks derived from the description:
    #   Triage this service log: identify the dominant failure, when it started, and write an incident_summary.md; check the policy file for any reporting requirements.
    # Available signals: files under cwd (agent's final state), MANIFEST
    # (seed inventory with digests -- detect modified/deleted seeds by
    # rehashing), and any task-specific outputs the scenario asks for.
    raise NotImplementedError("grader not yet synthesized")

if __name__ == "__main__":
    print(grade())
