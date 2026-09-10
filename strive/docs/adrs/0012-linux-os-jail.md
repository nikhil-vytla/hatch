# ADR-0012: Linux OS jail as the native confinement floor

Status: accepted and implemented; enforcement requires runtime qualification on
the executing Linux host. Supersedes ADR-0007's backend description for vNext.

## Context

Language permissions, CLI permission flags and RSS polling cannot establish hard
memory limits or confinement for an arbitrary native process tree. Generated
code must remain unable to reach host credentials, trusted stores or direct
external services even if it forks or bypasses the language runtime.

## Decision

Use a shared Linux jail for candidates and harness processes. Bubblewrap provides
user, mount, PID, network, IPC, UTS and cgroup namespaces. A retained read-only
runtime excludes host homes, repository files and privileged services. Seccomp
denies unlisted syscalls, cgroup v2 enforces memory and process limits, and bounded
tmpfs supplies scratch. Harness model traffic uses only the authenticated
inherited gateway pipe. Privileges are dropped before payload execution.

Qualify the complete jail by launching it and checking kernel-visible controls,
runtime identities and attack probes. Retain cgroup and boot identity for
whole-tree recovery. Bound startup separately from candidate execution, and
accept readiness only from the trusted bootstrap. Once the jail is selected,
launch failure cannot fall back to weaker permissions.

## Consequences

The prepared container needs namespace support and delegated cgroup controllers.
The verification entrypoint fails if required jail tests skip. Unsupported hosts
retain an explicitly limited Deno permission implementation;
`STRIVE_REQUIRE_JAIL=1` requires the OS floor. Host-only tests cannot qualify
Linux enforcement. Jail availability also does not qualify a vendor CLI's model
request behavior or authorize a funded campaign.

See [architecture](../ARCHITECTURE.md#confinement-and-model-harnesses),
[ADR-0009](0009-harness-as-model.md) and [verification commands](../HANDOFF.md).
