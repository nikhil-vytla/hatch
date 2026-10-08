// Record a replay as an mp4 under 2 MB: node --experimental-strip-types --no-warnings video/record.ts <data.json> <out.mp4>
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const [dataFile, outFile] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const work = mkdtempSync(join(tmpdir(), "rec-"));
copyFileSync(join(import.meta.dirname, "player.html"), join(work, "player.html"));
writeFileSync(join(work, "data.js"), `window.DATA = ${readFileSync(dataFile, "utf8")};`);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: work, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
await page.goto(`file://${join(work, "player.html")}`);
await page.waitForFunction(() => (window as any).done === true, null, { timeout: 15 * 60_000, polling: 500 });
await context.close();
await browser.close();
const webm = join(work, readdirSync(work).find((f) => f.endsWith(".webm"))!);
for (const crf of [30, 34, 38, 42]) {
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "fps=12", "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile]);
	const mb = statSync(outFile).size / 1e6;
	console.log(`${outFile}: ${mb.toFixed(2)} MB (crf ${crf})`);
	if (mb < 1.9) break;
}
