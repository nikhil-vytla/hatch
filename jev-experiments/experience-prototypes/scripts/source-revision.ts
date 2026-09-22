import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  isRepositoryPath,
  type SourceRevision,
} from "../src/components/source-code/revision";

const registryId = "virtual:jev-source-revisions";
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const registryPath = fileURLToPath(
  new URL("../src/components/source-code/revision.ts", import.meta.url),
);

/** Only the requested, regular first-party source file is read. Other raw imports
 * retain Vite's normal handling and cannot acquire a revision proof here. */
export function loadSourceWithRevision(
  id: string,
  root: string,
  deployCommit?: string,
): { text: string; path: string; revision?: SourceRevision } | null {
  const query = id.indexOf("?");
  if (query < 0 || !new URLSearchParams(id.slice(query + 1)).has("raw"))
    return null;
  const requested = id.slice(0, query);
  if (!isAbsolute(requested) || !/\.[cm]?[jt]sx?$/.test(requested)) return null;
  let canonicalRoot: string;
  let path: string;
  let bytes: Buffer;
  try {
    canonicalRoot = realpathSync(root);
    path = relative(resolve(root), requested).split("\\").join("/");
    if (
      !isRepositoryPath(path) ||
      !path.startsWith("jev-experiments/") ||
      path.split("/").some((part) => part === "node_modules" || part === ".git") ||
      realpathSync(requested) !== resolve(canonicalRoot, path)
    )
      return null;
    bytes = readFileSync(requested);
  } catch {
    return null;
  }
  const text = bytes.toString("utf8");
  const source = { text, path };
  // Invalid UTF-8 cannot be presented as the exact Git bytes.
  if (!Buffer.from(text, "utf8").equals(bytes)) return source;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", canonicalRoot, ...args], {
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    if (
      realpathSync(git("rev-parse", "--show-toplevel").toString().trim()) !==
      canonicalRoot
    )
      return source;
    // An explicit deployment SHA is authoritative. If unavailable or malformed,
    // do not substitute another commit. Local builds use the pinned remote ref.
    if (deployCommit !== undefined && !/^[a-f0-9]{40}$/.test(deployCommit))
      return source;
    const commit = git(
      "rev-parse",
      "--verify",
      `${deployCommit ?? "origin/main"}^{commit}`,
    )
      .toString()
      .trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) return source;
    const committed = git("show", `${commit}:${path}`);
    if (!committed.equals(bytes)) return source;
    return {
      ...source,
      revision: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        commit,
        basis: deployCommit === undefined ? "repository" : "build",
      },
    };
  } catch {
    // Source downloads and excerpts still work without Git or a matching blob.
    return source;
  }
}

export function sourceRevisionPlugin(): Plugin {
  return {
    name: "jev-source-revision",
    enforce: "pre",
    resolveId(id) {
      if (id === registryId) return registryPath;
    },
    load(id) {
      const source = loadSourceWithRevision(
        id,
        repositoryRoot,
        process.env.VERCEL_GIT_COMMIT_SHA,
      );
      if (!source) return;
      const registration = source.revision
        ? `import { registerSourceRevision } from ${JSON.stringify(registryId)};\nregisterSourceRevision(${JSON.stringify(source.revision)});\n`
        : "";
      return {
        code: `${registration}export default ${JSON.stringify(source.text)};`,
        moduleSideEffects: true,
      };
    },
  };
}
