from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import characterize  # noqa: E402


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

    def test_bird_sql_is_classified_as_nondeterministic(self) -> None:
        contract = self.receipt["bird_sql_reproducibility"]
        self.assertEqual(
            contract["classification"],
            "nondeterministic_unless_mechanically_constrained",
        )
        self.assertIn(
            "seed alone does not fix output order",
            contract["observations"],
        )
        self.assertIn(
            "canonical output ordering before identity or byte comparison",
            contract["required_constraints"],
        )

    def test_swe_overlay_contract(self) -> None:
        overlay = self.receipt["scheduler_probe"]["swe_overlay"]
        self.assertEqual(
            overlay["before_argument_ids"],
            [[1, 101, 102], [], [103, 3, 2]],
        )
        self.assertEqual(
            overlay["after_argument_ids"],
            [[102, 101, 190], [103, 191], [1, 2, 3, 90]],
        )
        self.assertEqual(
            overlay["phase_owned_ids"],
            {"predecessor": [101, 102, 103], "source": [1, 2, 3]},
        )
        self.assertEqual(overlay["symptom_positions"], [[2], [1], [3]])
        self.assertEqual(
            overlay["rendered_turns"],
            [
                "PREDECESSOR. PG_LOCATION PG_APPROACH PG_SYMPTOM_A",
                "[REVEAL] LEAKED_PG_CONSTRAINT PG_SYMPTOM_B",
                (
                    "[FUNCTION] SOURCE. [AFTER_FUNCTION] SOURCE_TRIGGER "
                    "SOURCE_LOCATION SOURCE_CONSTRAINT SOURCE_SYMPTOM"
                ),
            ],
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

    def test_any_committed_field_tampering_is_rejected(self) -> None:
        mutations = {
            "source hash": lambda receipt: receipt["sources"][
                "situated_simulation/turn_scheduler.py"
            ].__setitem__("sha256", "0" * 64),
            "contract prose": lambda receipt: receipt["contracts"][0][
                "observable_contract"
            ].__setitem__(0, "tampered"),
            "source range": lambda receipt: receipt["contracts"][0]["symbols"][
                0
            ].__setitem__("line_start", 0),
            "middle trajectory": lambda receipt: receipt["scheduler_probe"][
                "active_values"
            ].__setitem__(2, {"1": "tampered"}),
            "index path": lambda receipt: receipt["published_eval_indices"][
                "gsm8k"
            ].__setitem__("eval_ids_path", "tampered.json"),
            "source file claim": lambda receipt: receipt[
                "published_eval_indices"
            ]["gsm8k"].__setitem__("source_file_claim", "tampered.json"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                tampered = copy.deepcopy(self.receipt)
                mutate(tampered)
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "receipt.json"
                    path.write_text(json.dumps(tampered), encoding="utf-8")
                    with self.assertRaisesRegex(
                        characterize.CharacterizationError,
                        "canonical receipt digest mismatch",
                    ):
                        characterize.verify_receipt(path)

    def test_canonical_digest_is_pinned(self) -> None:
        self.assertEqual(
            self.receipt["canonical_sha256"],
            characterize.PINNED_RECEIPT_SHA256,
        )

    def test_resealed_tampered_receipt_is_rejected(self) -> None:
        tampered = copy.deepcopy(self.receipt)
        tampered["contracts"][0]["observable_contract"][0] = "tampered"
        tampered["canonical_sha256"] = hashlib.sha256(
            characterize._canonical_receipt_bytes(tampered)
        ).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(
                characterize.CharacterizationError,
                "pinned canonical digest",
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
