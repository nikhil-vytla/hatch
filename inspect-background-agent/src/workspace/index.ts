import type { Actor, ConversationRef, RepoRef } from "../identity/index.js";
import { conversationKey } from "../identity/index.js";
import type {
  ActorId,
  EffectId,
  SessionId,
  Timestamp,
  TurnId,
  WorkspaceId,
} from "../kernel/index.js";
import {
  brandNumber,
  brandString,
} from "../kernel/index.js";
import {
  createSessionActor,
  type Session,
  type SessionPorts,
  type SessionRecord,
} from "../session/index.js";
import type { Freshness, LeasedSlot, MutableSlot } from "../slot/index.js";
import { nextFreshness } from "../slot/index.js";
import type { CommitSha, BranchName, InstallationToken, UserToken } from "../kernel/index.js";
import type { PullRequestView } from "../session/index.js";
import type { EventBus } from "../control/event-bus.js";
import type { PromptIngress } from "../control/prompt-ingress.js";
import type { Runner } from "../runner/index.js";

export type DemandHint = {
  readonly kind: "composing";
  readonly actorId: ActorId;
};

export interface Workspace {
  readonly id: WorkspaceId;
  readonly repo: RepoRef;
  start(req: {
    readonly opener: Actor;
    readonly conversation: ConversationRef;
    readonly intent?: string;
  }): Promise<Session>;
  hint(hint: DemandHint): void;
  stats(): Promise<{ readonly sessions: number; readonly humansPrompting: number }>;
}

export type WorkspaceDeps = {
  readonly id: WorkspaceId;
  readonly repo: RepoRef;
  readonly branchPrefix: string;
  readonly now: () => Timestamp;
  readonly newSessionId: () => SessionId;
  readonly newTurnId: () => TurnId;
  readonly newEffectId: (label: string) => EffectId;
  readonly newSlotId: () => string;
  readonly syncDelayMs: number;
  readonly baseCommit: CommitSha;
  readonly originCommit: CommitSha;
  readonly installationToken: InstallationToken;
  readonly userTokens: Map<string, UserToken>;
  readonly prs: { next: number; byBranch: Map<string, PullRequestView> };
  readonly eventBus: EventBus;
  readonly promptIngress: PromptIngress;
  readonly runner: Runner;
};

class LocalSlot implements LeasedSlot {
  readonly id;
  readonly epoch;
  private files = new Map<string, string>();
  private state: Freshness;
  private syncPromise: Promise<MutableSlot> | undefined;
  private readonly origin: CommitSha;
  private readonly base: CommitSha;
  private readonly syncDelayMs: number;

  constructor(args: {
    id: string;
    epoch: number;
    base: CommitSha;
    origin: CommitSha;
    syncDelayMs: number;
  }) {
    this.id = brandString<"SlotId">(args.id);
    this.epoch = brandNumber<"LeaseEpoch">(args.epoch);
    this.base = args.base;
    this.origin = args.origin;
    this.syncDelayMs = args.syncDelayMs;
    this.state = nextFreshness({
      current: { kind: "unknown" },
      base: args.base,
      origin: args.origin,
      syncDone: false,
    });
    this.files.set("README.md", `# ${args.id}\nbase=${args.base}\n`);
  }

  freshness(): Freshness {
    return this.state;
  }

  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }

  admitWrites(): Promise<MutableSlot> {
    if (this.state.kind === "fresh") {
      return Promise.resolve(this.asMutable());
    }
    if (this.syncPromise) return this.syncPromise;
    this.state = { kind: "syncing", base: this.base, origin: this.origin };
    this.syncPromise = new Promise((resolve) => {
      setTimeout(() => {
        this.state = nextFreshness({
          current: this.state,
          base: this.origin,
          origin: this.origin,
          syncDone: true,
        });
        this.files.set(
          "README.md",
          `# synced\nhead=${this.origin}\n`,
        );
        resolve(this.asMutable());
      }, this.syncDelayMs);
    });
    return this.syncPromise;
  }

  private asMutable(): MutableSlot {
    const self = this;
    return {
      id: self.id,
      epoch: self.epoch,
      freshness: () => self.freshness(),
      read: (p) => self.read(p),
      admitWrites: () => self.admitWrites(),
      async write(path: string, content: string) {
        if (self.freshness().kind !== "fresh") {
          throw new Error("write before admitWrites completed");
        }
        self.files.set(path, content);
      },
      async push(branch: BranchName, _token: InstallationToken, _effectId: EffectId) {
        if (self.freshness().kind !== "fresh") {
          throw new Error("push before fresh");
        }
        self.files.set(".branch", branch);
        return self.origin;
      },
    };
  }
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  const sessions = new Map<string, Session>();
  const byConversation = new Map<string, SessionId>();
  let warmHints = 0;
  let epoch = 1;

  const workspace: Workspace = {
    id: deps.id,
    repo: deps.repo,
    hint(_hint: DemandHint) {
      warmHints += 1;
      // Coalesced: just counts demand. Pool fill is a no-op at hatch target=0
      // beyond ensuring the next start sees recent hint activity.
    },
    async stats() {
      return {
        sessions: sessions.size,
        humansPrompting: warmHints > 0 ? 1 : 0,
      };
    },
    async start(req) {
      const key = conversationKey(req.conversation);
      const existingId = byConversation.get(key);
      if (existingId) {
        const existing = sessions.get(existingId);
        if (existing) {
          if (req.intent) {
            await existing.submit({
              author: req.opener,
              text: req.intent,
            });
          }
          return existing;
        }
      }

      const id = deps.newSessionId();
      const record: SessionRecord = {
        id,
        repo: deps.repo,
        opener: req.opener,
        conversation: req.conversation,
        turns: [],
        queuePaused: false,
        lastSeq: 0,
        events: [],
        ideUrl: null,
        vncUrl: null,
        ttyUrl: null,
      };

      const ports: SessionPorts = {
        branchPrefix: deps.branchPrefix,
        workspaceId: deps.id,
        now: deps.now,
        newTurnId: deps.newTurnId,
        newEffectId: deps.newEffectId,
        eventBus: deps.eventBus,
        sidecars: (sessionId) => deps.runner.sidecars(sessionId),
        async acquireSlot() {
          const slot = new LocalSlot({
            id: deps.newSlotId(),
            epoch: epoch++,
            base: deps.baseCommit,
            origin: deps.originCommit,
            syncDelayMs: deps.syncDelayMs,
          });
          return slot;
        },
        runTurn: (args) => deps.runner.runTurn(args),
        async installationToken() {
          return deps.installationToken;
        },
        async userTokenFor(actorId: ActorId) {
          const token = deps.userTokens.get(actorId);
          if (!token) {
            const minted = brandString<"UserToken">(`user-token:${actorId}`);
            deps.userTokens.set(actorId, minted);
            return minted;
          }
          return token;
        },
        async openPullRequest({ repo, branch, title, token, effectId }) {
          void effectId;
          void token;
          const existing = deps.prs.byBranch.get(branch);
          if (existing) return existing;
          const number = deps.prs.next++;
          const pr: PullRequestView = {
            number,
            url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
            branch,
          };
          deps.prs.byBranch.set(branch, pr);
          return pr;
        },
      };

      const session = createSessionActor(record, ports);
      sessions.set(id, session);
      byConversation.set(key, id);

      if (req.intent) {
        await session.submit({ author: req.opener, text: req.intent });
      }
      return session;
    },
  };

  return workspace;
}
