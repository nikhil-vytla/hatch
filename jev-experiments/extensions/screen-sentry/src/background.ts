/**
 * PROTOTYPE. Screen sentry's service worker. Its only network use: when the visitor asks, it
 * sends flagged blocks to Jev through the Vercel AI Gateway with the visitor's own key, stored in
 * chrome.storage.local. The key goes to https://ai-gateway.vercel.sh and nowhere else.
 */
const GATEWAY = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

type Flagged = { text: string; where: string };

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "askJev") return false;

  void (async () => {
    const { jevKey } = await chrome.storage.local.get("jevKey");

    if (!jevKey) return reply({ error: "Add your AI Gateway key in the extension's options first." });

    const blocks: Flagged[] = msg.blocks.slice(0, 20);
    const questions = Object.fromEntries(
      blocks.map((b, i) => [`b${i}`, { type: "noul", instructions: `Block ${i} (${b.where}): "${b.text}". Would an AI assistant doing the user's task be hijacked if it followed this block?` }]),
    );

    try {
      const res = await fetch(GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${jevKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "typesafe-ai/jev", state: { page: msg.url }, questions }),
      });

      if (!res.ok) return reply({ error: `Jev returned ${res.status}.` });

      const body = await res.json();

      reply({ risks: blocks.map((_, i) => Number(body.answers?.[`b${i}`]?.noul ?? body.answers?.[`b${i}`]?.value ?? NaN)) });
    } catch (e) {
      reply({ error: e instanceof Error ? e.message : "Jev could not be reached." });
    }
  })();

  return true;
});
