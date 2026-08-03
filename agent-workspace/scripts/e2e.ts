/**
 * E2E against the done predicate:
 *  auth → session → streamed real-model reply → persistence → RESTART → transcript survives.
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { startWorkspace } from "../src/server.js";

const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "e2e-secret";
const DATA = path.join("/tmp", "agent-workspace-e2e", `run_${Date.now()}`);

async function main() {
  await rm(DATA, { recursive: true, force: true });

  let ws = await startWorkspace({
    port: PORT,
    host: "127.0.0.1",
    dataDir: DATA,
    password: PASSWORD,
  });

  // 1. Unauthenticated requests are rejected.
  const noAuth = await fetch(`${BASE}/api/sessions`);
  if (noAuth.status !== 401) throw new Error(`expected 401, got ${noAuth.status}`);
  console.log("auth gate OK");

  // 2. Login.
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed ${login.status}`);
  const { token } = (await login.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  console.log("login OK");

  // 3. Create session + stream a chat reply from the real model.
  const created = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ title: "e2e chat" }),
  });
  const session = (await created.json()) as { id: string };
  console.log("session", session.id);

  const chat = await fetch(`${BASE}/api/sessions/${session.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      text: "Reply with exactly the word pong and nothing else.",
    }),
  });
  if (!chat.ok || !chat.body) throw new Error(`chat failed ${chat.status}`);
  const reader = chat.body.getReader();
  const dec = new TextDecoder();
  let streamed = "";
  let sawDone = false;
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const ev of events) {
      const type = ev.match(/^event: (.*)$/m)?.[1];
      const data = ev.match(/^data: (.*)$/m)?.[1];
      if (type === "delta" && data) streamed += (JSON.parse(data) as { text: string }).text;
      if (type === "done") sawDone = true;
      if (type === "error" && data) throw new Error(`backend error: ${data}`);
    }
  }
  if (!sawDone) throw new Error("no done event");
  if (!streamed.toLowerCase().includes("pong")) {
    throw new Error(`unexpected reply: ${streamed.slice(0, 200)}`);
  }
  console.log("streamed reply OK:", JSON.stringify(streamed.trim().slice(0, 60)));

  // 4. Path traversal is blocked.
  for (const evil of ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd"]) {
    const r = await fetch(`${BASE}/api/files/content?path=${evil}`, { headers: auth });
    if (r.status !== 400) throw new Error(`traversal not blocked: ${evil} -> ${r.status}`);
  }
  console.log("traversal guard OK");

  // 5. Restart the process-equivalent: close and boot a fresh server on the same data dir.
  await ws.close();
  ws = await startWorkspace({
    port: PORT,
    host: "127.0.0.1",
    dataDir: DATA,
    password: PASSWORD,
  });
  const relogin = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token: token2 } = (await relogin.json()) as { token: string };
  const after = await fetch(`${BASE}/api/sessions/${session.id}/messages`, {
    headers: { authorization: `Bearer ${token2}` },
  });
  const restored = (await after.json()) as {
    messages: { role: string; content: string }[];
  };
  const assistant = restored.messages.find((m) => m.role === "assistant");
  if (!assistant?.content.toLowerCase().includes("pong")) {
    throw new Error("transcript did not survive restart");
  }
  console.log("restart persistence OK:", restored.messages.length, "messages");

  await ws.close();
  console.log("E2E OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
