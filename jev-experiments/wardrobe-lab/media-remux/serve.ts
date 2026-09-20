// Read-only, local media validation. Never starts a provider session.
const names = ["try-on-demo", "spoken-try-on-demo"];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 8898,
  fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    if (names.includes(name.replace(/\.webm$/, "")) && name.endsWith(".webm"))
      return new Response(Bun.file(new URL(`../assets/${name}`, import.meta.url)), { headers: { "Cache-Control": "no-store" } });
    if (name) return new Response("Not found", { status: 404 });
    return new Response(`<!doctype html><meta charset="utf-8"><title>Wardrobe WebM container verification</title><style>body{font:16px system-ui;padding:24px;background:#172018;color:#f1f3eb}main{display:flex;gap:24px}video{width:300px}p{max-width:650px}</style><h1>Existing wardrobe recordings</h1><p>Read-only playback of the repaired containers. No provider session, camera or microphone.</p><main>${names.map(id => `<section><h2>${id}</h2><video id="${id}" src="/${id}.webm" controls muted preload="auto"></video></section>`).join("")}</main>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
  },
});
setTimeout(() => server.stop(true), 300_000);
console.log("Read-only media check at http://127.0.0.1:8898 for five minutes");
