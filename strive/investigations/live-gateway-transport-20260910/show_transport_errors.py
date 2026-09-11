"""Read sanitized transport failures under a run directory without loading prompts."""
import argparse
import json
from pathlib import Path
import sqlite3


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    args = parser.parse_args()
    for database in sorted(args.run_directory.rglob("transport.sqlite")):
        with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
            exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='diagnostics'").fetchone()
            if exists:
                for (detail,) in connection.execute("SELECT detail FROM diagnostics ORDER BY id"):
                    print(json.dumps({"database": str(database), "diagnostic": json.loads(detail)}, sort_keys=True))


if __name__ == "__main__":
    main()
