#!/bin/sh
# Runs strived's clippy and its sandbox, approval and MCP tests on Linux, in
# a container with bubblewrap: the only way to exercise the Linux sandbox
# from a Mac. Needs podman or docker. Tracked files only (commit or stage
# new ones first).
set -eu
cd "$(dirname "$0")/.."
engine=$(command -v podman || command -v docker)
job=.audit/linux
mkdir -p "$job"
git ls-files -z | tar --null -czf "$job/src.tgz" -T -
cat > "$job/run.sh" <<'INNER'
set -eu
apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap git >/dev/null 2>&1
bwrap --ro-bind / / --unshare-net --unshare-pid --die-with-parent true || { echo "bubblewrap doesn't work here" >&2; exit 1; }
mkdir /work && tar -xzf /job/src.tgz -C /work && cd /work
export CARGO_TARGET_DIR=/target
rustup component add clippy >/dev/null 2>&1
cargo clippy -q -p strived --all-targets -- -D warnings
cargo build -q -p strived --examples --bins
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY cargo test -q -p strived --test effects --test approvals --test mcp
INNER
# --privileged: bubblewrap needs user namespaces inside the container.
exec "$engine" run --rm --privileged -v "$PWD/$job":/job:ro -v strive-linux-target:/target \
  docker.io/library/rust:latest sh /job/run.sh
