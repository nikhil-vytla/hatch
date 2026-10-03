/**
 * Screen sentry's service worker. Its only network use: when the visitor asks, it sends the
 * flagged blocks to Jev through the Vercel AI Gateway with the visitor's own key, stored in
 * chrome.storage.local. The key goes to https://ai-gateway.vercel.sh and nowhere else; that is also
 * the extension's only host permission. Requests are the scene's own (live-worlds/sentry/jev.ts).
 */
import { BATCH, batchRequest, batchScores } from "../../../live-worlds/sentry/jev";
import type { Block } from "../../../live-worlds/sentry/model";

const GATEWAY = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

/** At most this many flagged blocks per check: two requests. */
const MAX_BLOCKS = 2 * BATCH;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "askJev") return false;

  void (async () => {
    const { jevKey } = await chrome.storage.local.get("jevKey");

    if (!jevKey) return reply({ error: "Add your AI Gateway key in the extension's options first." });

    const blocks: Block[] = msg.blocks.slice(0, MAX_BLOCKS).map((b: Block) => ({ text: String(b.text), where: b.where }));
    const risks: number[] = [];

    try {
      for (let start = 0; start < blocks.length; start += BATCH) {
        const chunk = blocks.slice(start, start + BATCH);
        const req = batchRequest({ task: "Read this web page for the user.", page: String(msg.url) }, chunk);
        const res = await fetch(GATEWAY, {
          method: "POST",
          headers: { Authorization: `Bearer ${jevKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "typesafe-ai/jev", ...req }),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) return reply({ error: `Jev returned ${res.status}.` });

        const body = await res.json();
        // The gateway puts each score under its question type; batchScores reads `value`.
        const answers = Object.fromEntries(Object.entries(body.answers ?? {}).map(([k, a]) => [k, { value: (a as { noul?: number })?.noul }]));

        risks.push(...batchScores(answers, chunk.length).map((s) => s.risk));
      }

      reply({ risks, checked: blocks.length, of: msg.blocks.length });
    } catch (e) {
      reply({ error: e instanceof Error ? e.message : "Jev could not be reached." });
    }
  })();

  return true;
});
