# Portable review rerunners

Both [v2](../independent-review-v2/run-review.py) and [v3](../independent-review-v3/run-review.py) review drivers now accept explicit `--archive` and `--output` arguments. The archive must contain the pinned `source.tar` and dependency-prepared `source/`. The scripts verify archive and selected-source hashes, refuse existing output destinations, and write any future results into a new folder. `--preflight-only` validates inputs without running suites or creating output.

The exact executed driver versions were retained separately before modification. Each review's `driver-provenance.json` and refreshed manifest distinguish its historical executed-driver digest from the new published rerunner digest. No historical log, observation, check record or assertion body changed. The v2 observation script is copied unchanged into the fresh destination before execution; reproducing its known failures returns a nonzero status.

[test-preflight.py](test-preflight.py) passed 20 checks covering both valid inputs and refusal paths. [preflight-checks.json](preflight-checks.json) records that no suites were executed. The new runners therefore have argument/preflight evidence only and are not credited with producing the retained historical results. [driver-versions.json](driver-versions.json) records the exact before/after driver hashes.
