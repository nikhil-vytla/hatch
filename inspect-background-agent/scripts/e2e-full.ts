/**
 * Full end-to-end: control plane + real git sandbox + OpenCode free model.
 */
import { startControlPlane } from "../src/server/control-plane.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const cp = await startControlPlane({
    port: 8791,
    host: "127.0.0.1",
    modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
  });

  try {
    const create = await fetch("http://127.0.0.1:8791/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "e2e math",
        prompt:
          "Create src/math.ts exporting function add(a: number, b: number): number that returns a+b. Do not modify other files.",
        authorName: "E2E Bot",
        authorEmail: "e2e@localhost",
      }),
    });
    if (!create.ok) throw new Error(`create failed: ${create.status} ${await create.text()}`);
    const session = (await create.json()) as { id: string; repoDir: string; branch: string };
    console.log("session", session.id, session.branch);

    // Wait for turn to finish by polling status
    const deadline = Date.now() + 180_000;
    let finished = false;
    while (Date.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:8791/api/sessions/${session.id}`);
      const j = (await r.json()) as { status: string; gitStatus: string; lastError?: string };
      console.log("status", j.status, "dirty?", Boolean(j.gitStatus), j.lastError ?? "");
      if (j.status === "idle" && j.gitStatus) {
        finished = true;
        break;
      }
      if (j.status === "error") throw new Error(j.lastError ?? "session error");
      // also succeed if file exists even if git clean somehow
      try {
        const math = await readFile(path.join(session.repoDir, "src/math.ts"), "utf8");
        if (math.includes("add") && j.status === "idle") {
          finished = true;
          break;
        }
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!finished) throw new Error("timed out waiting for agent");

    const math = await readFile(path.join(session.repoDir, "src/math.ts"), "utf8");
    console.log("--- src/math.ts ---\n" + math);
    if (!/export\s+function\s+add/.test(math) && !/export\s+const\s+add/.test(math)) {
      // Accept any add implementation
      if (!math.includes("add")) throw new Error("math.ts missing add");
    }

    const models = await fetch("http://127.0.0.1:8791/api/models");
    const mj = (await models.json()) as { models: unknown[]; selected: { modelID: string } };
    if (!Array.isArray(mj.models) || mj.models.length < 2) {
      throw new Error("models endpoint empty");
    }
    console.log("models", mj.models.length, "selected", mj.selected.modelID);

    const commit = await fetch(`http://127.0.0.1:8791/api/sessions/${session.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: add math.add" }),
    });
    const cj = (await commit.json()) as { sha: string };
    console.log("committed", cj.sha);

    const del = await fetch(`http://127.0.0.1:8791/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    const dj = (await del.json()) as { diskGone: boolean; destroyed: string };
    if (!dj.diskGone) throw new Error(`sandbox still on disk after DELETE: ${dj.destroyed}`);
    console.log("destroyed", dj.destroyed, "diskGone", dj.diskGone);

    console.log("E2E OK");
  } finally {
    await cp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
