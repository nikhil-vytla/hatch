import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Deploy updates into the established lab, even from a fresh checkout.
const root = fileURLToPath(new URL("../", import.meta.url));
const project = {
  projectId: "prj_D85FuYXgN0CQm4l1OcsuCQnfK1DO",
  orgId: "team_wusYruyUZNwrsOELxkBruPf2",
  projectName: "jev-experiments",
};
mkdirSync(`${root}/.vercel`, { recursive: true });
writeFileSync(`${root}/.vercel/project.json`, JSON.stringify(project));

for (const args of [
  ["run", "build"],
  ["x", "--bun", "vercel", "deploy", "--prod", "--yes"],
]) {
  const result = spawnSync("bun", args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VERCEL_PROJECT_ID: project.projectId,
      VERCEL_ORG_ID: project.orgId,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
