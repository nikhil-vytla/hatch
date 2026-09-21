// Temporary loopback-only bridge for the authorized synthetic demo. Never deploy.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { localFalKey } from "./credentials";
import { wardrobeToken } from "../experience-prototypes/server/wardrobe-token";
import { FAL_MODEL } from "./engine";
const root = fileURLToPath(new URL("./", import.meta.url)),
  nonce = randomUUID(),
  origin = "http://127.0.0.1:8896";
const bundle = await Bun.build({
  entrypoints: [`${root}record-browser.ts`],
  target: "browser",
});
if (!bundle.success) throw new Error("Recorder browser bundle failed.");
mkdirSync(`${root}assets`, { recursive: true });
const spoken = process.env.WARDROBE_SPOKEN === "1";
const pipeline = spoken
  ? JSON.parse(readFileSync(`${root}spoken-pipeline.json`, "utf8"))
  : null;
if (spoken && (pipeline.status !== "complete" || pipeline.turns.length !== 4))
  throw new Error("Complete real speech/Jev evidence before recording.");
const outputStem = spoken ? "spoken-try-on-demo" : "try-on-demo";
let tokenRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8896,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && /^\/speech\/0[1-4]-[a-z]+\.wav$/.test(path))
      return new Response(Bun.file(`${root}assets${path}`));
    if (req.method === "GET" && path === "/bundle.js")
      return new Response(bundle.outputs[0], {
        headers: { "Content-Type": "text/javascript" },
      });
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (req.method === "GET" && path === "/")
      return new Response(
        `<!doctype html><html><head><title>Wardrobe synthetic recording</title><style>body{font-family:system-ui;background:#edf0e9;color:#24372c;padding:25px}section{display:flex;gap:20px}video,canvas{width:300px;height:450px;object-fit:cover;border-radius:14px}pre{white-space:pre-wrap;font-size:12px}button{padding:12px 20px}</style></head><body><h1>Synthetic wardrobe recording</h1><p>No camera or microphone. One bounded provider session using an illustrated adult presenter.</p><button id="record">Record 30 seconds</button><section><div><h3>Original code presenter</h3><canvas id="source" width="512" height="768"></canvas></div><div><h3>Actual Lucy 2.1 output</h3><video id="output" autoplay muted playsinline></video></div></section><pre id="status">Ready. No session started.</pre><script>window.__WARDROBE_RECORDING_NONCE__=${JSON.stringify(nonce)};window.__WARDROBE_SPOKEN_PIPELINE__=${JSON.stringify(pipeline).replaceAll("<", "\\u003c")}</script><script type="module" src="/bundle.js"></script></body></html>`,
        {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        },
      );
    if (
      req.method !== "POST" ||
      req.headers.get("origin") !== origin ||
      req.headers.get("x-recording-nonce") !== nonce
    )
      return Response.json(
        { error: "Local recording access only." },
        { status: 403 },
      );
    if (path === "/token") {
      if (++tokenRequests > 2)
        return Response.json(
          { error: "Bounded recording token allowance exhausted." },
          { status: 429 },
        );
      try {
        return Response.json(
          await wardrobeToken(localFalKey(), { model: FAL_MODEL }),
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : "Token unavailable" },
          { status: 503 },
        );
      }
    }
    if (path === "/video") {
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > 1_980_000)
        return Response.json(
          { error: "Video exceeds the artifact size limit." },
          { status: 413 },
        );
      writeFileSync(`${root}assets/${outputStem}.webm`, new Uint8Array(bytes));
      return Response.json({ saved: true, bytes: bytes.byteLength });
    }
    if (path === "/metadata") {
      const text = await req.text();
      if (text.length > 100000)
        return Response.json({ error: "Metadata too large" }, { status: 413 });
      const data = JSON.parse(text);
      writeFileSync(
        `${root}${spoken ? "spoken-recording" : "recording"}.json`,
        JSON.stringify(data, null, 2) + "\n",
      );
      return Response.json({ saved: true });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
setTimeout(() => server.stop(true), 180000);
console.log(
  "Synthetic recording bridge listening at http://127.0.0.1:8896 for at most three minutes.",
);
