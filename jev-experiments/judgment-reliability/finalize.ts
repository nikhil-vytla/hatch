/** Wait for an already-running recorder, then verify and summarize its evidence. No model calls or publication. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const arg = process.argv.find(value => value.startsWith("--wait-for-pid="));
const pid = Number(arg?.split("=")[1]);
if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Specify the existing recorder with --wait-for-pid=PID.");
const folder = import.meta.dir;
const status = (state: string, message?: string) => {
  const result = { at: new Date().toISOString(), state, recorderPid: pid, ...(message ? { message } : {}) };
  writeFileSync(resolve(folder, ".finalization.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
};
try {
  status("waiting", "Waiting for the existing recording process; no additional model requests.");
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  while (true) {
    try { process.kill(pid, 0); } catch { break; }
    if (Date.now() > deadline) throw Error("Recorder still running after four hours. No evidence or publication was changed.");
    await Bun.sleep(10000);
  }
  if (existsSync(resolve(folder, ".recording.lock"))) throw Error("Recorder lock remains. Inspect the process before finalizing.");
  status("verifying");
  for (const args of [["verify.ts", "--complete"], ["analyze.ts"], ["report.ts"]]) {
    const child = Bun.spawn(["bun", ...args], { cwd: folder, stdout: "inherit", stderr: "inherit" });
    if (await child.exited) throw Error(`${args[0]} failed; final publication is blocked.`);
  }
  status("verified", "All planned decisions passed complete verification and reports were regenerated. Review and publish the final data snapshot separately.");
} catch (error) {
  status("needs-review", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
