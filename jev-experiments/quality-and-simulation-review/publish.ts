/** Explicit publication command for the existing project, using a pushed Git commit. */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
const project = "prj_D85FuYXgN0CQm4l1OcsuCQnfK1DO", team = "team_wusYruyUZNwrsOELxkBruPf2";
if (!process.argv.includes("--production")) throw Error("Pass --production to publish the current pushed commit to the canonical app.");
const root = new URL("../../", import.meta.url).pathname;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD"), ref = git("branch", "--show-current");
if (!ref || git("ls-remote", "origin", `refs/heads/${ref}`).split(/\s/)[0] !== sha)
  throw Error("Push the exact current commit before deploying it.");
const auth = process.env.VERCEL_TOKEN || JSON.parse(readFileSync(`${homedir()}/Library/Application Support/com.vercel.cli/auth.json`, "utf8")).token;
async function api(path: string, body?: unknown) {
  const response = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${team}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw Error(`Vercel ${response.status}: ${error.error?.message ?? "request failed"}`); }
  return response.json();
}
const settings = await api(`/v9/projects/${project}`);
if (settings.rootDirectory !== "jev-experiments/experience-prototypes" || settings.sourceFilesOutsideRootDirectory !== true)
  throw Error("Project root/outside-root settings differ from the documented build contract.");
let deployment = await api("/v13/deployments", { name: "jev-experiments", project, target: "production", gitSource: { type: "github", repoId: "1092203195", ref, sha } });
const id = deployment.id;
let previous = "";
for (let n = 0; n < 180; n++) {
  const status = deployment.readyState ?? deployment.status;
  if (status !== previous) { console.log(JSON.stringify({ id, sha, status, url: deployment.url })); previous = status; }
  if (["READY", "ERROR", "CANCELED"].includes(status)) break;
  await Bun.sleep(5000);
  deployment = await api(`/v13/deployments/${id}`);
}
const report = { checkedAt: new Date().toISOString(), id, sha, ref, readyState: deployment.readyState, url: deployment.url, canonical: "https://jev-experiments.vercel.app", rootDirectory: settings.rootDirectory };
writeFileSync(new URL("./deployment.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
if (deployment.readyState !== "READY") throw Error(`Deployment did not complete: ${deployment.readyState}`);
console.log(JSON.stringify(report));
