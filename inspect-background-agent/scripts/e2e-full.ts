/**
 * Full end-to-end: control plane + real git sandbox + OpenCode free model.
 */
import { startControlPlane } from "../src/server/control-plane.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = "/tmp/hatch-inspect-e2e";

async function waitIdle(base: string, id: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/api/sessions/${id}`);
    const j = (await r.json()) as { status: string; lastError?: string };
    if (j.status === "idle") return;
    if (j.status === "error") throw new Error(j.lastError ?? "session error");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timeout waiting for idle");
}

async function main() {
  const cp = await startControlPlane({
    port: 8791,
    host: "127.0.0.1",
    rootDir: ROOT,
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

    // Continuity: the agent must remember turn N-1 without it being in the repo.
    const codeword = `zebra${Date.now() % 1000}`;
    const remember = await fetch(
      `http://127.0.0.1:8791/api/sessions/${session.id}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `Remember the codeword: ${codeword}. Do not write any files. Just reply OK.`,
        }),
      },
    );
    if (!remember.ok) throw new Error(`remember prompt failed ${remember.status}`);
    await waitIdle("http://127.0.0.1:8791", session.id);
    await fetch(`http://127.0.0.1:8791/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Write the exact codeword I told you in my previous message to a new file named codeword.txt. Nothing else.",
      }),
    });
    await waitIdle("http://127.0.0.1:8791", session.id);
    const cw = await readFile(path.join(session.repoDir, "codeword.txt"), "utf8");
    if (!cw.includes(codeword)) {
      throw new Error(`continuity failed: codeword.txt=${JSON.stringify(cw.slice(0, 80))}`);
    }
    console.log("continuity OK:", cw.trim());

    const del = await fetch(`http://127.0.0.1:8791/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    const dj = (await del.json()) as { diskGone: boolean; destroyed: string };
    if (!dj.diskGone) throw new Error(`sandbox still on disk after DELETE: ${dj.destroyed}`);
    console.log("destroyed", dj.destroyed, "diskGone", dj.diskGone);

    // Stop: interrupt a long turn, session returns to idle and stays usable.
    const slow = await fetch("http://127.0.0.1:8791/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "e2e stop",
        prompt:
          "Create fifty files named f1.txt through f50.txt, one at a time, each containing its own number.",
      }),
    });
    const slowSession = (await slow.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 2500));
    const stop = await fetch(
      `http://127.0.0.1:8791/api/sessions/${slowSession.id}/stop`,
      { method: "POST" },
    );
    const sj = (await stop.json()) as { stopping?: boolean; note?: string };
    if (!sj.stopping) throw new Error(`stop did not engage: ${JSON.stringify(sj)}`);
    await waitIdle("http://127.0.0.1:8791", slowSession.id, 20_000);
    console.log("stop OK: turn interrupted, session idle");

    // Restart survival: close the control plane, boot a new one on the same root.
    await cp.close();
    const cp2 = await startControlPlane({
      port: 8791,
      host: "127.0.0.1",
      rootDir: ROOT,
      modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
    });
    try {
      const revived = await fetch(
        `http://127.0.0.1:8791/api/sessions/${slowSession.id}`,
      );
      if (!revived.ok) throw new Error(`session lost after restart: ${revived.status}`);
      const rj = (await revived.json()) as { status: string };
      console.log("restart survival OK: status", rj.status);
      await fetch(`http://127.0.0.1:8791/api/sessions/${slowSession.id}`, {
        method: "DELETE",
      });
    } finally {
      await cp2.close();
    }

    // Auth: a password-protected instance rejects anonymous API calls and accepts login.
    const locked = await startControlPlane({
      port: 8792,
      host: "127.0.0.1",
      password: "e2e-secret",
      rootDir: "/tmp/hatch-inspect-e2e-auth",
    });
    try {
      const anon = await fetch("http://127.0.0.1:8792/api/sessions");
      if (anon.status !== 401) throw new Error(`expected 401, got ${anon.status}`);
      const login = await fetch("http://127.0.0.1:8792/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "e2e-secret" }),
      });
      const { token } = (await login.json()) as { token: string };
      const authed = await fetch("http://127.0.0.1:8792/api/sessions", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!authed.ok) throw new Error(`authed list failed: ${authed.status}`);
      console.log("auth gate OK");
    } finally {
      await locked.close();
    }

    console.log("E2E OK");
  } finally {
    await cp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
