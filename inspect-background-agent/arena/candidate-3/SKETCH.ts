/**
 * Inspect hatch — Axis C: capability-token session.
 *
 * Public surface: factory + narrow handles. No Session god-object.
 * Bodies are stubs; invariants live in the types.
 */

// ─── Brands & primitives ─────────────────────────────────────────────────────

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type PromptId = Brand<string, "PromptId">;
export type AuthorId = Brand<string, "AuthorId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type EventId = Brand<string, "EventId">;
export type GrantToken = Brand<string, "GrantToken">;
/** Opaque capability secret bound into each handle; not a Session. */
export type CapabilitySecret = Brand<string, "CapabilitySecret">;

export type Instant = Brand<number, "InstantMs">;

export type RepoRef = { readonly owner: string; readonly name: string };

export type Author = {
  readonly id: AuthorId;
  readonly displayName: string;
  readonly githubLogin: string;
};

// ─── Sync gate & lifecycle (encoded, not stringly) ───────────────────────────

/** Agent may read immediately; writes blocked until sync completes. */
export type SyncGate =
  | { readonly status: "pending"; readonly reads: "allowed"; readonly writes: "blocked" }
  | { readonly status: "ready"; readonly reads: "allowed"; readonly writes: "allowed" }
  | {
      readonly status: "failed";
      readonly reads: "allowed";
      readonly writes: "blocked";
      readonly error: string;
    };

/**
 * Session phase is a projection for status tools / UI.
 * Transitions are owned by the private session actor, not by callers.
 */
export type SessionPhase =
  | { readonly kind: "minted" }
  | { readonly kind: "warming" }
  | { readonly kind: "idle"; readonly gate: SyncGate }
  | { readonly kind: "running"; readonly promptId: PromptId; readonly gate: SyncGate }
  | { readonly kind: "stopping"; readonly promptId: PromptId }
  | { readonly kind: "snapshotting"; readonly reason: "idle_exit" | "resume_prepare" }
  | { readonly kind: "suspended"; readonly resumeFrom: SnapshotId }
  | { readonly kind: "failed"; readonly reason: string };

export type PromptQueueEntry =
  | {
      readonly state: "queued";
      readonly id: PromptId;
      readonly author: AuthorId;
      readonly text: string;
      readonly enqueuedAt: Instant;
    }
  | {
      readonly state: "running";
      readonly id: PromptId;
      readonly author: AuthorId;
      readonly text: string;
      readonly startedAt: Instant;
    }
  | {
      readonly state: "completed";
      readonly id: PromptId;
      readonly author: AuthorId;
      readonly completedAt: Instant;
    }
  | {
      readonly state: "stopped";
      readonly id: PromptId;
      readonly author: AuthorId;
      readonly stoppedAt: Instant;
    };

export type PromptQueueView = {
  readonly running: PromptQueueEntry | null;
  readonly pending: readonly PromptQueueEntry[];
  readonly recent: readonly PromptQueueEntry[]; // completed/stopped tail
};

// ─── Domain events (public stream; not transport frames) ─────────────────────

export type SessionEvent =
  | { readonly id: EventId; readonly type: "session.phase"; readonly phase: SessionPhase }
  | { readonly id: EventId; readonly type: "sandbox.sync"; readonly gate: SyncGate }
  | {
      readonly id: EventId;
      readonly type: "prompt.queued";
      readonly promptId: PromptId;
      readonly author: AuthorId;
    }
  | {
      readonly id: EventId;
      readonly type: "prompt.started";
      readonly promptId: PromptId;
      readonly author: AuthorId;
    }
  | {
      readonly id: EventId;
      readonly type: "prompt.completed";
      readonly promptId: PromptId;
    }
  | {
      readonly id: EventId;
      readonly type: "prompt.stopped";
      readonly promptId: PromptId;
    }
  | {
      readonly id: EventId;
      readonly type: "agent.token";
      readonly promptId: PromptId;
      readonly text: string;
    }
  | {
      readonly id: EventId;
      readonly type: "agent.status";
      readonly message: string;
    }
  | {
      readonly id: EventId;
      readonly type: "branch.pushed";
      readonly branch: string;
      readonly sha: string;
    }
  | {
      readonly id: EventId;
      readonly type: "pull_request.ready";
      readonly branch: string;
    }
  | {
      readonly id: EventId;
      readonly type: "pull_request.opened";
      readonly number: number;
      readonly url: string;
    }
  | {
      readonly id: EventId;
      readonly type: "child.spawned";
      readonly childSessionId: SessionId;
    };

export type GitHubLifecycleEvent =
  | {
      readonly type: "pull_request.merged" | "pull_request.closed";
      readonly sessionId: SessionId;
      readonly number: number;
    }
  | {
      readonly type: "branch.deleted";
      readonly sessionId: SessionId;
      readonly branch: string;
    };

// ─── Capability handles (public API) ─────────────────────────────────────────

/**
 * Authorship-bound prompt capability.
 * Enqueue is append-only; stop cancels the running prompt (idempotent).
 */
export interface PromptHandle {
  readonly sessionId: SessionId;
  readonly author: Author;
  grantToken(): GrantToken;
  enqueue(input: { text: string }): Promise<{ promptId: PromptId }>;
  /** Idempotent: second stop on same running prompt is a no-op success. */
  stop(): Promise<void>;
  queue(): Promise<PromptQueueView>;
}

/**
 * Sandbox observation + warm hint. Callers never drive sync/snapshot steps.
 * hintWarm may be called repeatedly (keystroke); coalesced internally.
 */
export interface SandboxHandle {
  readonly sessionId: SessionId;
  grantToken(): GrantToken;
  /** Fire-and-forget warm-on-keystroke. Idempotent / coalesced. */
  hintWarm(): void;
  gate(): Promise<SyncGate>;
  phase(): Promise<SessionPhase>;
  /** Present when code-server is up; null while warming/suspended. */
  ideUrl(): Promise<string | null>;
}

/** Realtime cursor over domain SessionEvent. */
export interface EventCursor {
  readonly sessionId: SessionId;
  grantToken(): GrantToken;
  subscribe(opts: {
    after: EventId | null;
  }): AsyncIterable<SessionEvent>;
}

/**
 * PR open capability. Branch push is sandbox-owned; this only opens the PR
 * with a user token validated at the boundary.
 */
export interface PullRequestHandle {
  readonly sessionId: SessionId;
  grantToken(): GrantToken;
  open(input: {
    title: string;
    body: string;
    userGithubToken: string;
  }): Promise<{ number: number; url: string }>;
}

/**
 * Narrow spawn/status surface for agent plugins (child sessions).
 * Not a general Session API.
 */
export interface SpawnHandle {
  readonly parentSessionId: SessionId;
  child(input: {
    repo?: RepoRef;
    prompt: string;
  }): Promise<{ sessionId: SessionId }>;
  status(sessionId: SessionId): Promise<{
    phase: SessionPhase;
    queue: PromptQueueView;
  }>;
}

/** Webhook / lifecycle only — no enqueue, no PR open. */
export interface LifecycleHandle {
  readonly sessionId: SessionId;
  /** Idempotent apply; duplicate deliveries safe. */
  apply(event: GitHubLifecycleEvent): Promise<void>;
}

/** Bundle minted once per mint/rehydrate. Not a facade with shared mutable methods. */
export type SessionCapabilities = {
  readonly sessionId: SessionId;
  readonly prompt: PromptHandle;
  readonly sandbox: SandboxHandle;
  readonly events: EventCursor;
  readonly pullRequest: PullRequestHandle;
  /** Attenuated spawn grant for wiring into the agent runtime plugin. */
  readonly spawn: SpawnHandle;
};

export type MintSpec = {
  readonly repo: RepoRef;
  readonly baseBranch: string;
  readonly author: Author;
};

// ─── Factory (public entry) ──────────────────────────────────────────────────

export interface InspectFactory {
  mint(spec: MintSpec): Promise<SessionCapabilities>;
  rehydrate(sessionId: SessionId, author: Author): Promise<SessionCapabilities>;

  /** Reconstitute a single capability from a browser/Slack grant token. */
  promptFromGrant(grant: GrantToken): Promise<PromptHandle>;
  sandboxFromGrant(grant: GrantToken): Promise<SandboxHandle>;
  eventsFromGrant(grant: GrantToken): Promise<EventCursor>;
  pullRequestFromGrant(grant: GrantToken): Promise<PullRequestHandle>;

  lifecycleFor(sessionId: SessionId): Promise<LifecycleHandle>;

  readonly github: GitHubWebhookParser;
}

export interface GitHubWebhookParser {
  /** Validates signature & parses to domain events; drops unrelated deliveries. */
  parseWebhook(raw: Request): Promise<GitHubLifecycleEvent | null>;
}

export function createInspect(adapters: InspectAdapters): InspectFactory {
  void adapters;
  throw new Error("not implemented");
}

// ─── Ports (adapters; not exported as caller surface) ────────────────────────

export interface InspectAdapters {
  readonly sessions: SessionActorPort;
  readonly sandboxes: SandboxPort;
  readonly images: ImageRegistryPort;
  readonly agent: AgentRuntimePort;
  readonly github: GitHubPort;
  readonly clock: () => Instant;
  readonly ids: IdFactory;
}

export interface IdFactory {
  sessionId(): SessionId;
  promptId(): PromptId;
  eventId(): EventId;
  snapshotId(): SnapshotId;
  capabilitySecret(): CapabilitySecret;
  grantToken(parts: {
    sessionId: SessionId;
    kind: CapabilityKind;
    secret: CapabilitySecret;
    authorId?: AuthorId;
  }): GrantToken;
}

export type CapabilityKind =
  | "prompt"
  | "sandbox"
  | "events"
  | "pull_request"
  | "spawn"
  | "lifecycle";

/**
 * Per-session actor port (Durable Object–shaped).
 * Owns queue, authorship set, event log, sandbox binding, phase.
 * Not part of the public caller API — only the factory/handles talk to it.
 */
export interface SessionActorPort {
  create(input: {
    sessionId: SessionId;
    repo: RepoRef;
    baseBranch: string;
    founder: Author;
  }): Promise<void>;
  attachAuthor(sessionId: SessionId, author: Author): Promise<void>;
  enqueue(
    sessionId: SessionId,
    author: Author,
    text: string,
    promptId: PromptId,
  ): Promise<void>;
  requestStop(sessionId: SessionId): Promise<void>;
  queueView(sessionId: SessionId): Promise<PromptQueueView>;
  phase(sessionId: SessionId): Promise<SessionPhase>;
  appendEvent(sessionId: SessionId, event: Omit<SessionEvent, "id">): Promise<SessionEvent>;
  readEvents(
    sessionId: SessionId,
    after: EventId | null,
  ): AsyncIterable<SessionEvent>;
  bindSandbox(
    sessionId: SessionId,
    binding: { sandboxId: string; resumeFrom?: SnapshotId },
  ): Promise<void>;
  setGate(sessionId: SessionId, gate: SyncGate): Promise<void>;
  setPhase(sessionId: SessionId, phase: SessionPhase): Promise<void>;
  recordBranch(
    sessionId: SessionId,
    branch: string,
    sha: string,
  ): Promise<void>;
  recordPullRequest(
    sessionId: SessionId,
    pr: { number: number; url: string },
  ): Promise<void>;
  applyLifecycle(sessionId: SessionId, event: GitHubLifecycleEvent): Promise<void>;
  getMeta(sessionId: SessionId): Promise<{
    repo: RepoRef;
    baseBranch: string;
    branch: string | null;
    authors: readonly AuthorId[];
  }>;
}

export type SandboxId = Brand<string, "SandboxId">;

export interface SandboxPort {
  /**
   * Boot from image snapshot (or resume snapshot). Implementation starts git
   * sync and reports gate transitions via onGate — callers of public API never see this.
   */
  acquire(input: {
    repo: RepoRef;
    imageSnapshotId: SnapshotId;
    resumeFrom?: SnapshotId;
    onGate: (gate: SyncGate) => Promise<void>;
  }): Promise<{ sandboxId: SandboxId }>;
  /** Coalesced warm; safe under keystroke spam. */
  hintWarm(sandboxId: SandboxId): Promise<void>;
  snapshot(sandboxId: SandboxId): Promise<SnapshotId>;
  pushBranch(
    sandboxId: SandboxId,
    input: { branch: string; authorName: string; authorEmail: string },
  ): Promise<{ sha: string }>;
  ideUrl(sandboxId: SandboxId): Promise<string | null>;
  dispose(sandboxId: SandboxId): Promise<void>;
}

export interface ImageRegistryPort {
  /** Latest prebuilt image snapshot for repo; hatch may return a fixture id. */
  latest(repo: RepoRef): Promise<SnapshotId>;
}

/**
 * Agent runtime integration point (OpenCode server-first).
 * Plugins receive domain ports/handles — not public factory surface.
 */
export interface AgentRuntimePort {
  start(input: {
    sessionId: SessionId;
    sandboxId: SandboxId;
    plugins: AgentPlugins;
  }): Promise<void>;
  runPrompt(input: {
    sessionId: SessionId;
    promptId: PromptId;
    author: Author;
    text: string;
  }): Promise<void>;
  stop(sessionId: SessionId): Promise<void>;
}

export type AgentPlugins = {
  /** Blocks write/edit tools while SyncGate.writes === "blocked". */
  readonly syncGate: () => Promise<SyncGate>;
  /** Slack (or other) status tool sink. */
  readonly postStatus: (message: string) => Promise<void>;
  readonly spawn: SpawnHandle;
};

export interface GitHubPort {
  openPullRequest(input: {
    repo: RepoRef;
    head: string;
    base: string;
    title: string;
    body: string;
    userToken: UserGithubToken;
  }): Promise<{ number: number; url: string }>;
  parseAndVerifyWebhook(raw: Request): Promise<unknown>; // raw payload; mapped in adapter shell
}

/** Parsed & validated at boundary; never a raw string past the handle. */
export type UserGithubToken = Brand<string, "UserGithubToken">;

export function parseUserGithubToken(raw: string): UserGithubToken {
  if (!raw || raw.length < 8) throw new Error("invalid user GitHub token");
  return raw as UserGithubToken;
}

// ─── Handle / factory internals (sketch) ─────────────────────────────────────

/** @internal Capability record stored with the actor; secrets never leave the server. */
export type CapabilityRecord = {
  readonly secret: CapabilitySecret;
  readonly sessionId: SessionId;
  readonly kind: CapabilityKind;
  readonly authorId: AuthorId | null;
  readonly revoked: boolean;
};

export class PromptHandleImpl implements PromptHandle {
  constructor(
    readonly sessionId: SessionId,
    readonly author: Author,
    private readonly secret: CapabilitySecret,
    private readonly actors: SessionActorPort,
    private readonly ids: IdFactory,
    private readonly agent: AgentRuntimePort,
  ) {}

  grantToken(): GrantToken {
    return this.ids.grantToken({
      sessionId: this.sessionId,
      kind: "prompt",
      secret: this.secret,
      authorId: this.author.id,
    });
  }

  async enqueue(input: { text: string }): Promise<{ promptId: PromptId }> {
    // TODO: validate text at boundary; append to actor queue; if idle, kick drain
    // drain: wait gate.writes allowed OR allow read-only tools; runPrompt; on complete dequeue next
    void input;
    throw new Error("not implemented");
  }

  async stop(): Promise<void> {
    // TODO: requestStop on actor + agent.stop; idempotent if nothing running
    throw new Error("not implemented");
  }

  async queue(): Promise<PromptQueueView> {
    return this.actors.queueView(this.sessionId);
  }
}

export class SandboxHandleImpl implements SandboxHandle {
  constructor(
    readonly sessionId: SessionId,
    private readonly secret: CapabilitySecret,
    private readonly actors: SessionActorPort,
    private readonly sandboxes: SandboxPort,
    private readonly ids: IdFactory,
    private readonly resolveSandboxId: (s: SessionId) => Promise<SandboxId>,
  ) {}

  grantToken(): GrantToken {
    return this.ids.grantToken({
      sessionId: this.sessionId,
      kind: "sandbox",
      secret: this.secret,
    });
  }

  hintWarm(): void {
    // TODO: fire-and-forget sandboxes.hintWarm(resolveSandboxId); coalesce in port
    void this.sandboxes;
    void this.resolveSandboxId;
  }

  async gate(): Promise<SyncGate> {
    const phase = await this.actors.phase(this.sessionId);
    if (phase.kind === "idle" || phase.kind === "running") return phase.gate;
    return { status: "pending", reads: "allowed", writes: "blocked" };
  }

  async phase(): Promise<SessionPhase> {
    return this.actors.phase(this.sessionId);
  }

  async ideUrl(): Promise<string | null> {
    const id = await this.resolveSandboxId(this.sessionId);
    return this.sandboxes.ideUrl(id);
  }
}

export class EventCursorImpl implements EventCursor {
  constructor(
    readonly sessionId: SessionId,
    private readonly secret: CapabilitySecret,
    private readonly actors: SessionActorPort,
    private readonly ids: IdFactory,
  ) {}

  grantToken(): GrantToken {
    return this.ids.grantToken({
      sessionId: this.sessionId,
      kind: "events",
      secret: this.secret,
    });
  }

  subscribe(opts: { after: EventId | null }): AsyncIterable<SessionEvent> {
    return this.actors.readEvents(this.sessionId, opts.after);
  }
}

export class PullRequestHandleImpl implements PullRequestHandle {
  constructor(
    readonly sessionId: SessionId,
    private readonly secret: CapabilitySecret,
    private readonly actors: SessionActorPort,
    private readonly sandboxes: SandboxPort,
    private readonly github: GitHubPort,
    private readonly ids: IdFactory,
    private readonly resolveSandboxId: (s: SessionId) => Promise<SandboxId>,
  ) {}

  grantToken(): GrantToken {
    return this.ids.grantToken({
      sessionId: this.sessionId,
      kind: "pull_request",
      secret: this.secret,
    });
  }

  async open(input: {
    title: string;
    body: string;
    userGithubToken: string;
  }): Promise<{ number: number; url: string }> {
    // TODO:
    // 1. parseUserGithubToken(input.userGithubToken)
    // 2. ensure branch pushed (sandbox.pushBranch) — if already pushed, idempotent
    // 3. github.openPullRequest with user token
    // 4. actors.recordPullRequest + appendEvent pull_request.opened
    void input;
    void this.sandboxes;
    void this.github;
    void this.resolveSandboxId;
    throw new Error("not implemented");
  }
}

export class SpawnHandleImpl implements SpawnHandle {
  constructor(
    readonly parentSessionId: SessionId,
    private readonly factory: InspectFactory,
    private readonly actors: SessionActorPort,
  ) {}

  async child(input: {
    repo?: RepoRef;
    prompt: string;
  }): Promise<{ sessionId: SessionId }> {
    // TODO: load parent meta/authors; mint child; enqueue prompt; emit child.spawned on parent
    void input;
    void this.factory;
    void this.actors;
    throw new Error("not implemented");
  }

  async status(sessionId: SessionId): Promise<{
    phase: SessionPhase;
    queue: PromptQueueView;
  }> {
    return {
      phase: await this.actors.phase(sessionId),
      queue: await this.actors.queueView(sessionId),
    };
  }
}

export class LifecycleHandleImpl implements LifecycleHandle {
  constructor(
    readonly sessionId: SessionId,
    private readonly actors: SessionActorPort,
  ) {}

  async apply(event: GitHubLifecycleEvent): Promise<void> {
    // TODO: idempotent merge/close/delete projection update
    await this.actors.applyLifecycle(this.sessionId, event);
  }
}

/**
 * Factory implementation sketch: mint creates actor + sandbox acquire + agent start,
 * then returns capability bundle. Rehydrate attaches author and returns fresh handles
 * with the same session secrets (or rotated grants).
 */
export class InspectFactoryImpl implements InspectFactory {
  constructor(private readonly adapters: InspectAdapters) {}

  readonly github: GitHubWebhookParser = {
    parseWebhook: async (raw: Request) => {
      void raw;
      // TODO: adapters.github.parseAndVerifyWebhook → map to GitHubLifecycleEvent
      throw new Error("not implemented");
    },
  };

  async mint(spec: MintSpec): Promise<SessionCapabilities> {
    // TODO:
    // const sessionId = ids.sessionId()
    // await sessions.create(...)
    // const image = await images.latest(spec.repo)
    // const { sandboxId } = await sandboxes.acquire({ onGate: gate => sessions.setGate... })
    // await sessions.bindSandbox(...)
    // await agent.start({ plugins: { syncGate, postStatus, spawn } })
    // return bundle of handle impls
    void spec;
    throw new Error("not implemented");
  }

  async rehydrate(
    sessionId: SessionId,
    author: Author,
  ): Promise<SessionCapabilities> {
    // TODO: sessions.attachAuthor; return new authorship-bound PromptHandle + shared others
    void sessionId;
    void author;
    throw new Error("not implemented");
  }

  async promptFromGrant(grant: GrantToken): Promise<PromptHandle> {
    void grant;
    throw new Error("not implemented");
  }
  async sandboxFromGrant(grant: GrantToken): Promise<SandboxHandle> {
    void grant;
    throw new Error("not implemented");
  }
  async eventsFromGrant(grant: GrantToken): Promise<EventCursor> {
    void grant;
    throw new Error("not implemented");
  }
  async pullRequestFromGrant(grant: GrantToken): Promise<PullRequestHandle> {
    void grant;
    throw new Error("not implemented");
  }

  async lifecycleFor(sessionId: SessionId): Promise<LifecycleHandle> {
    return new LifecycleHandleImpl(sessionId, this.adapters.sessions);
  }
}

// ─── Local / fake adapters (hatch-scale) ─────────────────────────────────────

export function memoryAdapters(): InspectAdapters {
  // TODO: in-memory SessionActor, FakeSandbox (instant gate→ready), fixture images,
  // Noop/fake AgentRuntime that echoes tokens, FakeGitHub that records PRs.
  throw new Error("not implemented");
}

export function modalShapedSandboxStub(): SandboxPort {
  // Same port as FakeSandbox; real Modal client would live only in this adapter.
  throw new Error("not implemented");
}

export function durableObjectSessionStub(): SessionActorPort {
  // DO-shaped: one SQLite-backed actor per SessionId. Local hatch uses memory map.
  throw new Error("not implemented");
}

// ─── Pure helpers (business logic; thin shell calls these) ────────────────────

/** Next queue entry to run, if any. Pure. */
export function nextQueued(
  view: PromptQueueView,
): Extract<PromptQueueEntry, { state: "queued" }> | null {
  if (view.running) return null;
  return view.pending.find((e) => e.state === "queued") ?? null;
}

/** Whether write tools may run. Pure. */
export function writesAllowed(gate: SyncGate): boolean {
  return gate.writes === "allowed";
}

/**
 * Reduce phase after a prompt terminal state.
 * Snapshotting / suspend are decided by the actor when sandbox exits — not here.
 */
export function phaseAfterPromptTerminal(
  gate: SyncGate,
  queue: PromptQueueView,
): SessionPhase {
  if (nextQueued(queue)) {
    return { kind: "running", promptId: nextQueued(queue)!.id, gate };
  }
  return { kind: "idle", gate };
}
