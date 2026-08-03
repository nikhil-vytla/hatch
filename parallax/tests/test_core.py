from __future__ import annotations

import inspect
import os
import shutil
import stat
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import parallax.artifacts as artifact_module  # noqa: E402
from parallax import (  # noqa: E402
    AdmissionError,
    ArtifactError,
    ArtifactPathError,
    CanonicalValueError,
    DomainSourceIdentity,
    PUBLIC_TREE_POLICY,
    PublicationDurabilityError,
    PublicationStateError,
    ReplayLock,
    TreePolicy,
    Verdict,
    admit_task,
    build_task,
    canonical_bytes,
    grade_gsm8k,
    make_replay_lock,
    parse_final_answer,
    publish_public_task,
    replay_locked,
    snapshot_tree,
    source_asset_manifest,
)
from parallax.records import RuntimePolicy  # noqa: E402

SYNTHETIC_SOURCE = b'{"question":"SYNTHETIC: add two counters"}'
# These invented constants are not GSM8K benchmark answers.
SYNTHETIC_ANSWER = "314159"
SYNTHETIC_WRONG_ANSWER = "271828"
PHYSICAL_TEMP_ROOT = Path(tempfile.gettempdir()).resolve()


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


def replay_lock(receipt, snapshot, task):
    return make_replay_lock(receipt, snapshot, task, PUBLIC_TREE_POLICY)


def artifact_temp_directory():
    return tempfile.TemporaryDirectory(dir=PHYSICAL_TEMP_ROOT)


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
        self.assertNotIn(SYNTHETIC_ANSWER.encode(), public_bytes)
        self.assertNotIn(first.verifier.id.encode(), public_bytes)


class AdmissionAndGradeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.task, self.available = fixture()

    def test_oracle_wrong_invalid_and_internal_fault_verdicts(self) -> None:
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
            f"FINAL_ANSWER: {SYNTHETIC_ANSWER} extra",
            f"FINAL_ANSWER: {SYNTHETIC_ANSWER}\nFINAL_ANSWER: {SYNTHETIC_WRONG_ANSWER}",
        ):
            with self.subTest(output=output):
                self.assertEqual(
                    grade_gsm8k(self.task, output, self.available).verdict,
                    Verdict.INVALID_SUBMISSION,
                )

        class ExplodingText(str):
            def splitlines(self, *args, **kwargs):
                raise RuntimeError("synthetic parser fault")

        fault = grade_gsm8k(self.task, ExplodingText("unused"), self.available)
        self.assertEqual(fault.verdict, Verdict.VERIFIER_FAILURE)
        self.assertEqual(
            grade_gsm8k(self.task, f"FINAL_ANSWER: {SYNTHETIC_ANSWER}", {}).verdict,
            Verdict.HARNESS_FAILURE,
        )

    def test_public_grading_api_accepts_data_not_callables(self) -> None:
        public_apis = (
            admit_task,
            build_task,
            grade_gsm8k,
            parse_final_answer,
            source_asset_manifest,
        )
        prohibited_callbacks = {"digest", "evaluator", "parser", "result", "runtime"}
        for api in public_apis:
            with self.subTest(api=api.__name__):
                signature = inspect.signature(api)
                self.assertTrue(prohibited_callbacks.isdisjoint(signature.parameters))
                self.assertNotIn("Callable", str(signature))
        self.assertEqual(
            tuple(inspect.signature(grade_gsm8k).parameters),
            ("task", "submission", "available_assets"),
        )
        with self.assertRaises(TypeError):
            grade_gsm8k(
                self.task,
                f"FINAL_ANSWER: {SYNTHETIC_WRONG_ANSWER}",
                self.available,
                evaluator=lambda _prediction, _authority: True,
            )
        self.assertEqual(
            grade_gsm8k(
                self.task,
                f"FINAL_ANSWER: {SYNTHETIC_WRONG_ANSWER}",
                self.available,
            ).verdict,
            Verdict.TASK_FAILURE,
        )

    def test_loaded_code_commitment_does_not_read_source_file(self) -> None:
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("disk read")):
            admit_task(self.task, self.available)
            result = grade_gsm8k(
                self.task,
                f"FINAL_ANSWER: {SYNTHETIC_ANSWER}",
                self.available,
            )
        self.assertEqual(result.verdict, Verdict.PASS)

    def test_answer_authority_and_parser_share_canonical_boundaries(self) -> None:
        hundred_digits = "9" * 100
        task, available = fixture(hundred_digits)
        self.assertEqual(
            grade_gsm8k(task, f"FINAL_ANSWER: {hundred_digits}", available).verdict,
            Verdict.PASS,
        )
        with self.assertRaisesRegex(ValueError, "100-digit"):
            fixture("9" * 101)
        with self.assertRaisesRegex(Exception, "100-digit"):
            parse_final_answer(f"FINAL_ANSWER: {'9' * 101}")
        negative, negative_assets = fixture("-42")
        self.assertEqual(
            grade_gsm8k(negative, "FINAL_ANSWER: -42", negative_assets).verdict,
            Verdict.PASS,
        )
        for answer in ("", " 1", "1 ", "+1", "01", "-0", "--1", "1.0"):
            with self.subTest(answer=answer):
                with self.assertRaises(ValueError):
                    fixture(answer)
                with self.assertRaises(Exception):
                    parse_final_answer(f"FINAL_ANSWER: {answer}")

    def test_reward_input_and_runtime_tampering_blocks_admission(self) -> None:
        implementation = replace(
            self.task.verifier.evaluator,
            implementation_digest="sha256:" + "0" * 64,
        )
        parser = replace(
            self.task.verifier.parser,
            policy_id=self.task.verifier.evaluator.policy_id,
        )
        runtime = RuntimePolicy("cpython", "0.0.0", "cpython-00", ())
        mutations = {
            "evaluator": replace(self.task, verifier=replace(self.task.verifier, evaluator=implementation)),
            "parser": replace(self.task, verifier=replace(self.task.verifier, parser=parser)),
            "runtime": replace(self.task, verifier=replace(self.task.verifier, runtime_policy=runtime)),
            "answer": replace(self.task, answer_authority=SYNTHETIC_WRONG_ANSWER),
        }
        for label, changed in mutations.items():
            with self.subTest(label=label):
                with self.assertRaises(AdmissionError):
                    admit_task(changed, self.available)

        changed_task, changed_assets = fixture(source_bytes=b'{"question":"SYNTHETIC: changed"}')
        self.assertNotEqual(changed_task.public.id, self.task.public.id)
        self.assertNotEqual(changed_task.sealed.id, self.task.sealed.id)
        with self.assertRaises(AdmissionError):
            admit_task(self.task, changed_assets)

    def test_missing_and_extra_assets_fail_before_parsing(self) -> None:
        class ExplodingText(str):
            def splitlines(self, *args, **kwargs):
                raise AssertionError("parser must not execute")

        for available in ({}, {**self.available, "unexpected.bin": b"x"}):
            with self.subTest(paths=sorted(available)):
                with self.assertRaises(AdmissionError):
                    admit_task(self.task, available)
                result = grade_gsm8k(self.task, ExplodingText("unused"), available)
                self.assertEqual(result.verdict, Verdict.HARNESS_FAILURE)


class PortablePathTests(unittest.TestCase):
    def test_cross_platform_nonportable_paths_are_rejected_lexically(self) -> None:
        invalid = (
            "C:/escape",
            "C:\\escape",
            "\\\\server\\share",
            "/absolute",
            "../parent",
            "a/../parent",
            "a/./dot",
            "a//empty",
            "back\\slash",
            "CON",
            "con.txt",
            "CONIN$",
            "conout$.json",
            "CLOCK$",
            "AUX.json",
            "COM1",
            "COM¹.txt",
            "com²",
            "CoM³.log",
            "LPT9.log",
            "LPT¹",
            "lpt².txt",
            "LpT³.bin",
            "name.",
            "name ",
            "CON .txt",
            "stream:name",
            "wild*card",
            "line\nbreak",
            "tab\tname",
            "delete\x7fname",
            "nul\x00byte",
            "e\u0301.txt",
        )
        for path in invalid:
            with self.subTest(path=repr(path)):
                with self.assertRaises(ValueError):
                    TreePolicy((path,))
        self.assertEqual(TreePolicy(("nested/portable-name.json",)).allowed_paths[0], "nested/portable-name.json")

    def test_windows_reserved_name_table_with_extensions_is_rejected(self) -> None:
        reserved = (
            "CON",
            "PRN",
            "AUX",
            "NUL",
            "CONIN$",
            "CONOUT$",
            "CLOCK$",
            *(f"COM{suffix}" for suffix in "123456789¹²³"),
            *(f"LPT{suffix}" for suffix in "123456789¹²³"),
        )
        for name in reserved:
            for candidate in (name, name.lower(), f"{name}.txt", f"{name} .json"):
                with self.subTest(candidate=candidate):
                    with self.assertRaises(ValueError):
                        TreePolicy((candidate,))


class PublicationReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.task, self.available = fixture()

    def test_atomic_publication_and_no_sealed_data(self) -> None:
        with artifact_temp_directory() as directory:
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

    def test_rename_failure_never_exposes_destination(self) -> None:
        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            with mock.patch("parallax.artifacts.os.replace", side_effect=OSError("synthetic rename fault")):
                with self.assertRaises(ArtifactPathError) as raised:
                    publish_public_task(destination, self.task)
            self.assertIsInstance(raised.exception.__cause__, OSError)
            self.assertFalse(destination.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_staging_open_failure_removes_new_directory(self) -> None:
        with artifact_temp_directory() as directory:
            parent = Path(directory)
            opened_parent = artifact_module._open_directory_path(parent)
            real_open = artifact_module.os.open

            def failing_staging_open(path, flags, mode=0o777, *, dir_fd=None):
                if isinstance(path, str) and path.startswith(".parallax-staging-"):
                    raise OSError("synthetic staging open fault")
                return real_open(path, flags, mode, dir_fd=dir_fd)

            try:
                with mock.patch("parallax.artifacts.os.open", side_effect=failing_staging_open):
                    with self.assertRaises(ArtifactPathError) as raised:
                        artifact_module._make_staging(opened_parent.target_fd)
                self.assertIsInstance(raised.exception.__cause__, OSError)
                self.assertEqual(list(parent.iterdir()), [])
            finally:
                opened_parent.close()

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlinked_parent_component_fails_closed(self) -> None:
        with artifact_temp_directory() as directory:
            root = Path(directory)
            real_parent = root / "real-parent"
            real_parent.mkdir()
            alias = root / "parent-alias"
            os.symlink(real_parent, alias)
            with self.assertRaises(ArtifactPathError) as raised:
                publish_public_task(alias / "published", self.task)
            self.assertIsInstance(raised.exception.__cause__, OSError)
            self.assertEqual(list(real_parent.iterdir()), [])

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_root_swap_to_symlink_fails_closed(self) -> None:
        with artifact_temp_directory() as directory:
            parent = Path(directory)
            root = parent / "protected-root"
            root.mkdir()
            (root / "kept.txt").write_text("kept", encoding="utf-8")
            backup = parent / "protected-root-original"
            policy = TreePolicy(("kept.txt",))
            real_open = artifact_module.os.open
            swapped = False

            def swapping_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal swapped
                if path == root.name and dir_fd is not None and not swapped:
                    root.rename(backup)
                    os.symlink(backup, root)
                    swapped = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch("parallax.artifacts.os.open", side_effect=swapping_open):
                with self.assertRaises(ArtifactPathError) as raised:
                    snapshot_tree(root, policy)
            self.assertIsInstance(raised.exception.__cause__, OSError)

    def test_parent_directory_swap_during_publication_cleans_orphan(self) -> None:
        with artifact_temp_directory() as directory:
            root = Path(directory)
            parent = root / "requested-parent"
            parent.mkdir()
            moved_parent = root / "moved-parent"
            destination = parent / "published"
            real_replace = artifact_module.os.replace

            def swapping_replace(source, target, *, src_dir_fd, dst_dir_fd):
                parent.rename(moved_parent)
                parent.mkdir()
                return real_replace(
                    source,
                    target,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                )

            with mock.patch("parallax.artifacts.os.replace", side_effect=swapping_replace):
                with self.assertRaises(PublicationStateError) as raised:
                    publish_public_task(destination, self.task)
            error = raised.exception
            self.assertFalse(error.requested_path_visible)
            self.assertFalse(error.destination_visible)
            self.assertFalse(error.complete_orphan)
            self.assertEqual(error.artifact_state, "removed")
            self.assertEqual(error.orphan_state, "none")
            self.assertTrue(error.cleanup_attempted)
            self.assertTrue(error.cleanup_succeeded)
            self.assertFalse(destination.exists())
            self.assertFalse((moved_parent / "published").exists())

    def test_parent_swap_cleanup_failure_reports_complete_orphan(self) -> None:
        with artifact_temp_directory() as directory:
            root = Path(directory)
            parent = root / "requested-parent"
            parent.mkdir()
            moved_parent = root / "moved-parent"
            destination = parent / "published"
            real_replace = artifact_module.os.replace

            def swapping_replace(source, target, *, src_dir_fd, dst_dir_fd):
                parent.rename(moved_parent)
                parent.mkdir()
                return real_replace(
                    source,
                    target,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                )

            with (
                mock.patch("parallax.artifacts.os.replace", side_effect=swapping_replace),
                mock.patch(
                    "parallax.artifacts._cleanup_published",
                    return_value=artifact_module._CleanupOutcome(False, False),
                ),
            ):
                with self.assertRaises(PublicationStateError) as raised:
                    publish_public_task(destination, self.task)
            error = raised.exception
            self.assertFalse(error.requested_path_visible)
            self.assertTrue(error.complete_orphan)
            self.assertFalse(error.partial_orphan)
            self.assertEqual(error.artifact_state, "complete")
            self.assertEqual(error.orphan_state, "complete")
            self.assertTrue(error.cleanup_attempted)
            self.assertFalse(error.cleanup_succeeded)
            self.assertFalse(destination.exists())
            self.assertTrue((moved_parent / "published" / "task.json").is_file())

    def test_parent_swap_partial_cleanup_is_reported(self) -> None:
        with artifact_temp_directory() as directory:
            root = Path(directory)
            parent = root / "requested-parent"
            parent.mkdir()
            moved_parent = root / "moved-parent"
            destination = parent / "published"
            real_replace = artifact_module.os.replace

            def swapping_replace(source, target, *, src_dir_fd, dst_dir_fd):
                parent.rename(moved_parent)
                parent.mkdir()
                return real_replace(
                    source,
                    target,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                )

            with (
                mock.patch("parallax.artifacts.os.replace", side_effect=swapping_replace),
                mock.patch(
                    "parallax.artifacts.os.rmdir",
                    side_effect=OSError("synthetic cleanup fault"),
                ),
            ):
                with self.assertRaises(PublicationStateError) as raised:
                    publish_public_task(destination, self.task)
            error = raised.exception
            self.assertFalse(error.requested_path_visible)
            self.assertFalse(error.complete_orphan)
            self.assertTrue(error.partial_orphan)
            self.assertEqual(error.artifact_state, "partial")
            self.assertEqual(error.orphan_state, "partial")
            self.assertFalse(destination.exists())
            self.assertEqual(list((moved_parent / "published").iterdir()), [])

    def test_ancestor_swap_and_swap_back_before_publication_acceptance(self) -> None:
        with artifact_temp_directory() as directory:
            root = Path(directory)
            ancestor = root / "ancestor"
            parent = ancestor / "parent"
            parent.mkdir(parents=True)
            moved_ancestor = root / "moved-ancestor"
            destination = parent / "published"
            real_replace = artifact_module.os.replace

            def swapping_back_replace(source, target, *, src_dir_fd, dst_dir_fd):
                ancestor.rename(moved_ancestor)
                (ancestor / "parent").mkdir(parents=True)
                result = real_replace(
                    source,
                    target,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                )
                (ancestor / "parent").rmdir()
                ancestor.rmdir()
                moved_ancestor.rename(ancestor)
                return result

            with mock.patch("parallax.artifacts.os.replace", side_effect=swapping_back_replace):
                receipt, snapshot = publish_public_task(destination, self.task)
            self.assertTrue(destination.is_dir())
            self.assertEqual(receipt.tree_snapshot_id, snapshot.id)
            self.assertFalse(moved_ancestor.exists())

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_file_swap_to_symlink_has_artifact_path_error_taxonomy(self) -> None:
        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = replay_lock(receipt, snapshot, self.task)
            task_path = destination / "task.json"
            backup = destination / "task-original.json"
            real_open = artifact_module.os.open
            swapped = False

            def swapping_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal swapped
                if path == "task.json" and dir_fd is not None and not swapped:
                    task_path.rename(backup)
                    os.symlink(backup, task_path)
                    swapped = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch("parallax.artifacts.os.open", side_effect=swapping_open):
                with self.assertRaises(ArtifactPathError) as raised:
                    replay_locked(
                        destination,
                        lock,
                        self.task,
                        self.available,
                        PUBLIC_TREE_POLICY,
                    )
            self.assertIsInstance(raised.exception.__cause__, OSError)

    def test_tamper_during_rename_is_cleaned_and_reported(self) -> None:
        original_replace = artifact_module.os.replace

        def tampering_replace(source, destination, *, src_dir_fd, dst_dir_fd):
            staging_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY, dir_fd=src_dir_fd)
            try:
                file_fd = os.open("task.json", os.O_WRONLY | os.O_TRUNC, dir_fd=staging_fd)
                try:
                    os.write(file_fd, b"tampered")
                finally:
                    os.close(file_fd)
            finally:
                os.close(staging_fd)
            return original_replace(
                source,
                destination,
                src_dir_fd=src_dir_fd,
                dst_dir_fd=dst_dir_fd,
            )

        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            with mock.patch("parallax.artifacts.os.replace", side_effect=tampering_replace):
                with self.assertRaises(PublicationStateError) as raised:
                    publish_public_task(destination, self.task)
            self.assertFalse(raised.exception.destination_visible)
            self.assertTrue(raised.exception.cleanup_succeeded)
            self.assertTrue(raised.exception.durability_indeterminate)
            self.assertFalse(destination.exists())

    def test_parent_fsync_failure_reports_visible_complete_publication(self) -> None:
        real_fsync = artifact_module.os.fsync

        def failing_parent_fsync(file_descriptor):
            if stat.S_ISDIR(os.fstat(file_descriptor).st_mode):
                raise OSError("synthetic parent fsync fault")
            return real_fsync(file_descriptor)

        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            with mock.patch("parallax.artifacts.os.fsync", side_effect=failing_parent_fsync):
                with self.assertRaises(PublicationDurabilityError) as raised:
                    publish_public_task(destination, self.task)
            error = raised.exception
            self.assertTrue(error.destination_visible)
            self.assertTrue(error.durability_indeterminate)
            self.assertEqual(error.receipt.tree_snapshot_id, error.snapshot.id)
            self.assertTrue(destination.is_dir())
            self.assertEqual(artifact_module.verify_publication(destination, self.task), error.receipt.artifact_manifest_id)

    def test_locked_replay_returns_single_verified_capture(self) -> None:
        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = replay_lock(receipt, snapshot, self.task)
            original_task_bytes = (destination / "task.json").read_bytes()
            real_verify = artifact_module._verify_public_capture

            def verify_then_tamper(capture, task):
                manifest_id = real_verify(capture, task)
                (destination / "task.json").write_bytes(b"changed after verification")
                return manifest_id

            with mock.patch("parallax.artifacts._verify_public_capture", side_effect=verify_then_tamper):
                replayed = replay_locked(
                    destination,
                    lock,
                    self.task,
                    self.available,
                    PUBLIC_TREE_POLICY,
                )
            self.assertEqual(replayed["task.json"], original_task_bytes)
            self.assertNotEqual(replayed["task.json"], (destination / "task.json").read_bytes())

    def test_root_directory_swap_during_replay_is_rejected(self) -> None:
        with artifact_temp_directory() as directory:
            parent = Path(directory)
            destination = parent / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = replay_lock(receipt, snapshot, self.task)
            moved_original = parent / "moved-original"
            attacker = parent / "attacker"
            shutil.copytree(destination, attacker)
            (attacker / "task.json").write_bytes(b"attacker tree")
            attacker_identity = (attacker.stat().st_dev, attacker.stat().st_ino)
            real_verify = artifact_module._verify_public_capture

            def verify_then_swap_root(capture, task):
                manifest_id = real_verify(capture, task)
                destination.rename(moved_original)
                attacker.rename(destination)
                return manifest_id

            with mock.patch(
                "parallax.artifacts._verify_public_capture",
                side_effect=verify_then_swap_root,
            ):
                with self.assertRaisesRegex(
                    ArtifactPathError, "ancestry changed"
                ):
                    replay_locked(
                        destination,
                        lock,
                        self.task,
                        self.available,
                        PUBLIC_TREE_POLICY,
                    )
            self.assertEqual(
                (destination.stat().st_dev, destination.stat().st_ino),
                attacker_identity,
            )
            self.assertEqual((destination / "task.json").read_bytes(), b"attacker tree")
            self.assertTrue((moved_original / "task.json").is_file())

    def test_ancestor_directory_swap_during_replay_is_rejected(self) -> None:
        with artifact_temp_directory() as directory:
            parent = Path(directory)
            ancestor = parent / "ancestor"
            destination = ancestor / "child" / "published"
            destination.parent.mkdir(parents=True)
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = replay_lock(receipt, snapshot, self.task)
            moved_ancestor = parent / "moved-ancestor"
            attacker_ancestor = parent / "attacker-ancestor"
            attacker_destination = attacker_ancestor / "child" / "published"
            shutil.copytree(destination, attacker_destination)
            (attacker_destination / "task.json").write_bytes(b"ancestor attacker")
            real_verify = artifact_module._verify_public_capture

            def verify_then_swap_ancestor(capture, task):
                manifest_id = real_verify(capture, task)
                ancestor.rename(moved_ancestor)
                attacker_ancestor.rename(ancestor)
                return manifest_id

            with mock.patch(
                "parallax.artifacts._verify_public_capture",
                side_effect=verify_then_swap_ancestor,
            ):
                with self.assertRaisesRegex(
                    ArtifactPathError, "ancestry changed"
                ):
                    replay_locked(
                        destination,
                        lock,
                        self.task,
                        self.available,
                        PUBLIC_TREE_POLICY,
                    )
            self.assertEqual(
                (destination / "task.json").read_bytes(),
                b"ancestor attacker",
            )
            self.assertTrue(
                (moved_ancestor / "child" / "published" / "task.json").is_file()
            )

    def test_replay_rejects_mutation_and_unexpected_paths(self) -> None:
        for mutation in ("changed", "unexpected-file", "unexpected-directory"):
            with self.subTest(mutation=mutation), artifact_temp_directory() as directory:
                destination = Path(directory) / "published"
                receipt, snapshot = publish_public_task(destination, self.task)
                lock = replay_lock(receipt, snapshot, self.task)
                if mutation == "changed":
                    (destination / "task.json").write_bytes(b"changed")
                elif mutation == "unexpected-file":
                    (destination / "extra.txt").write_text("unexpected", encoding="utf-8")
                else:
                    (destination / "extra").mkdir()
                with self.assertRaises(ArtifactError):
                    replay_locked(destination, lock, self.task, self.available, PUBLIC_TREE_POLICY)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_replay_rejects_symlinks_and_symlink_root(self) -> None:
        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = replay_lock(receipt, snapshot, self.task)
            os.symlink(destination / "task.json", destination / "escape")
            with self.assertRaisesRegex(ArtifactError, "symlink"):
                replay_locked(destination, lock, self.task, self.available, PUBLIC_TREE_POLICY)
            (destination / "escape").unlink()
            alias = Path(directory) / "alias"
            os.symlink(destination, alias)
            with self.assertRaises(ArtifactPathError) as raised:
                replay_locked(alias, lock, self.task, self.available, PUBLIC_TREE_POLICY)
            self.assertIsInstance(raised.exception.__cause__, OSError)

    def test_replay_rejects_changed_verifier_assets_and_policy(self) -> None:
        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            lock = replay_lock(receipt, snapshot, self.task)
            changed, changed_assets = fixture(SYNTHETIC_WRONG_ANSWER)
            with self.assertRaises(AdmissionError):
                replay_locked(destination, lock, changed, changed_assets, PUBLIC_TREE_POLICY)
            with self.assertRaises(AdmissionError):
                replay_locked(
                    destination,
                    lock,
                    self.task,
                    {"source-row.public.json": b"changed"},
                    PUBLIC_TREE_POLICY,
                )
            other_policy = TreePolicy(("other.json",))
            with self.assertRaisesRegex(ArtifactError, "policies disagree"):
                replay_locked(destination, lock, self.task, self.available, other_policy)

    def test_mismatched_receipt_policy_cannot_form_replay_lock(self) -> None:
        with artifact_temp_directory() as directory:
            destination = Path(directory) / "published"
            receipt, snapshot = publish_public_task(destination, self.task)
            other_policy = TreePolicy(("other.json",))
            mismatched = replace(receipt, tree_policy_id=other_policy.id)
            with self.assertRaisesRegex(ValueError, "policies disagree"):
                ReplayLock(mismatched, snapshot, self.task.verifier.id, self.task.assets.id)
            with self.assertRaisesRegex(ValueError, "must match"):
                make_replay_lock(mismatched, snapshot, self.task, PUBLIC_TREE_POLICY)

    def test_tree_policy_defines_allowed_ignored_and_traversal(self) -> None:
        with artifact_temp_directory() as directory:
            root = Path(directory)
            (root / "kept.txt").write_text("kept", encoding="utf-8")
            (root / "ignored").mkdir()
            (root / "ignored" / "cache.bin").write_bytes(b"ignored")
            policy = TreePolicy(("kept.txt",), ("ignored",))
            snapshot = snapshot_tree(root, policy)
            self.assertEqual(tuple(entry.path for entry in snapshot.entries), ("kept.txt",))


if __name__ == "__main__":
    unittest.main()
