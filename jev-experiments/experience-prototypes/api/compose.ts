import { authorize } from "../server/gateway.js";
import { compose } from "../server/compose.js";
export default async function handler(req: any, res: any) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST." });
  if (!authorize(req.headers.authorization))
    return res
      .status(401)
      .json({ error: "Enter the private lab token to run live." });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 52000);
  res.on?.("close", () => controller.abort());
  try {
    for await (const event of compose(req.body, controller.signal))
      res.write(JSON.stringify(event) + "\n");
  } catch (e) {
    res.write(
      JSON.stringify({
        type: "error",
        error: e instanceof Error ? e.message : "Composition interrupted.",
      }) + "\n",
    );
  } finally {
    clearTimeout(timer);
    res.end();
  }
}
