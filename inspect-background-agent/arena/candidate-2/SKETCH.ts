/**
 * Candidate 2: session-as-event-sourced log.
 *
 * This is a type sketch, not an implementation. Public client types come first.
 * Storage records, provider SDK values, and OpenCode protocol values stay behind
 * adapters.
 */

// -----------------------------------------------------------------------------
// Public client domain
// -----------------------------------------------------------------------------

declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type SessionId = Brand<string, "SessionId">;
export type PromptId = Brand<string, "PromptId">;
export type PromptRunId = Brand<string, "PromptRunId">;
export type ChildRequestId = Brand<string, "ChildRequestId">;
export type PullRequestId = Brand<string, "PullRequestId">;
export type RepositorySlug = Brand<string, "RepositorySlug">;
export type CommitSha = Brand<string, "CommitSha">;
export type SessionCursor = Brand<string, "SessionCursor">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type ActorId = Brand<string, "ActorId">;
export type IsoDateTime = Brand<string, "IsoDateTime">;

export function repositorySlug(_value: string): RepositorySlug {
  throw new Error("not implemented");
}

export function idempotencyKey(_value: string): IdempotencyKey {
  throw new Error("not implemented");
}

export type Author = Readonly<{
  id: ActorId;
  displayName: string;
  avatarUrl?: URL;
}>;

export type SyncGateView =
  | Readonly<{
      kind: "writes-blocked";
      reason: "booting" | "syncing" | "sync-failed";
      readsAllowed: true;
    }>
  | Readonly<{
      kind: "writable";
      revision: CommitSha;
      readsAllowed: true;
    }>;

export type SessionAvailability =
  | Readonly<{ kind: "created" }>
  | Readonly<{ kind: "warming"; source: "repository-image" | "resume-snapshot" }>
  | Readonly<{
      kind: "live";
      syncGate: SyncGateView;
    }>
  | Readonly<{ kind: "suspended"; savedAt: IsoDateTime }>
  | Readonly<{ kind: "failed"; message: string; retryable: boolean }>
  | Readonly<{ kind: "closed"; closedAt: IsoDateTime }>;

export type QueuedPrompt = Readonly<{
  promptId: PromptId;
  author: Author;
  text: string;
  submittedAt: IsoDateTime;
}>;

export type ActivePrompt =
  | Readonly<{
      kind: "running";
      prompt: QueuedPrompt;
      runId: PromptRunId;
      startedAt: IsoDateTime;
    }>
  | Readonly<{
      kind: "stop-requested";
      prompt: QueuedPrompt;
      runId: PromptRunId;
      startedAt: IsoDateTime;
      requestedBy: Author;
    }>;

export type PromptQueueView =
  | Readonly<{ kind: "idle"; waiting: readonly [] }>
  | Readonly<{
      kind: "waiting";
      waiting: readonly [QueuedPrompt, ...QueuedPrompt[]];
    }>
  | Readonly<{
      kind: "running";
      active: ActivePrompt;
      waiting: readonly QueuedPrompt[];
    }>;

export type PullRequestView =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "requested";
      pullRequestId: PullRequestId;
      requestedBy: Author;
      title: string;
    }>
  | Readonly<{
      kind: "branch-pushed";
      pullRequestId: PullRequestId;
      requestedBy: Author;
      branch: string;
      revision: CommitSha;
    }>
  | Readonly<{
      kind: "open";
      pullRequestId: PullRequestId;
      requestedBy: Author;
      url: URL;
      number: number;
      lifecycle: "open" | "closed" | "merged";
    }>
  | Readonly<{
      kind: "failed";
      pullRequestId: PullRequestId;
      requestedBy: Author;
      message: string;
      retryable: boolean;
    }>;

export type SessionView = Readonly<{
  sessionId: SessionId;
  repository: RepositorySlug;
  availability: SessionAvailability;
  queue: PromptQueueView;
  pullRequest: PullRequestView;
  participants: readonly Author[];
  cursor: SessionCursor;
}>;

type SessionUpdateBody =
  | Readonly<{
      kind: "session.created";
      repository: RepositorySlug;
      createdBy: Author;
    }>
  | Readonly<{
      kind: "sandbox.warming";
      source: "repository-image" | "resume-snapshot";
    }>
  | Readonly<{ kind: "sandbox.ready"; syncGate: SyncGateView }>
  | Readonly<{ kind: "sandbox.suspended"; savedAt: IsoDateTime }>
  | Readonly<{ kind: "git.sync_started"; readsAllowed: true }>
  | Readonly<{ kind: "git.sync_completed"; revision: CommitSha }>
  | Readonly<{
      kind: "git.sync_failed";
      message: string;
      writesRemainBlocked: true;
    }>
  | Readonly<{
      kind: "prompt.queued";
      promptId: PromptId;
      author: Author;
      position: number;
    }>
  | Readonly<{
      kind: "prompt.started";
      promptId: PromptId;
      runId: PromptRunId;
      author: Author;
    }>
  | Readonly<{
      kind: "prompt.output";
      promptId: PromptId;
      text: string;
    }>
  | Readonly<{ kind: "prompt.stop_requested"; promptId: PromptId; by: Author }>
  | Readonly<{ kind: "prompt.stopped"; promptId: PromptId }>
  | Readonly<{ kind: "prompt.completed"; promptId: PromptId }>
  | Readonly<{
      kind: "prompt.failed";
      promptId: PromptId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "status.reported";
      promptId: PromptId;
      message: string;
    }>
  | Readonly<{
      kind: "child_session.linked";
      childSessionId: SessionId;
      requestedByPrompt: PromptId;
    }>
  | Readonly<{
      kind: "pull_request.requested";
      pullRequestId: PullRequestId;
      requestedBy: Author;
    }>
  | Readonly<{
      kind: "pull_request.opened";
      pullRequestId: PullRequestId;
      url: URL;
      number: number;
      openedBy: Author;
    }>
  | Readonly<{
      kind: "pull_request.lifecycle_changed";
      pullRequestId: PullRequestId;
      lifecycle: "open" | "closed" | "merged";
    }>
  | Readonly<{
      kind: "pull_request.failed";
      pullRequestId: PullRequestId;
      message: string;
      retryable: boolean;
    }>;

export type SessionUpdate = Readonly<{
  sessionId: SessionId;
  cursor: SessionCursor;
  occurredAt: IsoDateTime;
}> &
  SessionUpdateBody;

export type SessionReceipt = Readonly<{
  sessionId: SessionId;
  cursor: SessionCursor;
}>;

export type CreatedSession = SessionReceipt;

export type PromptReceipt = SessionReceipt &
  Readonly<{
    promptId: PromptId;
    queuePosition: number;
  }>;

export type PullRequestReceipt = SessionReceipt &
  Readonly<{
    pullRequestId: PullRequestId;
  }>;

export interface SessionsClient {
  create(input: {
    readonly repository: RepositorySlug;
    readonly requestKey: IdempotencyKey;
  }): Promise<CreatedSession>;

  noteDraftActivity(input: {
    readonly sessionId: SessionId;
    readonly requestKey: IdempotencyKey;
  }): Promise<SessionReceipt>;

  submitPrompt(input: {
    readonly sessionId: SessionId;
    readonly text: string;
    readonly requestKey: IdempotencyKey;
  }): Promise<PromptReceipt>;

  stop(input: {
    readonly sessionId: SessionId;
    readonly requestKey: IdempotencyKey;
  }): Promise<SessionReceipt>;

  openPullRequest(input: {
    readonly sessionId: SessionId;
    readonly title: string;
    readonly body?: string;
    readonly requestKey: IdempotencyKey;
  }): Promise<PullRequestReceipt>;

  get(input: { readonly sessionId: SessionId }): Promise<SessionView>;

  watch(input: {
    readonly sessionId: SessionId;
    readonly after?: SessionCursor;
    readonly signal?: AbortSignal;
  }): AsyncIterable<SessionUpdate>;
}

export type InspectClient = Readonly<{
  sessions: SessionsClient;
}>;

export interface InspectAuthentication {
  accessToken(): Promise<string>;
}

export function createInspectClient(_input: {
  readonly endpoint: string;
  readonly authenticate: () => Promise<string>;
}): InspectClient {
  throw new Error("not implemented");
}

// -----------------------------------------------------------------------------
// Event-sourced session domain
// -----------------------------------------------------------------------------

export type EventId = Brand<string, "EventId">;
export type SessionRevision = Brand<bigint, "SessionRevision">;
export type ImageSnapshotId = Brand<string, "ImageSnapshotId">;
export type ResumeSnapshotId = Brand<string, "ResumeSnapshotId">;
export type SandboxLeaseId = Brand<string, "SandboxLeaseId">;
export type BootAttemptId = Brand<string, "BootAttemptId">;
export type AuthorizationGrantId = Brand<string, "AuthorizationGrantId">;
export type GitHubPullRequestRef = Brand<string, "GitHubPullRequestRef">;
export type ProviderDeliveryId = Brand<string, "ProviderDeliveryId">;
export type SubscriberName = Brand<string, "SubscriberName">;
export type EffectId = Brand<string, "EffectId">;

export type EventOrigin =
  | Readonly<{ kind: "user"; author: Author }>
  | Readonly<{ kind: "agent"; runId: PromptRunId }>
  | Readonly<{ kind: "sandbox"; leaseId: SandboxLeaseId }>
  | Readonly<{ kind: "github-webhook"; deliveryId: ProviderDeliveryId }>
  | Readonly<{ kind: "system"; component: string }>;

export type SessionEvent =
  | Readonly<{
      kind: "SessionCreated";
      repository: RepositorySlug;
      image: ImageSnapshotId;
      createdBy: Author;
      parent:
        | Readonly<{
            parentSessionId: SessionId;
            requestedByPrompt: PromptId;
          }>
        | null;
    }>
  | Readonly<{ kind: "DraftActivityNoted"; author: Author }>
  | Readonly<{
      kind: "SandboxBootStarted";
      attemptId: BootAttemptId;
      source:
        | Readonly<{ kind: "repository-image"; image: ImageSnapshotId }>
        | Readonly<{ kind: "resume-snapshot"; snapshot: ResumeSnapshotId }>;
    }>
  | Readonly<{
      kind: "SandboxBecameAvailable";
      attemptId: BootAttemptId;
      leaseId: SandboxLeaseId;
    }>
  | Readonly<{
      kind: "SandboxBootFailed";
      attemptId: BootAttemptId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "GitSyncStarted";
      leaseId: SandboxLeaseId;
      targetBranch: string;
    }>
  | Readonly<{
      kind: "GitSyncCompleted";
      leaseId: SandboxLeaseId;
      revision: CommitSha;
    }>
  | Readonly<{
      kind: "GitSyncFailed";
      leaseId: SandboxLeaseId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "ResumeSnapshotSaved";
      leaseId: SandboxLeaseId;
      snapshot: ResumeSnapshotId;
    }>
  | Readonly<{
      kind: "SandboxSuspended";
      leaseId: SandboxLeaseId;
      snapshot: ResumeSnapshotId;
    }>
  | Readonly<{
      kind: "PromptSubmitted";
      promptId: PromptId;
      author: Author;
      text: string;
    }>
  | Readonly<{
      kind: "PromptRunStarted";
      promptId: PromptId;
      runId: PromptRunId;
      leaseId: SandboxLeaseId;
    }>
  | Readonly<{
      kind: "PromptOutputAppended";
      promptId: PromptId;
      runId: PromptRunId;
      chunk: string;
    }>
  | Readonly<{
      kind: "PromptRunCompleted";
      promptId: PromptId;
      runId: PromptRunId;
    }>
  | Readonly<{
      kind: "PromptRunFailed";
      promptId: PromptId;
      runId: PromptRunId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "StopRequested";
      promptId: PromptId;
      runId: PromptRunId;
      requestedBy: Author;
    }>
  | Readonly<{ kind: "StopIgnored"; requestedBy: Author; reason: "idle" }>
  | Readonly<{
      kind: "PromptRunStopped";
      promptId: PromptId;
      runId: PromptRunId;
    }>
  | Readonly<{
      kind: "AgentStatusReported";
      promptId: PromptId;
      runId: PromptRunId;
      message: string;
    }>
  | Readonly<{
      kind: "ChildSessionSpawnRequested";
      requestId: ChildRequestId;
      requestedByPrompt: PromptId;
      requestedBy: Author;
      prompt: string;
    }>
  | Readonly<{
      kind: "ChildSessionLinked";
      requestId: ChildRequestId;
      requestedByPrompt: PromptId;
      childSessionId: SessionId;
    }>
  | Readonly<{
      kind: "PullRequestRequested";
      pullRequestId: PullRequestId;
      requestedBy: Author;
      title: string;
      body: string;
      authorizationGrant: AuthorizationGrantId;
    }>
  | Readonly<{
      kind: "BranchPushed";
      pullRequestId: PullRequestId;
      branch: string;
      revision: CommitSha;
    }>
  | Readonly<{
      kind: "PullRequestOpened";
      pullRequestId: PullRequestId;
      providerRef: GitHubPullRequestRef;
      url: URL;
      number: number;
    }>
  | Readonly<{
      kind: "PullRequestOpenFailed";
      pullRequestId: PullRequestId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "PullRequestLifecycleChanged";
      pullRequestId: PullRequestId;
      providerRef: GitHubPullRequestRef;
      lifecycle: "open" | "closed" | "merged";
    }>
  | Readonly<{ kind: "SessionClosed"; reason: "user" | "expired" }>;

export type SessionEventEnvelope = Readonly<{
  eventId: EventId;
  sessionId: SessionId;
  revision: SessionRevision;
  occurredAt: IsoDateTime;
  requestKey: IdempotencyKey;
  origin: EventOrigin;
  event: SessionEvent;
}>;

export type SandboxOperationalState =
  | Readonly<{ kind: "not-started" }>
  | Readonly<{
      kind: "booting";
      attemptId: BootAttemptId;
      source: "repository-image" | "resume-snapshot";
    }>
  | Readonly<{
      kind: "live";
      leaseId: SandboxLeaseId;
      syncGate: SyncGateView;
    }>
  | Readonly<{
      kind: "suspended";
      snapshot: ResumeSnapshotId;
      savedAt: IsoDateTime;
    }>
  | Readonly<{ kind: "failed"; message: string; retryable: boolean }>
  | Readonly<{ kind: "closed" }>;

export type PromptQueueState = PromptQueueView;

export type SessionAggregate =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "present";
      sessionId: SessionId;
      repository: RepositorySlug;
      image: ImageSnapshotId;
      createdBy: Author;
      sandbox: SandboxOperationalState;
      queue: PromptQueueState;
      pullRequest: PullRequestView;
      participants: readonly Author[];
      latestRevision: SessionRevision;
    }>;

export type SessionCommand =
  | Readonly<{
      kind: "CreateSession";
      sessionId: SessionId;
      repository: RepositorySlug;
      image: ImageSnapshotId;
      createdBy: Author;
      parent: Extract<
        SessionEvent,
        Readonly<{ kind: "SessionCreated" }>
      >["parent"];
    }>
  | Readonly<{ kind: "NoteDraftActivity"; sessionId: SessionId }>
  | Readonly<{
      kind: "SubmitPrompt";
      sessionId: SessionId;
      promptId: PromptId;
      text: string;
    }>
  | Readonly<{ kind: "RequestStop"; sessionId: SessionId }>
  | Readonly<{
      kind: "RequestPullRequest";
      sessionId: SessionId;
      pullRequestId: PullRequestId;
      title: string;
      body: string;
      authorizationGrant: AuthorizationGrantId;
    }>
  | Readonly<{
      kind: "RecordSandboxBootStarted";
      sessionId: SessionId;
      attemptId: BootAttemptId;
      source:
        | Readonly<{ kind: "repository-image"; image: ImageSnapshotId }>
        | Readonly<{ kind: "resume-snapshot"; snapshot: ResumeSnapshotId }>;
    }>
  | Readonly<{
      kind: "RecordSandboxAvailable";
      sessionId: SessionId;
      attemptId: BootAttemptId;
      leaseId: SandboxLeaseId;
    }>
  | Readonly<{
      kind: "RecordSandboxBootFailed";
      sessionId: SessionId;
      attemptId: BootAttemptId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "RecordGitSyncStarted";
      sessionId: SessionId;
      leaseId: SandboxLeaseId;
      targetBranch: string;
    }>
  | Readonly<{
      kind: "RecordGitSyncCompleted";
      sessionId: SessionId;
      leaseId: SandboxLeaseId;
      revision: CommitSha;
    }>
  | Readonly<{
      kind: "RecordGitSyncFailed";
      sessionId: SessionId;
      leaseId: SandboxLeaseId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "RecordSandboxSuspended";
      sessionId: SessionId;
      leaseId: SandboxLeaseId;
      snapshot: ResumeSnapshotId;
    }>
  | Readonly<{
      kind: "StartNextPrompt";
      sessionId: SessionId;
      runId: PromptRunId;
      leaseId: SandboxLeaseId;
    }>
  | Readonly<{
      kind: "AppendPromptOutput";
      sessionId: SessionId;
      promptId: PromptId;
      runId: PromptRunId;
      chunk: string;
    }>
  | Readonly<{
      kind: "CompletePrompt";
      sessionId: SessionId;
      promptId: PromptId;
      runId: PromptRunId;
    }>
  | Readonly<{
      kind: "FailPrompt";
      sessionId: SessionId;
      promptId: PromptId;
      runId: PromptRunId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "RecordPromptStopped";
      sessionId: SessionId;
      promptId: PromptId;
      runId: PromptRunId;
    }>
  | Readonly<{
      kind: "ReportAgentStatus";
      sessionId: SessionId;
      promptId: PromptId;
      runId: PromptRunId;
      message: string;
    }>
  | Readonly<{
      kind: "RequestChildSession";
      sessionId: SessionId;
      requestId: ChildRequestId;
      requestedByPrompt: PromptId;
      requestedBy: Author;
      prompt: string;
    }>
  | Readonly<{
      kind: "LinkChildSession";
      sessionId: SessionId;
      requestId: ChildRequestId;
      requestedByPrompt: PromptId;
      childSessionId: SessionId;
    }>
  | Readonly<{
      kind: "RecordBranchPushed";
      sessionId: SessionId;
      pullRequestId: PullRequestId;
      branch: string;
      revision: CommitSha;
    }>
  | Readonly<{
      kind: "RecordPullRequestOpened";
      sessionId: SessionId;
      pullRequestId: PullRequestId;
      providerRef: GitHubPullRequestRef;
      url: URL;
      number: number;
    }>
  | Readonly<{
      kind: "RecordPullRequestOpenFailed";
      sessionId: SessionId;
      pullRequestId: PullRequestId;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      kind: "ApplyPullRequestWebhook";
      sessionId: SessionId;
      pullRequestId: PullRequestId;
      providerRef: GitHubPullRequestRef;
      lifecycle: "open" | "closed" | "merged";
    }>
  | Readonly<{
      kind: "CloseSession";
      sessionId: SessionId;
      reason: "user" | "expired";
    }>;

export type CommandContext = Readonly<{
  requestKey: IdempotencyKey;
  occurredAt: IsoDateTime;
  origin: EventOrigin;
}>;

export type DomainRejection =
  | Readonly<{ kind: "session-not-found" }>
  | Readonly<{ kind: "session-already-exists" }>
  | Readonly<{ kind: "session-closed" }>
  | Readonly<{ kind: "invalid-prompt"; message: string }>
  | Readonly<{ kind: "sandbox-not-ready" }>
  | Readonly<{ kind: "prompt-run-mismatch" }>
  | Readonly<{ kind: "pull-request-already-requested" }>
  | Readonly<{ kind: "pull-request-not-ready" }>
  | Readonly<{ kind: "unauthorized" }>;

export type CommandDecision =
  | Readonly<{
      kind: "accepted";
      events: readonly [SessionEvent, ...SessionEvent[]];
    }>
  | Readonly<{ kind: "rejected"; reason: DomainRejection }>;

export function evolveSession(
  _state: SessionAggregate,
  _event: SessionEventEnvelope,
): SessionAggregate {
  throw new Error("not implemented");
}

export function decideSessionCommand(
  _state: SessionAggregate,
  _command: SessionCommand,
  _context: CommandContext,
): CommandDecision {
  throw new Error("not implemented");
}

// -----------------------------------------------------------------------------
// Journal, commands, and projections
// -----------------------------------------------------------------------------

export type JournalCommit = Readonly<{
  sessionId: SessionId;
  revision: SessionRevision;
  cursor: SessionCursor;
  appended: readonly SessionEventEnvelope[];
  replayedRequest: boolean;
}>;

export interface SessionJournal {
  /**
   * Runs the decider against one session stream under that stream's sequencer.
   * The implementation stores request results with the append, so a retry with
   * the same request key returns the first commit without appending again.
   */
  transact(input: {
    readonly sessionId: SessionId;
    readonly requestKey: IdempotencyKey;
    readonly decide: (
      history: readonly SessionEventEnvelope[],
    ) => CommandDecision;
  }): Promise<JournalCommit>;

  read(input: {
    readonly sessionId: SessionId;
    readonly after?: SessionRevision;
  }): AsyncIterable<SessionEventEnvelope>;
}

export type AuthenticatedPrincipal = Readonly<{
  author: Author;
  subject: string;
  githubAccount: "linked" | "unlinked";
}>;

export interface Clock {
  now(): IsoDateTime;
}

export interface IdFactory {
  sessionId(_from: {
    readonly subject: string;
    readonly requestKey: IdempotencyKey;
  }): SessionId;
  childSessionId(_requestId: ChildRequestId): SessionId;
  promptId(): PromptId;
  promptRunId(_from: EventId): PromptRunId;
  pullRequestId(): PullRequestId;
  childRequestId(_from: {
    readonly runId: PromptRunId;
    readonly callId: string;
  }): ChildRequestId;
  bootAttemptId(_from: EventId): BootAttemptId;
  effectId(_from: EventId, _operation: string): EffectId;
}

export interface AuthorizationVault {
  issueGitHubGrant(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly sessionId: SessionId;
    readonly requestKey: IdempotencyKey;
  }): Promise<AuthorizationGrantId>;

  resolveGitHubGrant(
    _grantId: AuthorizationGrantId,
  ): Promise<GitHubUserAuthorization>;
}

export interface RepositoryImageCatalog {
  latestReadyImage(_repository: RepositorySlug): Promise<ImageSnapshotId>;
}

export interface SessionCommandPort {
  execute(input: {
    readonly command: SessionCommand;
    readonly context: CommandContext;
  }): Promise<JournalCommit>;
}

export class SessionCommandService implements SessionCommandPort {
  public constructor(_deps: {
    readonly journal: SessionJournal;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async execute(_input: {
    readonly command: SessionCommand;
    readonly context: CommandContext;
  }): Promise<JournalCommit> {
    throw new Error("not implemented");
  }
}

export class SessionsApplication {
  public constructor(_deps: {
    readonly commands: SessionCommandPort;
    readonly queries: SessionQueries;
    readonly images: RepositoryImageCatalog;
    readonly authorizations: AuthorizationVault;
    readonly ids: IdFactory;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public forPrincipal(_principal: AuthenticatedPrincipal): SessionsClient {
    throw new Error("not implemented");
  }
}

export interface Projection<State> {
  initial(): State;
  apply(_state: State, _event: SessionEventEnvelope): State;
}

export interface ProjectionCheckpointStore {
  load<State>(input: {
    readonly projection: string;
    readonly sessionId: SessionId;
  }): Promise<
    | Readonly<{
        state: State;
        revision: SessionRevision;
      }>
    | Readonly<{ state: null; revision: null }>
  >;

  save<State>(input: {
    readonly projection: string;
    readonly sessionId: SessionId;
    readonly state: State;
    readonly revision: SessionRevision;
  }): Promise<void>;
}

export class SessionViewProjection implements Projection<SessionView | null> {
  public initial(): null {
    throw new Error("not implemented");
  }

  public apply(
    _state: SessionView | null,
    _event: SessionEventEnvelope,
  ): SessionView | null {
    throw new Error("not implemented");
  }
}

export type AgentInboxProjection = Readonly<{
  sessionId: SessionId;
  sandbox:
    | Readonly<{ kind: "unavailable" }>
    | Readonly<{
        kind: "available";
        leaseId: SandboxLeaseId;
        syncGate: SyncGateView;
      }>;
  queue: PromptQueueState;
}>;

export class AgentInboxProjector
  implements Projection<AgentInboxProjection | null>
{
  public initial(): null {
    throw new Error("not implemented");
  }

  public apply(
    _state: AgentInboxProjection | null,
    _event: SessionEventEnvelope,
  ): AgentInboxProjection | null {
    throw new Error("not implemented");
  }
}

export interface AgentInboxReader {
  current(_sessionId: SessionId): Promise<AgentInboxProjection>;
}

export type SandboxWorkProjection = Readonly<{
  sessionId: SessionId;
  repository: RepositorySlug;
  desired: "warm" | "suspended" | "closed";
  bootSource: SandboxBootSource;
  sandbox: SandboxOperationalState;
  pendingBranchPush:
    | Readonly<{
        pullRequestId: PullRequestId;
        branchHint: string;
      }>
    | null;
}>;

export interface SandboxWorkReader {
  current(_sessionId: SessionId): Promise<SandboxWorkProjection>;
}

export type ChildSessionWork = Readonly<{
  parentSessionId: SessionId;
  repository: RepositorySlug;
  requestId: ChildRequestId;
  requestedByPrompt: PromptId;
  requestedBy: Author;
  prompt: string;
}>;

export interface ChildSessionWorkReader {
  request(input: {
    readonly parentSessionId: SessionId;
    readonly requestId: ChildRequestId;
  }): Promise<ChildSessionWork>;
}

export type PullRequestWork =
  | Readonly<{ kind: "waiting-for-branch" }>
  | Readonly<{
      kind: "ready-to-open";
      sessionId: SessionId;
      repository: RepositorySlug;
      pullRequestId: PullRequestId;
      title: string;
      body: string;
      branch: string;
      authorizationGrant: AuthorizationGrantId;
    }>
  | Readonly<{ kind: "finished" }>;

export interface PullRequestWorkReader {
  current(input: {
    readonly sessionId: SessionId;
    readonly pullRequestId: PullRequestId;
  }): Promise<PullRequestWork>;
}

export interface SessionQueries {
  get(_sessionId: SessionId): Promise<SessionView>;

  watch(input: {
    readonly sessionId: SessionId;
    readonly after?: SessionCursor;
    readonly signal?: AbortSignal;
  }): AsyncIterable<SessionUpdate>;
}

export class ProjectedSessionQueries implements SessionQueries {
  public constructor(_deps: {
    readonly journal: SessionJournal;
    readonly checkpoints: ProjectionCheckpointStore;
    readonly view: SessionViewProjection;
  }) {
    throw new Error("not implemented");
  }

  public async get(_sessionId: SessionId): Promise<SessionView> {
    throw new Error("not implemented");
  }

  public watch(_input: {
    readonly sessionId: SessionId;
    readonly after?: SessionCursor;
    readonly signal?: AbortSignal;
  }): AsyncIterable<SessionUpdate> {
    throw new Error("not implemented");
  }
}

export function toPublicUpdate(
  _event: SessionEventEnvelope,
): SessionUpdate | null {
  throw new Error("not implemented");
}

// -----------------------------------------------------------------------------
// At-least-once subscriber runtime
// -----------------------------------------------------------------------------

export type EventDelivery = Readonly<{
  deliveryId: Brand<string, "EventDeliveryId">;
  event: SessionEventEnvelope;
}>;

export interface SessionEventFeed {
  deliveries(input: {
    readonly subscriber: SubscriberName;
    readonly signal: AbortSignal;
  }): AsyncIterable<EventDelivery>;

  acknowledge(_delivery: EventDelivery): Promise<void>;
}

export interface SessionSubscriber {
  readonly name: SubscriberName;
  handle(_event: SessionEventEnvelope): Promise<void>;
}

export interface EffectLedger {
  /**
   * Local state changes may use this ledger for deduplication. External ports
   * must also receive EffectId because a crash can happen after an external
   * success and before this ledger records completion.
   */
  run<Result>(input: {
    readonly effectId: EffectId;
    readonly effect: () => Promise<Result>;
  }): Promise<Result>;
}

export class SessionEventPump {
  public constructor(_feed: SessionEventFeed) {
    throw new Error("not implemented");
  }

  public async run(
    _subscriber: SessionSubscriber,
    _signal: AbortSignal,
  ): Promise<never> {
    throw new Error("not implemented");
  }
}

// -----------------------------------------------------------------------------
// Sandbox lifecycle subscriber and ports
// -----------------------------------------------------------------------------

export type SandboxBootSource =
  | Readonly<{ kind: "repository-image"; image: ImageSnapshotId }>
  | Readonly<{ kind: "resume-snapshot"; snapshot: ResumeSnapshotId }>;

export type SandboxBootResult = Readonly<{
  leaseId: SandboxLeaseId;
}>;

export type BranchPushResult = Readonly<{
  branch: string;
  revision: CommitSha;
}>;

export interface SandboxPlatform {
  boot(input: {
    readonly sessionId: SessionId;
    readonly repository: RepositorySlug;
    readonly source: SandboxBootSource;
    readonly effectId: EffectId;
  }): Promise<SandboxBootResult>;

  syncGit(input: {
    readonly leaseId: SandboxLeaseId;
    readonly repository: RepositorySlug;
    readonly effectId: EffectId;
  }): Promise<CommitSha>;

  saveResumeSnapshot(input: {
    readonly leaseId: SandboxLeaseId;
    readonly effectId: EffectId;
  }): Promise<ResumeSnapshotId>;

  stop(input: {
    readonly leaseId: SandboxLeaseId;
    readonly effectId: EffectId;
  }): Promise<void>;

  pushBranch(input: {
    readonly leaseId: SandboxLeaseId;
    readonly branchHint: string;
    readonly effectId: EffectId;
  }): Promise<BranchPushResult>;
}

export class SandboxLifecycleSubscriber implements SessionSubscriber {
  public readonly name: SubscriberName;

  public constructor(_deps: {
    readonly commands: SessionCommandPort;
    readonly sandboxes: SandboxPlatform;
    readonly work: SandboxWorkReader;
    readonly effects: EffectLedger;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async handle(_event: SessionEventEnvelope): Promise<void> {
    // TODO: Reconcile desired lifecycle from the event stream. A create,
    // draft activity, or queued prompt ensures a warm sandbox. Boot completion
    // starts git sync. A PR request pushes before GitHub opens the PR. Idle or
    // close saves one resume snapshot before stopping the lease.
    throw new Error("not implemented");
  }
}

// -----------------------------------------------------------------------------
// Agent runtime subscriber and OpenCode-shaped adapter boundary
// -----------------------------------------------------------------------------

export type AgentToolCall =
  | Readonly<{
      kind: "filesystem-read";
      callId: string;
      path: string;
    }>
  | Readonly<{
      kind: "workspace-write";
      callId: string;
      operation: string;
    }>
  | Readonly<{
      kind: "report-slack-status";
      callId: string;
      message: string;
    }>
  | Readonly<{
      kind: "spawn-child-session";
      callId: string;
      prompt: string;
    }>;

export type BeforeToolResult =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "deny"; message: string; retryable: boolean }>;

export type DomainToolResult =
  | Readonly<{ kind: "not-handled" }>
  | Readonly<{ kind: "handled"; content: string }>;

export interface AgentPlugin {
  beforeTool(_call: AgentToolCall): Promise<BeforeToolResult>;
  executeTool(_call: AgentToolCall): Promise<DomainToolResult>;
}

export interface SyncGateReader {
  current(_sessionId: SessionId): Promise<SyncGateView>;
}

export class SyncGatePlugin implements AgentPlugin {
  public constructor(_sessionId: SessionId, _gate: SyncGateReader) {
    throw new Error("not implemented");
  }

  public async beforeTool(_call: AgentToolCall): Promise<BeforeToolResult> {
    // TODO: Reads always pass. Workspace writes pass only for a writable gate.
    throw new Error("not implemented");
  }

  public async executeTool(_call: AgentToolCall): Promise<DomainToolResult> {
    throw new Error("not implemented");
  }
}

export class SlackStatusToolsPlugin implements AgentPlugin {
  public constructor(_input: {
    readonly sessionId: SessionId;
    readonly promptId: PromptId;
    readonly runId: PromptRunId;
    readonly commands: SessionCommandPort;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async beforeTool(_call: AgentToolCall): Promise<BeforeToolResult> {
    throw new Error("not implemented");
  }

  public async executeTool(_call: AgentToolCall): Promise<DomainToolResult> {
    // TODO: Convert the OpenCode tool call into AgentStatusReported. Slack
    // rendering remains a client projection and does not enter this plugin.
    throw new Error("not implemented");
  }
}

export class ChildSessionToolsPlugin implements AgentPlugin {
  public constructor(_input: {
    readonly sessionId: SessionId;
    readonly promptId: PromptId;
    readonly requestedBy: Author;
    readonly commands: SessionCommandPort;
    readonly ids: IdFactory;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async beforeTool(_call: AgentToolCall): Promise<BeforeToolResult> {
    throw new Error("not implemented");
  }

  public async executeTool(_call: AgentToolCall): Promise<DomainToolResult> {
    // TODO: Append ChildSessionSpawnRequested. The child-session subscriber
    // creates and links the child stream with deterministic ids.
    throw new Error("not implemented");
  }
}

export type AgentRuntimeEvent =
  | Readonly<{ kind: "output"; text: string }>
  | Readonly<{ kind: "heartbeat" }>
  | Readonly<{ kind: "completed" }>
  | Readonly<{
      kind: "failed";
      message: string;
      retryable: boolean;
    }>;

export interface AgentRuntime {
  /**
   * The OpenCode adapter starts or reconnects to its server by runId. It parses
   * OpenCode events into AgentRuntimeEvent and translates plugin hooks into
   * AgentToolCall before this boundary.
   */
  run(input: {
    readonly runId: PromptRunId;
    readonly leaseId: SandboxLeaseId;
    readonly prompt: QueuedPrompt;
    readonly plugins: readonly AgentPlugin[];
    readonly effectId: EffectId;
    readonly signal: AbortSignal;
  }): AsyncIterable<AgentRuntimeEvent>;

  stop(input: {
    readonly runId: PromptRunId;
    readonly effectId: EffectId;
  }): Promise<void>;
}

export class AgentRuntimeSubscriber implements SessionSubscriber {
  public readonly name: SubscriberName;

  public constructor(_deps: {
    readonly commands: SessionCommandPort;
    readonly runtime: AgentRuntime;
    readonly inbox: AgentInboxReader;
    readonly gate: SyncGateReader;
    readonly effects: EffectLedger;
    readonly ids: IdFactory;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async handle(_event: SessionEventEnvelope): Promise<void> {
    // TODO: Claim the oldest prompt only when no prompt is active and a
    // sandbox lease exists. PromptRunStarted is the durable claim. Starting the
    // runtime uses runId as its provider idempotency key. A stop event cancels
    // that run without removing later prompts.
    throw new Error("not implemented");
  }
}

// -----------------------------------------------------------------------------
// Child sessions, GitHub workflow, and webhook ingress
// -----------------------------------------------------------------------------

export class ChildSessionSubscriber implements SessionSubscriber {
  public readonly name: SubscriberName;

  public constructor(_deps: {
    readonly commands: SessionCommandPort;
    readonly images: RepositoryImageCatalog;
    readonly work: ChildSessionWorkReader;
    readonly effects: EffectLedger;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async handle(_event: SessionEventEnvelope): Promise<void> {
    // TODO: Derive child SessionId from the request event, create that stream
    // idempotently with the parent's repo and author, then link it in the parent.
    throw new Error("not implemented");
  }
}

declare const githubAuthorization: unique symbol;

export type GitHubUserAuthorization = Readonly<{
  readonly [githubAuthorization]: "GitHubUserAuthorization";
  readonly login: string;
}>;

export type OpenedPullRequest = Readonly<{
  providerRef: GitHubPullRequestRef;
  url: URL;
  number: number;
}>;

export interface GitHubService {
  openPullRequest(input: {
    readonly repository: RepositorySlug;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
    readonly authorization: GitHubUserAuthorization;
    readonly effectId: EffectId;
  }): Promise<OpenedPullRequest>;
}

export class GitHubWorkflowSubscriber implements SessionSubscriber {
  public readonly name: SubscriberName;

  public constructor(_deps: {
    readonly commands: SessionCommandPort;
    readonly github: GitHubService;
    readonly authorizations: AuthorizationVault;
    readonly work: PullRequestWorkReader;
    readonly effects: EffectLedger;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async handle(_event: SessionEventEnvelope): Promise<void> {
    // TODO: Wait for BranchPushed, resolve the requesting user's opaque grant,
    // open with that user authorization, and record the provider reference.
    throw new Error("not implemented");
  }
}

export type VerifiedPullRequestWebhook = Readonly<{
  deliveryId: ProviderDeliveryId;
  providerRef: GitHubPullRequestRef;
  repository: RepositorySlug;
  lifecycle: "open" | "closed" | "merged";
}>;

export interface GitHubWebhookVerifier {
  verify(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: unknown;
  }): Promise<VerifiedPullRequestWebhook>;
}

export interface PullRequestIndex {
  findSession(
    _providerRef: GitHubPullRequestRef,
  ): Promise<
    Readonly<{ sessionId: SessionId; pullRequestId: PullRequestId }> | null
  >;
}

export class GitHubWebhookIngress {
  public constructor(_deps: {
    readonly verifier: GitHubWebhookVerifier;
    readonly pullRequests: PullRequestIndex;
    readonly commands: SessionCommandPort;
    readonly clock: Clock;
  }) {
    throw new Error("not implemented");
  }

  public async accept(_input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: unknown;
  }): Promise<"accepted" | "ignored"> {
    throw new Error("not implemented");
  }
}

// -----------------------------------------------------------------------------
// API ingress and local/fake composition
// -----------------------------------------------------------------------------

export interface PrincipalAuthenticator {
  authenticate(_credential: string): Promise<AuthenticatedPrincipal>;
}

export class InspectApiIngress {
  public constructor(_deps: {
    readonly authenticate: PrincipalAuthenticator;
    readonly sessions: SessionsApplication;
  }) {
    throw new Error("not implemented");
  }

  /**
   * The HTTP or Durable Object adapter validates unknown input, authenticates
   * it, and calls SessionsApplication. No framework request type crosses in.
   */
  public async handle(_request: unknown): Promise<unknown> {
    throw new Error("not implemented");
  }
}

export type LocalRepository = Readonly<{
  slug: RepositorySlug;
  defaultBranch: string;
  files: Readonly<Record<string, string>>;
}>;

export type LocalIdentity = Readonly<{
  subject: string;
  displayName: string;
  githubLogin?: string;
}>;

export type LocalInspectHarness = Readonly<{
  clientFor(_identity: LocalIdentity): InspectClient;
  settle(): Promise<void>;
  journal: SessionJournal;
}>;

export function createLocalInspect(_input: {
  readonly repositories: readonly LocalRepository[];
}): LocalInspectHarness {
  throw new Error("not implemented");
}

export class InMemorySessionJournal implements SessionJournal {
  public async transact(_input: {
    readonly sessionId: SessionId;
    readonly requestKey: IdempotencyKey;
    readonly decide: (
      history: readonly SessionEventEnvelope[],
    ) => CommandDecision;
  }): Promise<JournalCommit> {
    throw new Error("not implemented");
  }

  public read(_input: {
    readonly sessionId: SessionId;
    readonly after?: SessionRevision;
  }): AsyncIterable<SessionEventEnvelope> {
    throw new Error("not implemented");
  }
}

export class DurableSessionJournal implements SessionJournal {
  /**
   * One shard owns one session stream and its request-key receipts. The adapter
   * may use Durable Object SQLite, but no Cloudflare type appears here.
   */
  public async transact(_input: {
    readonly sessionId: SessionId;
    readonly requestKey: IdempotencyKey;
    readonly decide: (
      history: readonly SessionEventEnvelope[],
    ) => CommandDecision;
  }): Promise<JournalCommit> {
    throw new Error("not implemented");
  }

  public read(_input: {
    readonly sessionId: SessionId;
    readonly after?: SessionRevision;
  }): AsyncIterable<SessionEventEnvelope> {
    throw new Error("not implemented");
  }
}

export class FakeSandboxPlatform implements SandboxPlatform {
  public async boot(_input: {
    readonly sessionId: SessionId;
    readonly repository: RepositorySlug;
    readonly source: SandboxBootSource;
    readonly effectId: EffectId;
  }): Promise<SandboxBootResult> {
    throw new Error("not implemented");
  }

  public async syncGit(_input: {
    readonly leaseId: SandboxLeaseId;
    readonly repository: RepositorySlug;
    readonly effectId: EffectId;
  }): Promise<CommitSha> {
    throw new Error("not implemented");
  }

  public async saveResumeSnapshot(_input: {
    readonly leaseId: SandboxLeaseId;
    readonly effectId: EffectId;
  }): Promise<ResumeSnapshotId> {
    throw new Error("not implemented");
  }

  public async stop(_input: {
    readonly leaseId: SandboxLeaseId;
    readonly effectId: EffectId;
  }): Promise<void> {
    throw new Error("not implemented");
  }

  public async pushBranch(_input: {
    readonly leaseId: SandboxLeaseId;
    readonly branchHint: string;
    readonly effectId: EffectId;
  }): Promise<BranchPushResult> {
    throw new Error("not implemented");
  }
}

export class FakeAgentRuntime implements AgentRuntime {
  public run(_input: {
    readonly runId: PromptRunId;
    readonly leaseId: SandboxLeaseId;
    readonly prompt: QueuedPrompt;
    readonly plugins: readonly AgentPlugin[];
    readonly effectId: EffectId;
    readonly signal: AbortSignal;
  }): AsyncIterable<AgentRuntimeEvent> {
    throw new Error("not implemented");
  }

  public async stop(_input: {
    readonly runId: PromptRunId;
    readonly effectId: EffectId;
  }): Promise<void> {
    throw new Error("not implemented");
  }
}

export class FakeGitHubService implements GitHubService {
  public async openPullRequest(_input: {
    readonly repository: RepositorySlug;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
    readonly authorization: GitHubUserAuthorization;
    readonly effectId: EffectId;
  }): Promise<OpenedPullRequest> {
    throw new Error("not implemented");
  }
}
