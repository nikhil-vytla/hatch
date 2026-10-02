# strive on Harbor

[Harbor](https://github.com/harbor-framework/harbor) runs agents on
benchmarks, Terminal-Bench 2.0 among them, each task in its own container.
`strive_agent.py` makes strive one of its agents: Harbor copies Linux
builds of `strive` and `strive-tui` into the task's container and runs one
headless session, `strive run <instruction> --json`, with full-auto
approvals and strive's sandbox off (the container is the sandbox). The
session's journal is copied to the trial's agent logs (`strive.jsonl`,
`strive-sessions/`), and its tokens and exact cost are reported to Harbor.

## Build

```sh
bench/harbor/build-linux.sh arm64   # and/or amd64
```

This builds into `target/linux-<arch>/`. Rust is built in a Debian bullseye
container, so the binaries run on glibc 2.31 or later; that covers every
Terminal-Bench 2 image. It needs Docker or Podman. Terminal-Bench 2's
prebuilt images are amd64, so on Apple silicon they run under emulation and
need the amd64 build. Podman's Rosetta support makes that tolerable.

## Run

```sh
export ANTHROPIC_API_KEY=...            # passed into the container, nothing else is
PYTHONPATH=bench/harbor harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a strive_agent:Strive -m anthropic/claude-haiku-4-5 \
  --ak budget_usd=1.5
```

`budget_usd` is each session's spending limit, enforced by strive's
gateway, so a run costs at most `tasks × budget_usd`. With Podman, set
`DOCKER_HOST` to its socket first:

```sh
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
```

## A free check

`smoke-model.ts` is a scripted model that solves Harbor's `hello-world`
task. It checks the whole path, from building and installing through
running, scoring and reporting, without calling a provider:

```sh
bun bench/harbor/smoke-model.ts &    # prints its port
STRIVE_UPSTREAM_ANTHROPIC=http://host.containers.internal:PORT ANTHROPIC_API_KEY=sk-smoke \
  PYTHONPATH=bench/harbor harbor run -t hello-world/hello-world -a strive_agent:Strive \
  -m anthropic/claude-haiku-4-5
```

That run should report reward 1.0, 2 model calls, and $0.0024. The cost is
what the fake usage would cost at Haiku's prices; nothing is billed. Use
`host.docker.internal` with Docker.

## Not yet

- Learning across trials. Each container starts empty, so strive learns
  nothing from one task to the next. Exo's ordered datasets (`task_order.json`)
  show one way to do this: one task at a time, with the learned state carried
  between trials.
- Harbor's ATIF trajectory. Harbor gets usage, but not a step-by-step
  trajectory converted from strive's journal.
