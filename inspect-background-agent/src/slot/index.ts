import type { CommitSha, LeaseEpoch, SlotId } from "../kernel/index.js";
import type { BranchName, EffectId, InstallationToken } from "../kernel/index.js";

export type Freshness =
  | { readonly kind: "unknown" }
  | { readonly kind: "stale"; readonly base: CommitSha; readonly origin: CommitSha }
  | { readonly kind: "syncing"; readonly base: CommitSha; readonly origin: CommitSha }
  | { readonly kind: "fresh"; readonly head: CommitSha }
  | { readonly kind: "diverged"; readonly base: CommitSha; readonly origin: CommitSha };

export function nextFreshness(args: {
  readonly current: Freshness;
  readonly base: CommitSha;
  readonly origin: CommitSha;
  readonly syncDone: boolean;
}): Freshness {
  const { base, origin, syncDone } = args;
  if (base === origin) {
    return { kind: "fresh", head: origin };
  }
  if (syncDone) {
    // Local fake: after sync we always land on origin. Diverged is reserved for
    // conflicts the compute adapter reports explicitly.
    return { kind: "fresh", head: origin };
  }
  if (args.current.kind === "syncing") {
    return { kind: "syncing", base, origin };
  }
  return { kind: "stale", base, origin };
}

export type ToolKind = "read" | "list" | "edit" | "write" | "bash";

export type ToolEffect = "read-only" | "mutating";

export function toolEffect(kind: ToolKind): ToolEffect {
  switch (kind) {
    case "read":
    case "list":
      return "read-only";
    case "edit":
    case "write":
    case "bash":
      return "mutating";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export interface LeasedSlot {
  readonly id: SlotId;
  readonly epoch: LeaseEpoch;
  freshness(): Freshness;
  read(path: string): Promise<string>;
  admitWrites(): Promise<MutableSlot>;
}

export interface MutableSlot extends LeasedSlot {
  write(path: string, content: string): Promise<void>;
  push(
    branch: BranchName,
    token: InstallationToken,
    effectId: EffectId,
  ): Promise<CommitSha>;
}
