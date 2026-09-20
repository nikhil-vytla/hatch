/** Runs the original browser checks through the installed Playwright CLI. */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
const lifecycle = process.argv.includes("--lifecycle"), regression = process.argv.includes("--regression"), name = regression ? "browser-regression" : lifecycle ? "browser-lifecycle" : "browser-qa";
const code = await Bun.file(resolve(import.meta.dir, regression ? "browser-regression-qa.js" : lifecycle ? "browser-lifecycle-qa.js" : "browser-qa.js")).text();
mkdirSync("output/playwright", { recursive: true });
const cli = resolve(homedir(), ".codex/skills/playwright/scripts/playwright_cli.sh");
const child = Bun.spawn([cli, "-s=ghost-brush", "run-code", code], { stdout: "pipe", stderr: "pipe" });
const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text(), exit = await child.exited;
const result = output.match(/### Result\n([^\n]+)/)?.[1];
if (exit || !result || output.includes("### Error")) throw new Error(output + error);
const parsed = { ...JSON.parse(result), checkedAt: new Date().toISOString(), page: "http://127.0.0.1:5193/#experiment/ghost-brush" };
await Bun.write(resolve(import.meta.dir, `${name}.json`), JSON.stringify(parsed, null, 2) + "\n");
console.log(JSON.stringify(parsed, null, 2));
