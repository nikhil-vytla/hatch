// Code under ../packages and ../live-worlds imports npm packages but has no package.json of its
// own. This links their node_modules to this app's node_modules after every install (locally, in
// CI and on Vercel), so those imports resolve. The link is created here rather than committed: Vercel
// drops node_modules paths when it uploads the repo, and the typed-runtime check rejects them.
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of ["packages", "live-worlds"]) {
  const link = join(app, "..", dir, "node_modules");

  if (!existsSync(join(app, "..", dir))) continue;

  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // No link yet.
  }

  if (!existsSync(link)) symlinkSync("../experience-prototypes/node_modules", link, "dir");
}
