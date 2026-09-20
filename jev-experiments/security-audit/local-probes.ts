/** The original pre-fix reproduction is preserved at commit 49a46b7.
 * Current regression checks use synthetic keys and mock every provider call. */
import { spawnSync } from "node:child_process";
const result = spawnSync("bun", ["test", "server"], {
  cwd: new URL("../experience-prototypes/", import.meta.url), stdio: "inherit",
});
process.exitCode = result.status ?? 1;
