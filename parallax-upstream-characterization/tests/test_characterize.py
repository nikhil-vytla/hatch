from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import characterize


class CharacterizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.receipt_path = ROOT / "fixtures" / "receipt.json"
        cls.receipt = characterize.verify_receipt(cls.receipt_path)

    def test_exact_pinned_revision_and_source_hashes(self) -> None:
        self.assertEqual(
            self.receipt["revision"], characterize.PINNED_REVISION
        )
        self.assertEqual(self.receipt["tree"], characterize.PINNED_TREE)
        for path, (blob, sha256) in characterize.PINNED_FILES.items():
            with self.subTest(path=path):
                self.assertEqual(
                    self.receipt["sources"][path],
                    {"git_blob_sha1": blob, "sha256": sha256},
                )

    def test_structural_scheduler_and_trajectory_contract(self) -> None:
        probe = self.receipt["scheduler_probe"]
        self.assertEqual(probe["scenario"], "combined")
        self.assertEqual(probe["actual_t"], 6)
        self.assertEqual(
            probe["transition_types"],
            [
                "argument_change",
                "function_change",
                "argument_reveal",
                "function_change",
                "argument_change",
            ],
        )
        self.assertEqual(probe["functions"][0], "FAR_PREDECESSOR")
        self.assertEqual(probe["functions"][-1], "SOURCE_FUNCTION")
        self.assertEqual(probe["active_values"][-1], None)
        self.assertEqual(probe["revealed_ids"][-1], [1, 2, 3])
        self.assertEqual(probe["final_label"], "42")

    def test_deterministic_prefix_render_parity(self) -> None:
        self.assertEqual(
            self.receipt["scheduler_probe"]["turns"],
            [
                "FAR_PREDECESSOR COUNTERFACTUAL_1A",
                "[CORRECTION] SOURCE_ARGUMENT_1",
                "[FUNCTION] NEAR_PREDECESSOR",
                "[REVEAL] COUNTERFACTUAL_2A",
                "[FUNCTION] SOURCE_FUNCTION [AFTER_FUNCTION] SOURCE_ARGUMENT_3",
                "[CORRECTION] SOURCE_ARGUMENT_2",
            ],
        )

    def test_swe_overlay_contract(self) -> None:
        self.assertEqual(
            self.receipt["scheduler_probe"]["swe_overlay"],
            {
                "ceil_front_7_into_3": [3, 2, 2],
                "stripped_source_argument_ids": [1],
                "target_symptom_ids": [2],
                "predecessor_symptom_ids": {
                    "PREDECESSOR_FUNCTION.": [101]
                },
                "normalized_source_function": "SOURCE_FUNCTION.",
            },
        )

    def test_every_provider_generated_asset_is_explicitly_unavailable(self) -> None:
        for adapter, assets in self.receipt["generated_assets"].items():
            for asset, status in assets.items():
                with self.subTest(adapter=adapter, asset=asset):
                    self.assertEqual(status, "unavailable")
                    self.assertEqual(
                        characterize.asset_status(self.receipt, adapter, asset),
                        {
                            "adapter": adapter,
                            "asset": asset,
                            "status": "unavailable",
                        },
                    )

    def test_unavailable_asset_cli_has_distinct_exit_code(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "characterize.py"),
                "asset",
                "--receipt",
                str(self.receipt_path),
                "--adapter",
                "gsm8k",
                "--asset",
                "final_dataset",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 3)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "adapter": "gsm8k",
                "asset": "final_dataset",
                "status": "unavailable",
            },
        )

    def test_tampered_hash_is_rejected(self) -> None:
        tampered = copy.deepcopy(self.receipt)
        target = "situated_simulation/turn_scheduler.py"
        tampered["sources"][target]["sha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(
                characterize.CharacterizationError,
                "receipt hash drifted",
            ):
                characterize.verify_receipt(path)

    def test_receipt_has_no_local_absolute_paths(self) -> None:
        serialized = json.dumps(self.receipt)
        self.assertNotIn("/Users/", serialized)
        self.assertNotIn("/tmp/", serialized)

    @unittest.skipUnless(
        os.environ.get("EVOLVING_INTENT_UPSTREAM"),
        "set EVOLVING_INTENT_UPSTREAM to rerun against a pinned checkout",
    )
    def test_refresh_matches_committed_receipt(self) -> None:
        refreshed = characterize.collect(
            Path(os.environ["EVOLVING_INTENT_UPSTREAM"])
        )
        self.assertEqual(refreshed, self.receipt)


if __name__ == "__main__":
    unittest.main()
