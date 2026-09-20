// Local review tool: sample actual recorded frames without accessing a camera.
const file = new URL("./assets/spoken-try-on-demo.webm", import.meta.url);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8897,
  fetch(req) {
    if (new URL(req.url).pathname === "/video")
      return new Response(Bun.file(file));
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Actual Lucy recording review</title><style>body{background:#e9ece4;color:#24372c;font-family:system-ui;padding:20px}#frames{display:flex;gap:12px}canvas{width:250px;height:auto;border-radius:10px}video{width:220px}small{display:block}</style></head><body><h1>Actual Lucy 2.1 recording</h1><p>Original illustrated presenter → Lucy. Synthetic spoken commands → local Whisper → real guarded Jev decisions, replayed to Lucy. No camera or microphone.</p><video id="v" controls muted preload="auto" src="/video"></video><button id="sample">Inspect 4 / 13 / 21 / 29 second frames</button><p id="status"></p><div id="frames"></div><script>sample.onclick=async()=>{sample.disabled=true;for(const t of[4,13,21,29]){v.currentTime=t;await new Promise(r=>v.onseeked=r);const box=document.createElement('div'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);box.append(c);const s=document.createElement('small');s.textContent=t+' seconds';box.append(s);document.getElementById('frames').append(box);}document.getElementById('status').textContent=v.videoWidth+'×'+v.videoHeight+' decoded pixels; actual frame samples.';};</script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
setTimeout(() => server.stop(true), 180000);
console.log("Review at http://127.0.0.1:8897");
