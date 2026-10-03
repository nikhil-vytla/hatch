import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Entry } from "@strive/protocol";
import { FakeAnthropic, type ScriptedReply, startDaemon, type TestDaemon } from "@strive/testkit";

// `strive run`: one task, headless, with the real host and a scripted model.

const HOST = `bun ${resolve(import.meta.dir, "main.ts")}`;

const STRIVE = resolve(import.meta.dir, "../../../target/debug/strive");

setDefaultTimeout(30_000);

let daemon: TestDaemon | undefined;

let fake: FakeAnthropic | undefined;

afterEach(() => {
  daemon?.dispose();
  fake?.stop();
});

type Ran = { exitCode: number; entries: Entry[]; stdout: string; stderr: string; cwd: string };

/** Runs `strive run` in a fresh directory (async: the fake model serves from this process). */
async function run(script: ScriptedReply[], args: string[], stdin?: string): Promise<Ran> {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-run-"));

  const proc = Bun.spawn([STRIVE, "run", ...args], {
    cwd,
    env: daemon.env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const entries = args.includes("--json")
    ? stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

  return { exitCode, entries, stdout, stderr, cwd };
}

test("a full-auto run does the task, prints each entry as JSON, and exits 0", async () => {
  const r = await run(
    [{ toolCalls: [{ id: "t1", name: "bash", input: { command: "echo hi > hello.txt" } }] }, { text: "Made it." }],
    ["--json", "--approvals", "full-auto", "make hello.txt"],
  );

  expect(r.exitCode).toBe(0);
  expect(readFileSync(join(r.cwd, "hello.txt"), "utf8")).toBe("hi\n");
  const types = r.entries.map((e) => e.event.type);
  expect(types).toContain("userMessage");
  expect(types.at(-1)).toBe("turnEnded");
  const seqs = r.entries.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length); // each entry once
});

test("nothing waits for an approval no one is there to give", async () => {
  const started = Date.now();

  const r = await run(
    [{ toolCalls: [{ id: "t1", name: "bash", input: { command: "touch made.txt" } }] }, { text: "I couldn't." }],
    ["--json", "make a file"],
  );

  expect(Date.now() - started).toBeLessThan(15_000);
  expect(r.exitCode).toBe(0);
  const finished = r.entries.find((e) => e.event.type === "effectFinished");
  expect(JSON.stringify(finished)).toContain("no client is attached");
});

test("a turn that fails exits 1 and says why", async () => {
  const r = await run([{ status: 400, error: "prompt is too long" }], ["do it"]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("prompt is too long");
});

test("the task can come on stdin", async () => {
  const r = await run([{ text: "Hello." }], ["--json"], "say hello\n");
  expect(r.exitCode).toBe(0);
  expect(r.entries.find((e) => e.event.type === "userMessage")?.event).toEqual({
    type: "userMessage",
    text: "say hello",
    requestId: "strive-run",
  });
});

// A model's reply is printed as text, never as commands to the terminal: an
// escape sequence in it could erase lines or fake output in the person's
// terminal or a CI log.
test("control characters in the model's reply are printed written out", async () => {
  const r = await run([{ text: "Done.\u001b[2K\u001b[1A\rAll tests passed" }], ["say done"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).not.toContain("\u001b");
  expect(r.stdout).not.toContain("\r");
  expect(r.stdout).toContain("Done.\\u{1b}[2K\\u{1b}[1A\\u{d}All tests passed");
});
