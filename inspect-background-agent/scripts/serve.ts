import { startControlPlane } from "../src/server/control-plane.js";

const cp = await startControlPlane({
  port: Number(process.env.PORT ?? 8787),
  modelProvider: process.env.OPENCODE_PROVIDER ?? "opencode",
  modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
});

console.log(
  `Hatch Inspect on http://${cp.host === "0.0.0.0" ? "127.0.0.1" : cp.host}:${cp.port}` +
    (process.env.INSPECT_PASSWORD ? " (password protected)" : ""),
);
console.log(`OpenCode model: ${process.env.OPENCODE_PROVIDER ?? "opencode"}/${process.env.OPENCODE_MODEL ?? "big-pickle"}`);

const shutdown = async () => {
  console.log("shutting down…");
  await cp.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
