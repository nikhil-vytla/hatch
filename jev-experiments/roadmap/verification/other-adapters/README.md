# Go and Rust adapter verification

Both existing adapter suites passed on macOS arm64 without changing either adapter.

| Adapter | Temporary toolchain | Command | Result |
| --- | --- | --- | --- |
| Go | Go 1.23.12 | `go test ./...` | Adapter package passed; demo has no test files. |
| Rust | rustc 1.98.1, cargo 1.98.1 | `cargo test --locked` | Five library tests passed; binary and doc-test targets had no tests. |

The [result JSON](../other-adapters.json) records source hashes, exact tool versions, commands, exit codes and output. The [reproduction script](../other-adapters.py) downloads a checksum-verified [official Go archive](https://go.dev/dl/) and uses existing rustup with [temporary configuration directories](https://rust-lang.github.io/rustup/environment-variables.html). It tests clean temporary source copies with separate dependency caches and build directories, then deletes those files. Go uses the latest 1.23 patch to match the existing module/CI condition; Rust resolves the current stable channel and records the exact selected version.

Both source copies and original adapters remained unchanged. Checked user-global Rust/Go configuration files and shell profiles also remained unchanged. Resolved rustc/cargo executable paths were verified inside the temporary prefix. The script makes no model-provider calls and uses no GPU.

To repeat on macOS arm64 with curl, Python 3.12+ and rustup available:

```sh
python3 jev-experiments/roadmap/verification/other-adapters.py
```

This check verifies existing adapter tests. It does not add test coverage or claim live provider integration.
