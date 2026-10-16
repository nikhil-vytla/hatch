import type { ActorId } from "../kernel/index.js";

export type Actor = {
  readonly id: ActorId;
  readonly display: string;
  readonly github: string | null;
};

export type RepoRef = { readonly owner: string; readonly name: string };

export type ConversationRef =
  | { readonly surface: "slack"; readonly channel: string; readonly thread: string }
  | { readonly surface: "web"; readonly key: string }
  | { readonly surface: "api"; readonly key: string };

export function conversationKey(ref: ConversationRef): string {
  switch (ref.surface) {
    case "slack":
      return `slack:${ref.channel}:${ref.thread}`;
    case "web":
      return `web:${ref.key}`;
    case "api":
      return `api:${ref.key}`;
    default: {
      const _exhaustive: never = ref;
      return _exhaustive;
    }
  }
}
