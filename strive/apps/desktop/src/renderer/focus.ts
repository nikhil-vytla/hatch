// A journal entry the conversation should bring into view: asked for by
// the Learned pane's evidence, taken by the transcript once it shows that
// session. It outlives a switch, as the app for the next session mounts
// fresh while this module stays loaded.

let pending: { session: string; seq: number } | undefined;

const listeners = new Set<() => void>();

export function focusEntry(session: string, seq: number) {
  pending = { session, seq };

  for (const l of listeners) l();
}

/** The seq asked for in `session`, once: none if nothing was, or it was for another session. */
export function takeFocus(session: string): number | undefined {
  if (pending?.session !== session) return undefined;

  const { seq } = pending;
  pending = undefined;

  return seq;
}

/** Hears each request; returns the way to stop. */
export function onFocus(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}
