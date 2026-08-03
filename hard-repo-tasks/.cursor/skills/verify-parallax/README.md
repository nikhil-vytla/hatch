# Parallax verification skill

This project-local skill records how to verify the Parallax behavior that
exists today. The primary path is the `parallax` console script declared in
`pyproject.toml`; the Python package and HUD task listing are secondary paths.

The baseline proof copies the synthesis-kernel fixture into isolated scratch
state, runs `parallax build`, and runs `parallax build --locked` against the
generated lock. It keeps command output, both artifact trees, and complete
digests under `evidence/<run-id>/`, binds the exact dirty-worktree inputs with a
source manifest, then deletes only scratch state. The helper composes these
commands into repeatable proof capture; the direct CLI commands remain the user
path.

The fixture is deliberately labeled for what it is: a current GSM8K family
build using a hand-authored frozen proposal with placeholder prompt/response
digest strings. Its `school_supply_sales` context also does not match the
Natalia's clips source task. The run proves deterministic artifacts from exact
manifested bytes, not proposal provenance integrity, semantic validity,
Microsoft Evolving Intent generation, or upstream scheduler, renderer,
domain-asset, or paper-result parity.

Failed attempts keep a small failure receipt plus captured transcript,
stdout, and stderr. They do not publish partial stores, caches, credentials, or
other scratch contents.

Read `SKILL.md` for the executable workflow and `features/README.md` for the
map of current commands and library behavior.
