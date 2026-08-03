/**
 * Three-plane e2e: compute shim + cloud control plane (SQLite SessionAgent + ComputeClient).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { startCloudControlPlane } from "../src/server/control-plane-cloud.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

function waitHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url);
        if (r.ok) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`health timeout: ${url}`);
  })();
}

async function main() {
  const computePort = 8793;
  const controlPort = 8794;
  const shim: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/compute-shim.ts"],
    {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      env: { ...process.env, COMPUTE_PORT: String(computePort) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  shim.stderr?.on("data", (d) => process.stderr.write(d));
  shim.stdout?.on("data", (d) => process.stdout.write(d));

  try {
    await waitHealth(`http://127.0.0.1:${computePort}/health`);
    const cp = await startCloudControlPlane({
      port: controlPort,
      host: "127.0.0.1",
      computeUrl: `http://127.0.0.1:${computePort}`,
      dbPath: path.join("/tmp", "hatch-inspect-e2e-cloud", `db_${Date.now()}.sqlite`),
      modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
    });

    try {
      const create = await fetch(`http://127.0.0.1:${controlPort}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "cloud e2e",
          prompt:
            "Create src/math.ts exporting function add(a: number, b: number): number that returns a+b. Do not modify other files.",
          authorName: "Cloud E2E",
          authorEmail: "cloud-e2e@localhost",
        }),
      });
      if (!create.ok) throw new Error(`create ${create.status} ${await create.text()}`);
      const session = (await create.json()) as {
        id: string;
        plane: string;
        sandboxId: string;
      };
      console.log("session", session.id, "plane", session.plane);

      const deadline = Date.now() + 180_000;
      let art: { files: { path: string; content: string | null }[]; diff: string } | null =
        null;
      while (Date.now() < deadline) {
        const r = await fetch(`http://127.0.0.1:${controlPort}/api/sessions/${session.id}`);
        const j = (await r.json()) as {
          status: string;
          lastError?: string;
          files?: { path: string; content: string | null }[];
          diff?: string;
        };
        console.log("status", j.status, j.lastError ?? "");
        if (j.status === "idle" && j.files?.some((f) => f.path.includes("math"))) {
          art = { files: j.files, diff: j.diff ?? "" };
          break;
        }
        if (j.status === "error") throw new Error(j.lastError ?? "error");
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!art) throw new Error("timeout waiting for artifacts");
      const math = art.files.find((f) => f.path.endsWith("math.ts"));
      console.log("--- math ---");
      console.log(math?.content ?? "(missing)");
      if (!math?.content?.includes("add")) throw new Error("math.ts missing add");

      const del = await fetch(`http://127.0.0.1:${controlPort}/api/sessions/${session.id}`, {
        method: "DELETE",
      });
      const dj = (await del.json()) as { diskGone: boolean };
      console.log("destroyed diskGone", dj.diskGone);
      console.log("CLOUD E2E OK");
    } finally {
      await cp.close();
    }
  } finally {
    shim.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
