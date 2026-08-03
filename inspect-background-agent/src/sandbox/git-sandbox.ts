import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type GitAuthor = {
  readonly name: string;
  readonly email: string;
};

export type SandboxInfo = {
  readonly id: string;
  readonly root: string;
  readonly repoDir: string;
  readonly branch: string;
  readonly remoteUrl: string | null;
};

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export class GitSandboxManager {
  constructor(private readonly baseDir: string) {}

  async ensureBase(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Create a sandbox either by cloning a remote/local git URL, or by seeding
   * a fresh git repo with a README (for demos without a remote).
   */
  async create(args: {
    readonly id?: string;
    readonly cloneUrl?: string;
    readonly seedFiles?: Record<string, string>;
    readonly baseBranch?: string;
    readonly branchPrefix?: string;
  }): Promise<SandboxInfo> {
    await this.ensureBase();
    const id = args.id ?? `sb_${randomBytes(4).toString("hex")}`;
    const root = path.join(this.baseDir, id);
    const repoDir = path.join(root, "repo");
    await mkdir(repoDir, { recursive: true });

    const branchPrefix = args.branchPrefix ?? "inspect/";
    const branch = `${branchPrefix}${id}`;

    if (args.cloneUrl) {
      await git(root, [
        "clone",
        "--depth",
        "50",
        ...(args.baseBranch ? ["--branch", args.baseBranch] : []),
        args.cloneUrl,
        "repo",
      ]);
      await git(repoDir, ["checkout", "-B", branch]);
    } else {
      await git(repoDir, ["init", "-b", "main"]);
      const seed = args.seedFiles ?? {
        "README.md": `# Sandbox ${id}\n\nCreated by @hatch/inspect.\n`,
        "package.json": JSON.stringify({ name: `sandbox-${id}`, private: true }, null, 2) + "\n",
      };
      for (const [rel, content] of Object.entries(seed)) {
        const abs = path.join(repoDir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
      await git(repoDir, ["add", "-A"]);
      await git(
        repoDir,
        ["-c", "user.name=Inspect", "-c", "user.email=inspect@localhost", "commit", "-m", "chore: seed sandbox"],
      );
      await git(repoDir, ["checkout", "-B", branch]);
    }

    return {
      id,
      root,
      repoDir,
      branch,
      remoteUrl: args.cloneUrl ?? null,
    };
  }

  async setAuthor(repoDir: string, author: GitAuthor): Promise<void> {
    await git(repoDir, ["config", "user.name", author.name]);
    await git(repoDir, ["config", "user.email", author.email]);
  }

  async status(repoDir: string): Promise<string> {
    return git(repoDir, ["status", "--porcelain"]);
  }

  async diff(repoDir: string): Promise<string> {
    return git(repoDir, ["diff", "HEAD"]);
  }

  async commitAll(repoDir: string, message: string, author: GitAuthor): Promise<string> {
    await this.setAuthor(repoDir, author);
    await git(repoDir, ["add", "-A"]);
    const porcelain = await this.status(repoDir);
    if (!porcelain) {
      return git(repoDir, ["rev-parse", "HEAD"]);
    }
    await git(repoDir, ["commit", "-m", message]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  }

  async currentBranch(repoDir: string): Promise<string> {
    return git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /**
   * Fork: new sandbox from another repo's committed HEAD (+ optional dirty tree commit first by caller).
   * Clones the source path locally onto a fresh inspect/ branch.
   */
  async forkFrom(args: {
    readonly sourceRepoDir: string;
    readonly id?: string;
    readonly branchPrefix?: string;
  }): Promise<SandboxInfo> {
    await this.ensureBase();
    const id = args.id ?? `sb_${randomBytes(4).toString("hex")}`;
    const root = path.join(this.baseDir, id);
    const repoDir = path.join(root, "repo");
    await mkdir(root, { recursive: true });
    const branchPrefix = args.branchPrefix ?? "inspect/";
    const branch = `${branchPrefix}${id}`;
    await git(root, ["clone", args.sourceRepoDir, "repo"]);
    await git(repoDir, ["checkout", "-B", branch]);
    return {
      id,
      root,
      repoDir,
      branch,
      remoteUrl: null,
    };
  }

  async destroy(id: string): Promise<void> {
    await rm(path.join(this.baseDir, id), { recursive: true, force: true });
  }
}

export function defaultSandboxRoot(): string {
  return path.join("/tmp", "hatch-inspect", "sandboxes");
}

/** Resolve path to the opencode binary shipped with this package. */
export function opencodeBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/sandbox -> ../../node_modules/.bin/opencode when running via tsx
  const candidates = [
    path.resolve(process.cwd(), "node_modules/.bin/opencode"),
    path.resolve(here, "../../node_modules/.bin/opencode"),
    path.resolve(here, "../../../node_modules/.bin/opencode"),
  ];
  return candidates[0]!;
}

export async function assertExists(p: string): Promise<void> {
  await access(p);
}

export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
