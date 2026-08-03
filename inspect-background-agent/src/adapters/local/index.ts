import type { Actor, ConversationRef, RepoRef } from "../../identity/index.js";
import type {
  ActorId,
  CommitSha,
  EffectId,
  SessionId,
  Timestamp,
  TurnId,
  WorkspaceId,
} from "../../kernel/index.js";
import {
  brandString,
  systemClock,
  type Clock,
} from "../../kernel/index.js";
import type { PullRequestView } from "../../session/index.js";
import type { Session } from "../../session/index.js";
import { createWorkspace, type Workspace } from "../../workspace/index.js";
import { createMemoryEventBus, type EventBus } from "../../control/event-bus.js";
import {
  createMemoryPromptIngress,
  type PromptIngress,
} from "../../control/prompt-ingress.js";
import {
  createLocalRunner,
  createScriptedAgent,
  type Runner,
} from "../../runner/index.js";

export type DispatchResult =
  | { readonly kind: "started"; readonly session: Session }
  | { readonly kind: "continued"; readonly session: Session }
  | { readonly kind: "ambiguous"; readonly candidates: readonly RepoRef[] }
  | { readonly kind: "unknown" };

export interface Inspect {
  workspace(repo: RepoRef): Promise<Workspace>;
  dispatch(msg: {
    readonly surface: "slack" | "web";
    readonly conversation: ConversationRef;
    readonly speaker: Actor;
    readonly text: string;
    readonly hints?: { readonly channelName?: string; readonly recentText?: string };
    readonly repo?: RepoRef;
  }): Promise<DispatchResult>;
  /** Hatch inspection seam for EventBus DO stand-in. */
  readonly eventBus: EventBus;
  readonly promptIngress: PromptIngress;
}

export type LocalPortsOptions = {
  readonly root?: string;
  readonly syncDelayMs?: number;
  readonly repos?: readonly RepoRef[];
  readonly clock?: Clock;
  readonly baseCommit?: string;
  readonly originCommit?: string;
};

export type LocalInspectState = {
  readonly workspaces: Map<string, Workspace>;
  readonly repos: RepoRef[];
  readonly clock: Clock;
  readonly syncDelayMs: number;
  readonly baseCommit: CommitSha;
  readonly originCommit: CommitSha;
  readonly installationToken: ReturnType<typeof brandString<"InstallationToken">>;
  readonly userTokens: Map<string, ReturnType<typeof brandString<"UserToken">>>;
  readonly prs: { next: number; byBranch: Map<string, PullRequestView> };
  readonly eventBus: EventBus;
  readonly promptIngress: PromptIngress;
  readonly runner: Runner;
  seq: number;
};

function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function classifyRepo(
  text: string,
  hints: { channelName?: string; recentText?: string } | undefined,
  repos: readonly RepoRef[],
):
  | { kind: "repo"; repo: RepoRef }
  | { kind: "ambiguous"; candidates: readonly RepoRef[] }
  | { kind: "unknown" } {
  const hay = `${text} ${hints?.channelName ?? ""} ${hints?.recentText ?? ""}`.toLowerCase();
  const hits = repos.filter(
    (r) => hay.includes(r.name.toLowerCase()) || hay.includes(r.owner.toLowerCase()),
  );
  if (hits.length === 1) return { kind: "repo", repo: hits[0]! };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  if (repos.length === 1) return { kind: "repo", repo: repos[0]! };
  return { kind: "unknown" };
}

export async function localPorts(opts: LocalPortsOptions = {}): Promise<{
  create: () => Inspect;
  state: LocalInspectState;
}> {
  const clock = opts.clock ?? systemClock();
  const eventBus = createMemoryEventBus();
  const promptIngress = createMemoryPromptIngress();
  const runner = createLocalRunner(createScriptedAgent());
  const state: LocalInspectState = {
    workspaces: new Map(),
    repos: [...(opts.repos ?? [{ owner: "acme", name: "billing" }])],
    clock,
    syncDelayMs: opts.syncDelayMs ?? 50,
    baseCommit: brandString<"CommitSha">(opts.baseCommit ?? "base000"),
    originCommit: brandString<"CommitSha">(opts.originCommit ?? "origin001"),
    installationToken: brandString<"InstallationToken">("install-token"),
    userTokens: new Map(),
    prs: { next: 1, byBranch: new Map() },
    eventBus,
    promptIngress,
    runner,
    seq: 0,
  };

  const ids = {
    workspace: () => brandString<"WorkspaceId">(`ws_${++state.seq}`),
    session: () => brandString<"SessionId">(`ses_${++state.seq}`),
    turn: () => brandString<"TurnId">(`trn_${++state.seq}`),
    effect: (label: string) => brandString<"EffectId">(`eff_${label}_${++state.seq}`),
    slot: () => `slot_${++state.seq}`,
  };

  function create(): Inspect {
    return {
      eventBus: state.eventBus,
      promptIngress: state.promptIngress,
      async workspace(repo: RepoRef): Promise<Workspace> {
        const key = repoKey(repo);
        const existing = state.workspaces.get(key);
        if (existing) return existing;
        if (!state.repos.some((r) => repoKey(r) === key)) {
          state.repos.push(repo);
        }
        const ws = createWorkspace({
          id: ids.workspace(),
          repo,
          branchPrefix: "inspect/",
          now: () => clock.now(),
          newSessionId: ids.session,
          newTurnId: ids.turn,
          newEffectId: ids.effect,
          newSlotId: ids.slot,
          syncDelayMs: state.syncDelayMs,
          baseCommit: state.baseCommit,
          originCommit: state.originCommit,
          installationToken: state.installationToken,
          userTokens: state.userTokens,
          prs: state.prs,
          eventBus: state.eventBus,
          promptIngress: state.promptIngress,
          runner: state.runner,
        });
        state.workspaces.set(key, ws);
        return ws;
      },
      async dispatch(msg) {
        let repo = msg.repo;
        if (!repo) {
          const classified = classifyRepo(msg.text, msg.hints, state.repos);
          if (classified.kind === "ambiguous") {
            return { kind: "ambiguous" as const, candidates: classified.candidates };
          }
          if (classified.kind === "unknown") {
            return { kind: "unknown" as const };
          }
          repo = classified.repo;
        }
        const ws = await this.workspace(repo);
        const before = await ws.stats();
        const session = await ws.start({
          opener: msg.speaker,
          conversation: msg.conversation,
          intent: msg.text,
        });
        const after = await ws.stats();
        if (after.sessions > before.sessions) {
          return { kind: "started", session };
        }
        return { kind: "continued", session };
      },
    };
  }

  return { create, state };
}

export async function createInspect(
  ports: Awaited<ReturnType<typeof localPorts>>,
): Promise<Inspect> {
  return ports.create();
}

export type { ActorId, Timestamp, WorkspaceId, SessionId, TurnId, EffectId };
