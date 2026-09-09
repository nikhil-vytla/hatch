"""Rerun every collected vNext case once in four isolated pytest processes."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
from xml.etree import ElementTree as ET


def main() -> None:
    folder = Path(__file__).resolve().parent
    root = folder.parent
    (folder / "final-tmp").mkdir(exist_ok=True)
    collected = subprocess.check_output(
        [sys.executable, "-m", "pytest", "tests/vnext", "--collect-only", "-q"],
        cwd=root, text=True,
    )
    nodes = [line for line in collected.splitlines() if line.startswith("tests/vnext/")]
    assert nodes and len(nodes) == len(set(nodes))
    prior = ET.parse(folder / "pytest-vnext.xml")
    durations = {
        case.attrib["classname"].replace(".", "/") + ".py::" + case.attrib["name"]:
        float(case.attrib["time"])
        for case in prior.iter("testcase")
    }
    groups: list[list[str]] = [[], [], [], []]
    totals = [0.0] * len(groups)
    for node in sorted(nodes, key=lambda name: durations.get(name, 0.0), reverse=True):
        index = min(range(len(groups)), key=lambda i: totals[i])
        groups[index].append(node)
        totals[index] += max(durations.get(node, 0.0), 0.001)
    assigned = [node for group in groups for node in group]
    assert len(assigned) == len(nodes) and set(assigned) == set(nodes)

    def run(index: int) -> int:
        prefix = folder / f"pytest-final-{index}"
        prefix.with_suffix(".nodes.txt").write_text("\n".join(groups[index]) + "\n")
        with prefix.with_suffix(".txt").open("w") as output:
            result = subprocess.run(
                [sys.executable, "-m", "pytest", *groups[index], "-q", "-ra",
                 f"--basetemp={folder / 'final-tmp' / str(index)}",
                 f"--junitxml={prefix.with_suffix('.xml')}"],
                cwd=root, stdout=output, stderr=subprocess.STDOUT,
            )
        print(f"Shard {index}: {len(groups[index])} cases, exit {result.returncode}", flush=True)
        return result.returncode

    print(f"Running all {len(nodes)} vNext cases exactly once across {len(groups)} shards", flush=True)
    with ThreadPoolExecutor(max_workers=len(groups)) as pool:
        statuses = list(pool.map(run, range(len(groups))))
    combined = ET.Element("testsuites")
    for index in range(len(groups)):
        combined.extend(ET.parse(folder / f"pytest-final-{index}.xml").getroot())
    ET.ElementTree(combined).write(folder / "pytest-vnext-final.xml", encoding="unicode")
    cases = list(combined.iter("testcase"))
    actual = [case.attrib["classname"].replace(".", "/") + ".py::" + case.attrib["name"] for case in cases]
    assert len(actual) == len(nodes) and set(actual) == set(nodes)
    failed = sum(case.find("failure") is not None or case.find("error") is not None for case in cases)
    skipped = [case.find("skipped") for case in cases if case.find("skipped") is not None]
    xfailed = sum(skip.attrib.get("type") == "pytest.xfail" for skip in skipped)
    passed = len(cases) - failed - len(skipped)
    print(f"{passed} passed, {len(skipped) - xfailed} skipped, {xfailed} xfailed, {failed} failed", flush=True)
    if any(statuses):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
