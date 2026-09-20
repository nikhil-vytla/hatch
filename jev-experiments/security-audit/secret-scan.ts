/** Report filenames and counts only. Never print credential values or matching text. */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
const root = resolve(import.meta.dir, "../../");
const lab = resolve(root, "jev-experiments");
const credentials: string[] = [];
const shell = readFileSync(join(homedir(), ".zshrc"), "utf8");
const line = shell.split("\n").find(s => /^\s*(export\s+)?AI_GATEWAY_API_KEY\s*=/.test(s));
if (line) {
  const value = line.replace(/^\s*(export\s+)?AI_GATEWAY_API_KEY\s*=\s*/, "").trim().replace(/^['"]|['"]$/g, "");
  if (value.length > 12 && !/[$`;]/.test(value)) credentials.push(value);
}
credentials.push(readFileSync(join(lab, ".cache/live-access-token"), "utf8").trim());
if (credentials.length !== 2 || credentials.some(x => x.length < 12)) throw new Error("Could not load both authorized credentials for an exact-value scan.");
const patterns: [string, RegExp][] = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["OpenAI-style token", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{35,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Vercel token", /\bvck_[A-Za-z0-9_-]{25,}\b/],
];
const git = (args: string[]) => execFileSync("git", args, { cwd: root, maxBuffer: 30_000_000 });
const commits = git(["rev-list", "origin/main..HEAD"]).toString().trim().split("\n");
const findings: any[] = [];
const checkedBlobs = new Set<string>();
for (const commit of commits) {
  const entries = git(["ls-tree", "-r", commit, "--", "jev-experiments"]).toString().trim().split("\n");
  for (const entry of entries) {
    const [info, path] = entry.split("\t");
    const oid = info.split(" ")[2];
    if (checkedBlobs.has(oid)) continue;
    checkedBlobs.add(oid);
    inspect(git(["cat-file", "blob", oid]), `${commit.slice(0, 7)}:${path}`);
  }
}
function inspect(bytes: Buffer, path: string) {
  for (let i = 0; i < credentials.length; i++) if (bytes.includes(Buffer.from(credentials[i]))) findings.push({ path, kind: i === 0 ? "actual gateway key" : "actual private lab token" });
  const text = bytes.toString("utf8");
  for (const [kind, expression] of patterns) if (expression.test(text)) findings.push({ path, kind });
}
const stagedPaths = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", "jev-experiments"]).toString().trim().split("\n").filter(Boolean);
for (const path of stagedPaths) inspect(git(["show", ":" + path]), "staged:" + path);
let publicFiles = 0;
function walk(dir: string) {
  if (!existsSync(dir)) return;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) walk(path);
    else { publicFiles++; inspect(readFileSync(path), path.replace(root + "/", "")); }
  }
}
walk(join(lab, "experience-prototypes/dist"));
const origin = process.argv.find(arg => arg.startsWith("--origin="))?.slice(9) ?? "https://jev-experiments.vercel.app";
const fetchPage = process.argv.includes("--owner") ? (await import("../merge-readiness/deployment-fetch")).ownerFetch : fetch;
const html = await (await fetchPage(origin)).text();
inspect(Buffer.from(html), "production:/");
const assets = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1]));
for (const asset of assets) {
  const response = await fetchPage(origin + asset);
  if (!response.ok) throw new Error("Could not scan production asset " + asset);
  const bytes = Buffer.from(await response.arrayBuffer());
  inspect(bytes, "production:" + asset);
  for (const match of bytes.toString().matchAll(/(?:\.\/|\/assets\/)([A-Za-z0-9_-]+\.(?:js|css))/g)) assets.add("/assets/" + match[1]);
}
const dataFiles = readdirSync(join(lab, "experience-prototypes/dist/data")).filter(name => name.endsWith(".json"));
for (const name of dataFiles) {
  const response = await fetchPage(origin + "/data/" + name);
  if (!response.ok) throw new Error("Could not scan production data " + name);
  inspect(Buffer.from(await response.arrayBuffer()), "production:/data/" + name);
}
const temporary = mkdtempSync(join(tmpdir(), "jev-security-"));
try {
  const zip = join(temporary, "companion.zip");
  writeFileSync(zip, Buffer.from(await (await fetchPage(origin + "/companion.zip")).arrayBuffer()));
  inspect(execFileSync("unzip", ["-p", zip], { maxBuffer: 1_000_000 }), "production:companion.zip contents");
} finally { rmSync(temporary, { recursive: true }); }
const report = { origin, access_mode: process.argv.includes("--owner") ? "owner-authenticated Vercel CLI" : "public HTTPS", commits: commits.length, unique_committed_blobs: checkedBlobs.size, staged_files: stagedPaths.length, local_built_public_files: publicFiles, production_assets: assets.size, production_data_files: dataFiles.length, production_companion_contents_checked: true, exact_credentials_checked: 2, signature_patterns: patterns.map(([kind]) => kind), findings };
writeFileSync(new URL("../merge-readiness/secret-scan.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
