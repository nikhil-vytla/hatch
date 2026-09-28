import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourceWithRevision } from "../../experience-prototypes/scripts/source-revision";
import {
  registerSourceRevision,
  sourceRevision,
} from "../../experience-prototypes/src/components/source-code/revision";
import {
  pinnedSource,
  sourceFileName,
} from "../../experience-prototypes/src/components/source-code/source";

const temporary = mkdtempSync(join(tmpdir(), "jev-source-revision-test-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;
const path = "jev-experiments/engine.ts";
const original = "\uFEFF// café\r\nexport const answer = 1;\r\n\r\n";

function fixture(gitEnabled = true) {
  const root = join(temporary, String(++sequence));
  const file = join(root, path);
  mkdirSync(join(root, "jev-experiments"), { recursive: true });
  writeFileSync(file, original);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  let commit = "";
  if (gitEnabled) {
    git("init");
    git("add", path);
    git(
      "-c", "user.name=Source fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "Original source fixture",
    );
    commit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", commit);
  }
  return { root, file, git, commit };
}

test("a pinned repository link proves the exact BOM, CRLF and trailing bytes", () => {
  const f = fixture();
  const loaded = loadSourceWithRevision(`${f.file}?raw`, f.root)!;
  expect(loaded.text).toBe(original);
  expect(loaded.path).toBe(path);
  expect(loaded.revision).toEqual({
    path,
    sha256: createHash("sha256").update(original).digest("hex"),
    commit: f.commit,
    basis: "repository",
  });
  expect(pinnedSource(path, loaded.revision?.commit)).toContain(`/blob/${f.commit}/`);
});

test("dirty bytes, untracked files and HEAD-only commits get no repository claim", () => {
  const f = fixture();
  const changed = original.replace("= 1", "= 2");
  writeFileSync(f.file, changed);
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root)).toEqual({ text: changed, path });
  f.git("add", path);
  f.git("-c", "user.name=Source fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Unpublished edit");
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root)?.revision).toBeUndefined();
  const untracked = join(f.root, "jev-experiments/untracked.ts");
  writeFileSync(untracked, original);
  expect(loadSourceWithRevision(`${untracked}?raw`, f.root)?.revision).toBeUndefined();
  f.git("update-ref", "-d", "refs/remotes/origin/main");
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root)?.revision).toBeUndefined();
});

test("a deployment SHA must resolve and match; invalid explicit values cannot fall back", () => {
  const f = fixture();
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root, f.commit)?.revision?.basis).toBe("build");
  for (const sha of ["main", "", "f".repeat(40), "--help"])
    expect(loadSourceWithRevision(`${f.file}?raw`, f.root, sha)?.revision).toBeUndefined();
  writeFileSync(f.file, original + "// local edit\n");
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root, f.commit)?.revision).toBeUndefined();
});

test("missing Git and invalid UTF-8 preserve displayable source without claiming a commit", () => {
  const f = fixture(false);
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root)).toEqual({ text: original, path });
  writeFileSync(f.file, Buffer.from([0x61, 0xff, 0x0a]));
  expect(loadSourceWithRevision(`${f.file}?raw`, f.root)?.revision).toBeUndefined();
});

test("an unavailable Git executable fails closed without disabling the source", () => {
  const f = fixture();
  // A fresh process avoids Bun's existing executable-resolution cache.
  const loader = new URL("../../experience-prototypes/scripts/source-revision.ts", import.meta.url).href;
  const result = execFileSync(process.execPath, ["-e", `
    import { loadSourceWithRevision } from ${JSON.stringify(loader)};
    console.log(JSON.stringify(loadSourceWithRevision(${JSON.stringify(f.file + "?raw")}, ${JSON.stringify(f.root)})));
  `], { env: { ...process.env, PATH: join(temporary, "no-executables") } });
  expect(JSON.parse(result.toString())).toEqual({ text: original, path });
});

test("the loader excludes outside paths, symlinks, dependencies and unrelated raw assets", () => {
  const f = fixture();
  const outside = join(temporary, "outside.ts");
  writeFileSync(outside, "// not a repository source\n");
  const symlink = join(f.root, "jev-experiments/alias.ts");
  symlinkSync(outside, symlink);
  const dependency = join(f.root, "jev-experiments/node_modules/example.ts");
  mkdirSync(join(f.root, "jev-experiments/node_modules"));
  writeFileSync(dependency, original);
  for (const id of [`${outside}?raw`, `${symlink}?raw`, `${dependency}?raw`, f.file, `${f.file}?url`, `${f.file}.md?raw`])
    expect(loadSourceWithRevision(id, f.root)).toBeNull();
});

test("runtime lookup cannot reuse a proof for changed bytes or another file", () => {
  const proof = { path: "jev-experiments/revision-fixture.ts", sha256: "a".repeat(64), commit: "b".repeat(40), basis: "repository" as const };
  registerSourceRevision(proof);
  expect(sourceRevision(proof.path, proof.sha256)).toEqual(proof);
  expect(sourceRevision(proof.path, "c".repeat(64))).toBeUndefined();
  expect(sourceRevision("jev-experiments/other.ts", proof.sha256)).toBeUndefined();
  expect(sourceRevision(proof.path, null)).toBeUndefined();
  const copy = sourceRevision(proof.path, proof.sha256)!;
  copy.commit = "d".repeat(40);
  expect(sourceRevision(proof.path, proof.sha256)?.commit).toBe(proof.commit);
  registerSourceRevision({ ...proof, commit: "main" });
  expect(sourceRevision(proof.path, proof.sha256)?.commit).toBe(proof.commit);
});

test("URL validation requires a full commit while local download names remain useful", () => {
  const path = "jev-experiments/source folder/café #1.ts";
  expect(pinnedSource(path, "e".repeat(40))).toBe(`https://github.com/nikhil-vytla/hatch/blob/${"e".repeat(40)}/jev-experiments/source%20folder/caf%C3%A9%20%231.ts`);
  for (const commit of [undefined, "main", "abcdef0", "e".repeat(39), "e".repeat(41)])
    expect(pinnedSource(path, commit)).toBeUndefined();
  expect(sourceFileName({ path, text: "local" })).toBe("café #1.ts");
  for (const invalid of ["/private/source.ts", "../source.ts", "jev-experiments/../source.ts", "a\u0000.ts", "C:\\source.ts"])
    expect(pinnedSource(invalid, "e".repeat(40))).toBeUndefined();
});
