import { startWorkspace } from "../src/server.js";

const ws = await startWorkspace();
console.log(`Agent Workspace on http://${ws.host === "0.0.0.0" ? "127.0.0.1" : ws.host}:${ws.port}`);
console.log(`Backend: ${ws.backend.mode} · ${ws.backend.model}`);
console.log(`Data: ${ws.dataDir}`);

const shutdown = async () => {
  await ws.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
