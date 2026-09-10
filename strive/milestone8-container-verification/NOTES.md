# Milestone 8 notes

- Scope: write a reproducible Linux verification container, apply real OS confinement to candidate and harness trees, and enable offline live tau2 qualification. No container execution or commits on this macOS host.
- Started by creating this investigation folder. Frozen contracts, verifier and ledger are out of scope; stop before any required change there.
- Initial repository status hit an existing git fsmonitor socket error; subsequent status reads disable fsmonitor. The supplied AGENTS.md instructions are in the conversation, with no root file on disk.

- Selected bubblewrap namespaces/mounts plus supervisor-owned cgroup v2 jobs. The existing effect-scoped inherited-pipe gateway is the only egress transport; no veth, IP route, host Unix socket, or DNS is exposed.
- Each child enters its configured memory/pids cgroup before bubblewrap forks. The jailed pre-exec check inspects seccomp, no-new-privs, capability removal, namespace separation, uid mapping and read-only/quota mounts. Capability detection runs this same path and does not fall back after an admitted jail fails.
- Image builds a minimal Python standard-library/Deno rootfs, excluding site-packages, the repository and home/config directories. A committed syscall allowlist compiles to native BPF in the image.
- No frozen contracts, verifier or ledger changes are needed so far. Native vendor CLI protocol qualification remains separate from proving the shared OS confinement backend.

- Host mypy initially reported circular inference for jail attributes; explicit field types fixed it. Strict mypy now passes.
- First targeted host run: 35 passed, 10 skipped, 2 failures. The network attack helper bound a host listener before its capability guard. Moved the guard to its first line so macOS skips before touching Linux-only test setup.
- Live adapter interpreter paths must preserve virtualenv symlinks: `.resolve()` silently selected the base Python. Both RPC paths now use `.absolute()`.
- The papercut CLI reported no repository opt-in, so no papercut log was created. Frictions are retained here instead.

- The first full-suite run exposed that sandbox.py is part of the M5 30-file core freeze, beyond the contracts/verifier/ledger named initially. Restored that file exactly from HEAD and verified its frozen hash. Moved Linux capture/profile selection into a separate CandidateSandbox subclass, selected at the unfrozen CLI and test composition roots. No freeze manifest or frozen file change remains.
- Interrupted the first full run after it exposed that freeze mismatch and a runtime-identity mismatch caused by concurrent source edits. Final validation must run after implementation edits stop.

- Final targeted validation after selecting the unfrozen subclass: 36 passed, 12 expected OS/tau2 skips in 10.72 seconds. A separate interpreter-path regression plus host capability tests passed 2 tests with 8 Linux skips. Strict mypy passed all 175 source files.
- Added recorded cgroup cleanup and a native setsid descendant probe. The live tau2 integration now kills separate processes after both agent and user SQLite commits, then verifies receipt recovery without repeated mutations.
- Started the final full vNext host suite with implementation source fixed. M7's recorded baseline took about 17 minutes, so progress is expected to be slow during workflow/replay cases.

- Container summary smoke-tested against synthetic JUnit reports: complete required gates exit 0; a missing inventory gate, skipped floor gate, or failing mypy exits 1. These are reporter checks only, not Linux/tau2 execution evidence. Results are labeled in reporter-smoke.json.
- Added separate root/tau2 Linux venv volumes to the development container and excluded old milestone caches, smoke directories and local agent settings from the build context.
- Saved the existing-file diff and a hash snapshot of implementation/test sources while the final suite runs. The final run passed the earlier freeze and runtime-pinning failure points without failures.

- An exact `uv run mypy --strict` retry reached the pre-existing macOS uv system-configuration panic during automatic environment sync (exit 101). Preserved it in uv-host-sync-error.txt. `UV_CACHE_DIR="$PWD/.cache/uv" uv run --no-sync mypy --strict` still passes all 175 files using the existing environment; the Linux entrypoint explicitly syncs first, then uses --no-sync for checks.

- Final full vNext host run completed with exit 0: 443 passed, 21 skipped, 1 xfailed in 893.48 seconds. The only expected failure is the existing EvaluateFork enactment gate. Linux/tau2 absence remains explicit in the skip reasons.
- Rechecked all 30 frozen core hashes and the implementation/test source snapshot after the full run; all match. No implementation edits occurred during final validation. No container was executed, no commit was made and no PR was opened.
