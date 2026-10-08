import { startCloudControlPlane } from "../src/server/control-plane-cloud.js";

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? "0.0.0.0";
const computeUrl = process.env.COMPUTE_URL ?? "http://127.0.0.1:8790";

const cp = await startCloudControlPlane({
  port,
  host,
  computeUrl,
  computeToken: process.env.COMPUTE_TOKEN,
  modelProvider: process.env.OPENCODE_PROVIDER ?? "opencode",
  modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
});

console.log(
  `Hatch Inspect CLOUD control plane on http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
);
console.log(`Compute: ${computeUrl}`);

const shutdown = async () => {
  await cp.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
