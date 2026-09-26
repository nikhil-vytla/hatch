import { sandboxEntry } from "../../packages/arena/src/contest/sandbox.js";
import { scoreSealed, unseal } from "../../packages/arena/src/contest/sealed.js";
import { SEALED_BLOB } from "../../packages/arena/src/contest/sealed-blob.js";
// Sealed scoring for One box contestants: the submitted code runs in a QuickJS sandbox on the
// server against phrases nobody has seen, and only aggregate scores come back.
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const key = process.env.ONE_BOX_SEALED_KEY;
  if (!SEALED_BLOB || !key) return res.status(503).json({ error: "Sealed scoring isn't open yet." });
  const code = req.body?.code;
  if (typeof code !== "string" || !code.trim() || code.length > 256_000)
    return res.status(400).json({ error: "Send your contestant as code, under 256 KB." });
  let dispose = () => {};
  try {
    const sandboxed = await sandboxEntry(code);
    dispose = sandboxed.dispose;
    return res.status(200).json(scoreSealed(sandboxed.entry, unseal(SEALED_BLOB, key)));
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : "Scoring failed." });
  } finally {
    dispose();
  }
}
