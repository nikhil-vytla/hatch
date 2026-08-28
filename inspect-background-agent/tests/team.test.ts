import { describe, expect, it } from "vitest";
import path from "node:path";
import { Automations } from "../src/control/automations.js";
import { parseGitHubRemote } from "../src/scm/github.js";
import { GitSandboxManager } from "../src/sandbox/git-sandbox.js";

describe("automations", () => {
  it("runs due automations and pauses after 3 failures", async () => {
    const ran: string[] = [];
    let fail = false;
    const autos = new Automations(async (a) => {
      if (fail) throw new Error("boom");
      ran.push(a.id);
      return `ses_${a.id}`;
    });
    autos.add({ id: "a1", name: "hourly", prompt: "do it", everyMs: 1000 });

    await autos.tick(1_000);
    expect(ran).toEqual(["a1"]);
    // Not due yet.
    await autos.tick(1_500);
    expect(ran).toEqual(["a1"]);
    // Due again.
    await autos.tick(2_100);
    expect(ran).toEqual(["a1", "a1"]);

    fail = true;
    await autos.tick(3_200);
    await autos.tick(4_300);
    await autos.tick(5_400);
    expect(autos.get("a1")?.enabled).toBe(false);
    expect(autos.get("a1")?.consecutiveFailures).toBe(3);
  });
});

describe("github remote parsing", () => {
  it("parses https and ssh, rejects others", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitHubRemote("/tmp/some/local/repo")).toBeNull();
    expect(parseGitHubRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
  });
});

describe("git push to origin", () => {
  it("pushes the session branch to a local bare remote", async () => {
    const root = path.join("/tmp", "hatch-inspect-test", `push_${Date.now()}`);
    const mgr = new GitSandboxManager(root);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const bare = path.join(root, "origin.git");
    await run("git", ["init", "--bare", bare]);

    const sb = await mgr.create({ id: "pushy", cloneUrl: bare });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(sb.repoDir, "change.txt"), "hello\n");
    await mgr.commitAll(sb.repoDir, "test: change", {
      name: "Pusher",
      email: "p@x",
    });
    await mgr.push(sb.repoDir, sb.branch);

    const { stdout } = await run("git", ["--git-dir", bare, "branch", "--list"]);
    expect(stdout).toContain(sb.branch);
  });
});
