// Probe (drafted by deepseek-flash, extended by hand): does the DevTools frontend fetch remote
// background-image URLs in %c styles, or call custom formatters, when it paints a message?
// Result on Chromium 153: neither. Run: xvfb-run -a node tools/ack-probe.mjs
// ack-probe.mjs — Does the Chrome DevTools *frontend* fetch the background-image:url(...)
// that appears in a %c console style? If it does, /ack records let us observe DevTools rendering.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = 3201;
const CHROME = process.env.CHROME || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const DEBUG_PORT = 9334;
const RUN_MS = 14_000;

// 1x1 transparent PNG (hard-coded).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const sent = []; // {n, at}     — page told us it logged message n
const acks = [];
const fmts = []; // custom-formatter header() calls // {n, at, ...} — someone fetched the CSS background image for n

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>ack probe</title>
<body>ack probe
<script>
let n = 0;
// Custom formatter: header() runs in the page when DevTools asks for it. Report each call.
window.devtoolsFormatters = [{
  header(o) { if (!o || !o.__probe) return null; fetch("/fmt?n=" + o.__probe + "&t=" + Date.now()); return ["span", {}, "#" + o.__probe]; },
  hasBody() { return false; },
}];
const iv = setInterval(() => {
  n++;
  // The %c style below references a remote image; does DevTools (the frontend) load it?
  console.log("%cframe " + n + "%c ",
    "color:red",
    "background-image:url(http://127.0.0.1:3201/ack?n=" + n + "&t=" + Date.now() + ");background-size:1px 1px;padding-left:1px");
  console.log("%cdata-url frame " + n, "background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==);padding-left:8px");
  console.log({ __probe: n });
  fetch("/sent?n=" + n);
  if (n >= 20) clearInterval(iv);
}, 500);
</script>`;

function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  // Log every request line (helps see what DevTools actually asks for).
  console.log(`${req.method} ${url.pathname}${url.search} dest=${req.headers["sec-fetch-dest"] ?? "-"}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (url.pathname === "/ack") {
    acks.push({
      n: Number(url.searchParams.get("n")),
      at: Date.now(),
      ua: req.headers["user-agent"] ?? null,
      referer: req.headers.referer ?? null,
      origin: req.headers.origin ?? null,
      secFetchSite: req.headers["sec-fetch-site"] ?? null,
      secFetchDest: req.headers["sec-fetch-dest"] ?? null,
    });
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": PNG.length,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(PNG);
    return;
  }

  if (url.pathname === "/fmt") { fmts.push({ n: Number(url.searchParams.get("n")), at: Date.now() }); res.writeHead(204); res.end(); return; }
  if (url.pathname === "/sent") {
    sent.push({ n: Number(url.searchParams.get("n")), at: Date.now() });
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

// Fresh profile dir with prefs that dock DevTools at the bottom on the Console panel.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ack-probe-profile-"));
fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
fs.writeFileSync(
  path.join(profile, "Default", "Preferences"),
  JSON.stringify({
    devtools: {
      preferences: {
        currentDockState: '"bottom"',
        "panel-selected-tab": '"console"',
        customFormatters: "true",
      },
    },
  })
);

const server = http.createServer(handle);

server.listen(PORT, HOST, () => {
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--auto-open-devtools-for-tabs",
      "--window-size=1400,900",
      "--disable-gpu",
      `http://${HOST}:${PORT}/`,
    ],
    { stdio: "ignore" }
  );
  chrome.on("error", (err) => console.error("chrome spawn error:", err.message));

  setTimeout(() => {
    // Build summary: sent count, ack count, per-n latency, first ack's headers.
    const latencies = {};
    for (const a of acks) {
      const s = sent.find((r) => r.n === a.n);
      latencies[a.n] = s ? a.at - s.at : null;
    }
    const first = acks[0];
    const summary = {
      sentCount: sent.length,
      ackCount: acks.length,
      fmtCalls: fmts.map((f) => [f.n, f.at - (sent.find((r) => r.n === f.n)?.at ?? NaN)]),
      latencies,
      firstAck: first
        ? {
            n: first.n,
            ua: first.ua,
            referer: first.referer,
            origin: first.origin,
            secFetchSite: first.secFetchSite,
            secFetchDest: first.secFetchDest,
          }
        : null,
    };
    console.log(JSON.stringify(summary, null, 2));

    chrome.kill("SIGKILL");
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref(); // safety net
  }, RUN_MS);
});
