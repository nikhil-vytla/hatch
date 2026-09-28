"""Repair comma splices the mechanical dash pass introduced."""

from __future__ import annotations

import pathlib
import re
import sys

FIXES: dict[str, list[tuple[str, str]]] = {
    "parallax/research/checkpoint-evolution-slice/NOTES.md": [
        ("   compute-priced, out of scope for a no-inference unit.",
         "   compute-priced and out of scope for a no-inference unit."),
        ("- C2 `extension`: new subcommand `top`, name with the largest",
         "- C2 `extension`: new subcommand `top`, returning the name with the largest"),
        ("by the runner loop, the agent is a pure function of\n(public spec, carried workspace, budget) and has no advance channel, and\n`FamilyRun` model validators make",
         "by the runner loop. The agent is a pure function of (public spec, carried\nworkspace, budget) and has no advance channel, and\n`FamilyRun` model validators make"),
        ("  bug, not a code bug, with the reference-mimicking agent on",
         "  bug, not a code bug. With the reference-mimicking agent on"),
        ("- Mutation gauntlet, 14/14 killed:",
         "- Mutation gauntlet: 14/14 killed."),
        ("  `ruff format --check`, clean.",
         "  `ruff format --check`: both clean."),
        ("  sealed material *by construction*, `render_stage_messages` takes only",
         "  sealed material *by construction*: `render_stage_messages` takes only"),
        ("  `linux/amd64` per the repo's SWE-bench Docker discipline, explicit",
         "  `linux/amd64` per the repo's SWE-bench Docker discipline, with explicit"),
        ("  and the run then finished on schedule, the `docker events` window",
         "  and the run then finished on schedule. The `docker events` window"),
    ],
    "parallax/research/slopcodebench-method/NOTES.md": [
        ("  Setup). No conversation carry-over, the agent must recover design intent",
         "  Setup). No conversation carry-over, so the agent must recover design intent"),
        ("- wsff.md: thesis, RL rewards (fail-to-pass) carry no penalty for eroding",
         "- wsff.md thesis: RL rewards (fail-to-pass) carry no penalty for eroding"),
        ("1. algorithmic-model.md, formal model (deliverable 1)",
         "1. algorithmic-model.md: formal model (deliverable 1)"),
        ("2. quality-measurement.md, deliverable 2",
         "2. quality-measurement.md: deliverable 2"),
        ("3. research-questions.md, deliverable 3",
         "3. research-questions.md: deliverable 3"),
        ("4. synthesis-workflow.md, deliverable 4",
         "4. synthesis-workflow.md: deliverable 4"),
        ("5. checkpoint-evolution.md, draft method doc destined for",
         "5. checkpoint-evolution.md: draft method doc destined for"),
    ],
    "parallax/research/slopcodebench-method/README.md": [
        ("- Task generation is largely automatable; admission is not, design-pressure",
         "- Task generation is largely automatable; admission is not, because design-pressure"),
    ],
    "parallax/research/slopcodebench-method/algorithmic-model.md": [
        ("1. No prescribed internal interfaces, specs constrain the external contract",
         "1. No prescribed internal interfaces: specs constrain the external contract"),
        ("2. No visible test suite, agents see specification prose and embedded",
         "2. No visible test suite: agents see specification prose and embedded"),
        ("$C_1$, one anticipatory, the pressure of a sequence is the ratio of",
         "$C_1$ and one anticipatory. The pressure of a sequence is the ratio of"),
        ("**Slope contrasts**, new to CE, the trajectory itself is the outcome:",
         "**Slope contrasts** are new to CE, where the trajectory itself is the outcome:"),
    ],
    "parallax/research/slopcodebench-method/quality-measurement.md": [
        ("**Structural erosion**, the share of the codebase's complexity mass held by",
         "**Structural erosion** is the share of the codebase's complexity mass held by"),
        ("**Verbosity**, the fraction of lines that are redundant by rule or by clone:",
         "**Verbosity** is the fraction of lines that are redundant by rule or by clone:"),
        ("which construct, correctness risk or effort. It is invoking.",
         "which construct it is invoking, correctness risk or effort."),
        ("  under an incrementally divulged spec, and, sharper, the **handoff",
         "  under an incrementally divulged spec, and sharper still, the **handoff"),
        ("3. Goodhart exposure the moment they become reward or gate, 137 public-ish",
         "3. Goodhart exposure the moment they become reward or gate: 137 public-ish"),
    ],
    "parallax/research/slopcodebench-method/research-questions.md": [
        ("Falsified if the conditional slope is ≈ 0, then \"slop\" is a symptom of",
         "Falsified if the conditional slope is ≈ 0; then \"slop\" is a symptom of"),
        ("irreversible by the agent that caused it, strong evidence for the wsff",
         "irreversible by the agent that caused it, which is strong evidence for the wsff"),
    ],
    "parallax/research/slopcodebench-method/synthesis-workflow.md": [
        ("### Stage S1: Scout: checkpoint-decomposability assessment",
         "### Stage S1, Scout: checkpoint-decomposability assessment"),
        ("### Stage S2: Plan: checkpoint partition",
         "### Stage S2, Plan: checkpoint partition"),
        ("### Stage S3: Draft: specifications",
         "### Stage S3, Draft: specifications"),
        ("### Stage S4: Build: dual references and sealed suite",
         "### Stage S4, Build: dual references and sealed suite"),
        ("### Stage S5: Admit: gates G1–G6",
         "### Stage S5, Admit: gates G1 through G6"),
        ("### Stage S6: Calibrate and freeze",
         "### Stage S6, Calibrate and freeze"),
        ("## 3. Automatable now vs. human judgment: and why",
         "## 3. Automatable now versus human judgment, and why"),
    ],
}


def main() -> int:
    misses = 0
    for name, pairs in FIXES.items():
        path = pathlib.Path(name)
        text = path.read_text(encoding="utf-8")
        for bad, good in pairs:
            if bad not in text:
                print(f"MISS {name}: {bad[:60]!r}")
                misses += 1
                continue
            text = text.replace(bad, good, 1)
        path.write_text(text, encoding="utf-8")

    # Section links in the workflow doc must follow the renamed headings.
    wf = pathlib.Path("parallax/research/slopcodebench-method/synthesis-workflow.md")
    text = wf.read_text(encoding="utf-8")
    text = re.sub(r"#stage-s(\d)-(scout|plan|draft|build|admit)-", r"#stage-s\1-\2-", text)
    wf.write_text(text, encoding="utf-8")
    print(f"{misses} misses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
