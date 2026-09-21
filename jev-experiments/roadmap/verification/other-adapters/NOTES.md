# Go and Rust adapter verification notes

- Root requested final provider-free checks of the existing Go and Rust adapters using temporary official toolchains and isolated source copies.
- Host is macOS arm64. Go is absent. Existing rustup is available but no global default toolchain is configured. User-global PATH, profiles and toolchain defaults must remain unchanged.
- Downloaded toolchains, dependency caches and adapter copies will remain in a temporary directory, outside the repository. Only the reproduction script, compact JSON evidence and this report are retained.
- Python's default HTTPS certificate store failed to verify go.dev. Retried with system curl and its normal TLS verification; no certificate checks were disabled.
- Downloaded Go 1.23.12 for darwin/arm64 from the official Go distribution, matching the adapter's 1.23 module declaration and CI condition. Verified archive size and SHA-256 against official release metadata.
- Existing rustup 1.28.2 installed the official stable Rust 1.98.1 minimal profile into temporary RUSTUP_HOME/CARGO_HOME. No self-update or profile modification was requested. rustup verified component checksums.
- `go test ./...` passed; demo package has no tests. `cargo test --locked` passed all 5 library tests, plus empty binary/doc-test targets. No adapter changes were needed.
- The isolated source copies and original adapter source hashes stayed unchanged. Checked global Rust/Go configuration and shell-profile hashes stayed unchanged. All temporary toolchains, downloaded dependencies and build outputs were removed.
- Tightened the script after the first passing run because `rustup --version` implicitly installed the temporary selected toolchain before the explicit install command. Disabled implicit installation, moved the version query after installation and checked that resolved rustc/cargo paths are inside the temporary prefix. A fresh complete run passed again and its JSON is the retained result.
