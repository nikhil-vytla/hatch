import { OpenCodeBridge } from "../src/agent/opencode-bridge.js";
import { GitSandboxManager } from "../src/sandbox/git-sandbox.js";
import path from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const sandboxes = new GitSandboxManager(path.join("/tmp", "hatch-inspect", "debug-sb"));
const sb = await sandboxes.create({ id: "dbg1" });
console.log("repo", sb.repoDir);
const bridge = new OpenCodeBridge();
for await (const d of bridge.runPrompt({
  sessionId: "x",
  directory: sb.repoDir,
  text: "Create src/math.ts exporting function add(a: number, b: number): number that returns a+b.",
  timeoutMs: 120000,
})) {
  console.log("DELTA", d.kind, JSON.stringify(d).slice(0, 240));
}
console.log("files", readdirSync(path.join(sb.repoDir, "src")));
if (existsSync(path.join(sb.repoDir, "src/math.ts"))) {
  console.log(readFileSync(path.join(sb.repoDir, "src/math.ts"), "utf8"));
} else {
  console.log("math.ts missing");
}
