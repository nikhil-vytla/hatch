"""The strive command-line interface (`uv run strive`).

Delegates directly to the manifest-shaped vNext CLI; see
`strive.vnext.cli.app` for the command surface (`run`, `resume`, `compare`,
`experiment`, `campaign`, `budget-stop-live`, `status`, `project`).
"""

from __future__ import annotations

from strive.vnext.cli.app import main as research_main


def main(argv: list[str] | None = None) -> int:
    return research_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
