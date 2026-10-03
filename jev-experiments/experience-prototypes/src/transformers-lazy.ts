/**
 * transformers.js, loaded on first use. The three model workers (Decide's MobileBERT, the reef's
 * MobileBERT, and MiniLM for the rumour mill and Who can you win over?) all import it through this
 * one dynamic import. Vite bundles each worker separately, but each build then emits transformers.js
 * as the same content-hashed chunk, so the site ships, and the browser caches, one copy instead of
 * three.
 */
export async function transformers() {
  const t = await import("@huggingface/transformers");

  t.env.allowLocalModels = false;

  return t;
}
