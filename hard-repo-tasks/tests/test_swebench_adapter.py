from dataclasses import replace

from parallax.swebench import (
    SweBenchIntentArm,
    SweBenchSource,
    SweBenchVerifier,
    compile_swebench_arms,
)


def _source() -> SweBenchSource:
    return SweBenchSource(
        instance_id="django__django-11099",
        repo="django/django",
        base_commit="d26b2424437dabeeca94d7900b37d2df4410da0c",
        problem_statement="Reject trailing newlines in both username validators.",
        dataset="SWE-bench/SWE-bench_Lite",
        dataset_revision="69611d31007e1c6731db8bd5b5c3f2d33f5bab6e",
    )


def _verifier() -> SweBenchVerifier:
    return SweBenchVerifier(
        harness_revision="f7bbbb2ccdf479001d6467c9e34af59e44a840f9",
        test_patch="diff --git a/test.py b/test.py\n",
        fail_to_pass=("test_trailing_newline",),
        pass_to_pass=("test_help_text",),
    )


def test_compiled_arms_share_source_and_verifier_identity() -> None:
    episodes = compile_swebench_arms(
        _source(),
        _verifier(),
        orientation="Locate username validation ownership without editing.",
        plan="Plan an absolute-boundary change without editing.",
    )
    assert tuple(episode.arm for episode in episodes) == tuple(SweBenchIntentArm)
    assert [len(episode.turns) for episode in episodes] == [1, 3, 3]
    assert len({episode.source.digest for episode in episodes}) == 1
    assert len({episode.verifier.digest for episode in episodes}) == 1
    assert len({episode.task_id for episode in episodes}) == 3
    assert "trailing newlines" not in episodes[2].turns[0]
    assert _source().problem_statement in episodes[2].turns[-1]


def test_source_or_verifier_change_invalidates_episode_identity() -> None:
    source = _source()
    verifier = _verifier()
    original = compile_swebench_arms(
        source,
        verifier,
        orientation="Orient.",
        plan="Plan.",
    )[0]
    changed_source = compile_swebench_arms(
        replace(source, base_commit="different"),
        verifier,
        orientation="Orient.",
        plan="Plan.",
    )[0]
    changed_verifier = compile_swebench_arms(
        source,
        replace(verifier, test_patch="different"),
        orientation="Orient.",
        plan="Plan.",
    )[0]
    assert len({original.task_id, changed_source.task_id, changed_verifier.task_id}) == 3


def test_compiler_rejects_empty_generated_precursors() -> None:
    try:
        compile_swebench_arms(
            _source(),
            _verifier(),
            orientation="",
            plan="Plan.",
        )
    except ValueError as error:
        assert "non-empty" in str(error)
    else:
        raise AssertionError("empty generated precursors must be rejected")
