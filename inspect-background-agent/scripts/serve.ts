import { startControlPlane } from "../src/server/control-plane.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const cp = await startControlPlane({
  port,
  host,
  modelProvider: process.env.OPENCODE_PROVIDER ?? "opencode",
  modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
});

console.log(`Hatch Inspect control plane on http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
console.log(`OpenCode model: ${process.env.OPENCODE_PROVIDER ?? "opencode"}/${process.env.OPENCODE_MODEL ?? "big-pickle"}`);

const shutdown = async () => {
  console.log("shutting down…");
  await cp.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
