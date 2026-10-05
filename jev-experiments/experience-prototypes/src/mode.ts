/**
 * Where an answer comes from, in the site's words: replayed from a recording (free), asked live
 * on the visitor's key, or run on this device (free). Control tags (trust.tsx) and result
 * receipts (receipt.tsx) both read this one table, so they can't drift apart.
 */
export type Mode = "recorded" | "live" | "browser";

/** A control's tag can also say that it's live but waiting for a key. */
export type TagMode = Mode | "needs-key";

export const MODE_WORDS: Record<Mode, { receipt: string; tag: string }> = {
  recorded: { receipt: "recorded", tag: "recorded · free" },
  live: { receipt: "live", tag: "live · your key" },
  browser: { receipt: "in your browser", tag: "in your browser · free" },
};

export const tagText = (mode: TagMode) => (mode === "needs-key" ? "live · needs your key" : MODE_WORDS[mode].tag);
