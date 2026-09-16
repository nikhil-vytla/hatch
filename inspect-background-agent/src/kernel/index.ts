declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type Timestamp = Branded<number, "Timestamp">;
export type WorkspaceId = Branded<string, "WorkspaceId">;
export type SessionId = Branded<string, "SessionId">;
export type TurnId = Branded<string, "TurnId">;
export type SlotId = Branded<string, "SlotId">;
export type LeaseEpoch = Branded<number, "LeaseEpoch">;
export type EventSeq = Branded<number, "EventSeq">;
export type CommitSha = Branded<string, "CommitSha">;
export type BranchName = Branded<string, "BranchName">;
export type EffectId = Branded<string, "EffectId">;
export type InstallationToken = Branded<string, "InstallationToken">;
export type UserToken = Branded<string, "UserToken">;
export type ActorId = Branded<string, "ActorId">;
export type ClientToken = Branded<string, "ClientToken">;

export type EventOrigin = "user" | "agent" | "sandbox" | "webhook" | "system";

export function brandString<B extends string>(value: string): Branded<string, B> {
  return value as Branded<string, B>;
}

export function brandNumber<B extends string>(value: number): Branded<number, B> {
  return value as Branded<number, B>;
}

export interface Clock {
  now(): Timestamp;
}

export function systemClock(): Clock {
  return {
    now(): Timestamp {
      return brandNumber<"Timestamp">(Date.now());
    },
  };
}

export function fixedClock(start: number): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now(): Timestamp {
      return brandNumber<"Timestamp">(t);
    },
    advance(ms: number) {
      t += ms;
    },
  };
}
