from __future__ import annotations

import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from parallax import (  # noqa: E402
    AdmissionError,
    ArtifactError,
    CanonicalValueError,
    DomainSourceIdentity,
    TreePolicy,
    Verdict,
    admit_task,
    build_task,
    canonical_bytes,
    make_replay_lock,
    publish_public_task,
    replay_locked,
    snapshot_tree,
    source_asset_manifest,
)
from parallax.gsm8k import grade_gsm8k  # noqa: E402
from parallax.records import RuntimePolicy  # noqa: E402

SYNTHETIC_SOURCE = b'{"question":"SYNTHETIC: add two counters"}'
# These invented constants are not GSM8K benchmark answers.
SYNTHETIC_ANSWER = "314159"
SYNTHETIC_WRONG_ANSWER = "271828"


def fixture(answer: str = SYNTHETIC_ANSWER, source_bytes: bytes = SYNTHETIC_SOURCE):
    assets = source_asset_manifest(
        source_bytes,
        origin="synthetic://parallax/tests/gsm8k",
        revision="synthetic-fixture-v1",
    )
    source = DomainSourceIdentity(
        domain="gsm8k",
        source_uri="https://huggingface.co/datasets/openai/gsm8k",
        source_revision="synthetic-fixture-v1",
        split="synthetic-test",
        record_id="synthetic-row-001",
    )
    task = build_task(
        source=source,
        prompt="SYNTHETIC: add two counters.",
        answer_authority=answer,
        assets=assets,
    )
    return task, {"source-row.public.json": source_bytes}


class CanonicalTests(unittest.TestCase):
    def test_canonical_bytes_are_stable(self) -> None:
        left = canonical_bytes({"z": [2, 1], "a": {"x": True}})
        right = canonical_bytes({"a": {"x": True}, "z": (2, 1)})
        self.assertEqual(left, right)
        self.assertEqual(left, b'{"a":{"x":true},"z":[2,1]}')

    def test_ambiguous_values_are_rejected(self) -> None:
        for value in (1.0, Path("platform-path"), {1: "non-string-key"}, "e\u0301"):
            with self.subTest(value=repr(value)):
                with self.assertRaises(CanonicalValueError):
                    canonical_bytes(value)

    def test_public_identity_does_not_depend_on_answer_authority(self) -> None:
        first, _ = fixture(SYNTHETIC_ANSWER)
        second, _ = fixture(SYNTHETIC_WRONG_ANSWER)
        self.assertEqual(first.public.id, second.public.id)
        self.assertEqual(canonical_bytes(first.public.as_record()), canonical_bytes(second.public.as_record()))
        self.assertNotEqual(first.sealed.id, second.sealed.id)
        public_bytes = canonical_bytes(first.public.as_record())
        self.assertNotIn(b"314159", public_bytes)
        self.assertNotIn(first.verifier.id.encode(), public_bytes)


class AdmissionAndGradeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.task, self.available = fixture()

    def test_oracle_wrong_invalid_and_fault_verdicts(self) -> None:
        self.assertEqual(
            grade_gsm8k(
                self.task,
                f"work\nFINAL_ANSWER: {SYNTHETIC_ANSWER}",
                self.available,
            ).verdict,
            Verdict.PASS,
        )
        self.assertEqual(
            grade_gsm8k(
                self.task,
                f"FINAL_ANSWER: {SYNTHETIC_WRONG_ANSWER}",
                self.available,
            ).verdict,
            Verdict.TASK_FAILURE,
        )
        for output in (
            "no committed marker",
            f"FINAL_ANSWER: 0{SYNTHETIC_ANSWER}",
            (
                f"FINAL_ANSWER: {SYNTHETIC_ANSWER}\n"
                f"FINAL_ANSWER: {SYNTHETIC_WRONG_ANSWER}"
            ),
            f"FINAL_ANSWER: {SYNTHETIC_ANSWER} extra",
        ):
            with self.subTest(output=output):
                self.assertEqual(
                    grade_gsm8k(self.task, output, self.available).verdict,
                    Verdict.INVALID_SUBMISSION,
                )

        def broken_evaluator(_prediction: str, _authority: str) -> bool:
            raise RuntimeError("synthetic evaluator fault")

        self.assertEqual(
            grade_gsm8k(
                self.task,
                f"FINAL_ANSWER: {SYNTHETIC_ANSWER}",
                self.available,
                evaluator=broken_evaluator,
            ).verdict,
            Verdict.VERIFIER_FAILURE,
        )
        self.assertEqual(
            grade_gsm8k(
                self.task,
                f"FINAL_ANSWER: {SYNTHETIC_ANSWER}",
                {},
            ).verdict,
            Verdict.HARNESS_FAILURE,
        )

    def test_reward_input_tampering_changes_identity_or_blocks_admission(self) -> None:
        implementation = replace(
            self.task.verifier.evaluator,
            implementation_digest="sha256:" + "0" * 64,
        )
        parser = replace(
            self.task.verifier.parser,
            policy_id=self.task.verifier.evaluator.policy_id,
        )
        runtime = RuntimePolicy("CPython", ">=3.12,<4", ())
        mutations = {
            "evaluator": replace(self.task, verifier=replace(self.task.verifier, evaluator=implementation)),
            "parser": replace(self.task, verifier=replace(self.task.verifier, parser=parser)),
            "runtime": replace(self.task, verifier=replace(self.task.verifier, runtime_policy=runtime)),
            "answer": replace(
                self.task,
                answer_authority=SYNTHETIC_WRONG_ANSWER,
            ),
        }
        for label, changed in mutations.items():
            with self.subTest(label=label):
                self.assertNotEqual(changed.verifier.id if label != "answer" else changed.answer_authority, self.task.verifier.id if label != "answer" else self.task.answer_authority)
                with self.assertRaises(AdmissionError):
                    admit_task(changed, self.available)

        changed_task, changed_assets = fixture(source_bytes=b'{"question":"SYNTHETIC: changed"}')
        self.assertNotEqual(changed_task.public.id, self.task.public.id)
        self.assertNotEqual(changed_task.sealed.id, self.task.sealed.id)
        with self.assertRaises(AdmissionError):
            admit_task(self.task, changed_assets)

    def test_missing_and_extra_assets_fail_before_evaluation(self) -> None:
        for available in ({}, {**self.available, "unexpected.bin": b"x"}):
            with self.subTest(paths=sorted(available)):
                with self.assertRaises(AdmissionError):
                    admit_task(self.task, available)

        called = False

        def evaluator(_prediction: str, _authority: str) -> bool:
            nonlocal called
            called = True
            return True

        result = grade_gsm8k(
            self.task,
            f"FINAL_ANSWER: {SYNTHETIC_ANSWER}",
            {},
            evaluator=evaluator,
        )
        self.assertEqual(result.verdict, Verdict.HARNESS_FAILURE)
        self.assertFalse(called)


class PublicationReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.task, self.available = fixture()

    def test_atomic_publication_and_no_sealed_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            self.assertTrue(destination.is_dir())
            self.assertEqual(receipt.tree_snapshot_id, snapshot.id)
            combined = b"".join(path.read_bytes() for path in destination.iterdir())
            for secret in (
                SYNTHETIC_ANSWER.encode(),
                self.task.sealed.id.encode(),
                self.task.verifier.id.encode(),
                b"answer_authority",
            ):
                self.assertNotIn(secret, combined)

    def test_failed_commit_never_exposes_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "published"
            with mock.patch("parallax.artifacts.os.replace", side_effect=OSError("synthetic rename fault")):
                with self.assertRaises(OSError):
                    publish_public_task(destination, self.task)
            self.assertFalse(destination.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_locked_replay_is_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = make_replay_lock(receipt, snapshot, self.task)
            before = {path.name: path.read_bytes() for path in destination.iterdir()}
            replayed = replay_locked(destination, lock, self.task, self.available)
            self.assertEqual(before, replayed)

    def test_replay_rejects_mutation_and_unexpected_paths(self) -> None:
        for mutation in ("changed", "unexpected-file", "unexpected-directory"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory) / "published"
                receipt, snapshot = publish_public_task(destination, self.task)
                lock = make_replay_lock(receipt, snapshot, self.task)
                if mutation == "changed":
                    (destination / "task.json").write_bytes(b"changed")
                elif mutation == "unexpected-file":
                    (destination / "extra.txt").write_text("unexpected", encoding="utf-8")
                else:
                    (destination / "extra").mkdir()
                with self.assertRaises(ArtifactError):
                    replay_locked(destination, lock, self.task, self.available)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_replay_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = make_replay_lock(receipt, snapshot, self.task)
            os.symlink(destination / "task.json", destination / "escape")
            with self.assertRaisesRegex(ArtifactError, "symlink"):
                replay_locked(destination, lock, self.task, self.available)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_replay_rejects_symlink_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = make_replay_lock(receipt, snapshot, self.task)
            alias = Path(directory) / "alias"
            os.symlink(destination, alias)
            with self.assertRaisesRegex(ArtifactError, "root"):
                replay_locked(alias, lock, self.task, self.available)

    def test_replay_rejects_changed_verifier_and_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = make_replay_lock(receipt, snapshot, self.task)
            changed, changed_assets = fixture(SYNTHETIC_WRONG_ANSWER)
            with self.assertRaises(AdmissionError):
                replay_locked(destination, lock, changed, changed_assets)
            with self.assertRaises(AdmissionError):
                replay_locked(destination, lock, self.task, {"source-row.public.json": b"changed"})

    def test_tree_policy_defines_allowed_ignored_and_traversal(self) -> None:
        with self.assertRaises(ValueError):
            TreePolicy(("../escape",))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "kept.txt").write_text("kept", encoding="utf-8")
            (root / "ignored").mkdir()
            (root / "ignored" / "cache.bin").write_bytes(b"ignored")
            policy = TreePolicy(("kept.txt",), ("ignored",))
            snapshot = snapshot_tree(root, policy)
            self.assertEqual(tuple(entry.path for entry in snapshot.entries), ("kept.txt",))


if __name__ == "__main__":
    unittest.main()
