// Learning end to end: a work session, the learner the daemon starts for the
// project's learning session, its proposal, the daemon's checks, a person's
// accept, and the memory reaching the next session's model. Real daemon,
// real hosts, real gateway; a scripted model at the network boundary.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Entry, type Event, StriveClient } from "@strive/protocol";
import { FakeAnthropic, type ScriptedReply, startDaemon, type TestDaemon } from "@strive/testkit";

const HOST = `bun ${resolve(import.meta.dir, "main.ts")}`;

setDefaultTimeout(60_000);

let daemon: TestDaemon | undefined;

let fake: FakeAnthropic | undefined;

let clients: StriveClient[] = [];

afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  daemon?.dispose();
  fake?.stop();
});

async function connect() {
  const { client } = await StriveClient.connect(daemon!.socket, { name: "person", version: "0" });
  clients.push(client);

  return client;
}

async function until<T>(what: string, get: () => Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;

  for (;;) {
    const v = await get();

    if (done(v)) return v;

    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 2000)}`);
    await Bun.sleep(50);
  }
}

const entries = async (c: StriveClient, id: string): Promise<Entry[]> =>
  (await c.request("session/read", { id })).entries;

const ended = (n: number) => (es: Entry[]) => es.filter((e) => e.event.type === "turnEnded").length >= n;

const MEMORY = "- Run the tests with `bun test src`: the root run also needs a display.\n";

type TextBlock = { type: "text"; text: string };

type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: TextBlock[] | string };

function isTextBlock(v: unknown): v is TextBlock {
  return typeof v === "object" && v !== null && "type" in v && v.type === "text" && "text" in v;
}

function isToolResult(v: unknown): v is ToolResultBlock {
  return (
    typeof v === "object" &&
    v !== null &&
    "type" in v &&
    v.type === "tool_result" &&
    "tool_use_id" in v &&
    "content" in v &&
    (typeof v.content === "string" || (Array.isArray(v.content) && v.content.every(isTextBlock)))
  );
}

/** The text of the tool result for call `callId` in a model request, if it carries one. */
function toolResult(req: any, callId: string): string | undefined {
  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue;

    for (const c of m.content) {
      if (!isToolResult(c) || c.tool_use_id !== callId) continue;

      return Array.isArray(c.content) ? c.content.map((t) => t.text).join("") : c.content;
    }
  }

  return undefined;
}

test("a learner's proposal, once a person accepts it, is what the next session's agent is told", async () => {
  // One script for every model call, in order; the learner's replies are
  // added once the work session's seqs are known.
  const script: ScriptedReply[] = [{ text: "Done: the tests pass." }];
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-learn-"));
  const c = await connect();

  // A work session: one prompt, one turn.
  const work = (await c.request("session/create", { cwd })).id;
  await c.request("session/prompt", { id: work, text: "run the tests" });
  const worked = await until("the work turn", () => entries(c, work), ended(1));
  const prompt = worked.find((e) => e.event.type === "userMessage");
  expect(prompt).toBeDefined();

  const proposal = {
    artifact: { kind: "memory" },
    content: MEMORY,
    summary: "Remember how to run the tests",
    rationale: "The session had to be told how to run the tests.",
    evidence: [{ session: work, seqs: [prompt?.seq ?? 0], note: "the user asks for the tests" }],
    prediction: "Sessions that run the tests won't first fail for want of a display.",
  };

  script.push(
    { toolCalls: [{ id: "l1", name: "list_sessions", input: {} }] },
    { toolCalls: [{ id: "l2", name: "read_session", input: { id: work } }] },
    { toolCalls: [{ id: "l3", name: "propose_change", input: proposal }] },
    { text: "Read the one session; proposed one memory bullet." },
  );

  // The learner: asked, it runs in the project's learning session.
  const learning = (await c.request("learning/open", { cwd })).id;
  await c.request("learning/run", { cwd });
  const learned = await until("the learner's turn", () => entries(c, learning), ended(1));
  const made = learned.find((e) => e.event.type === "proposalMade");
  expect(made?.event).toMatchObject({ type: "proposalMade", callId: "l3", proposal });

  // What read_session gave the learner is the work session's journal (the
  // proposal it then made also says "run the tests", so only that result counts).
  expect(toolResult(fake.requests.at(-1), "l2")).toContain(`#${prompt?.seq} user: run the tests`);

  // The daemon's checks, then a person.
  const listed = await until(
    "the checks",
    () => c.request("proposal/list", { cwd }),
    (r) => r.proposals[0]?.status !== "checking",
  );

  expect(listed.proposals.map((p) => [p.id, p.status])).toEqual([[made?.seq ?? -1, "ready"]]);
  expect(existsSync(join(cwd, ".strive/memory.md"))).toBe(false);
  await c.request("proposal/decide", { cwd, proposal: made?.seq ?? -1, decision: "accept" });
  expect(readFileSync(join(cwd, ".strive/memory.md"), "utf8")).toBe(MEMORY);

  // The next work session's model is told.
  script.push({ text: "ok" });
  const next = (await c.request("session/create", { cwd })).id;
  await c.request("session/prompt", { id: next, text: "again" });
  await until("the next work turn", () => entries(c, next), ended(1));
  expect(JSON.stringify(fake.requests.at(-1)?.system)).toContain("bun test src");

  // And a person can take it back.
  await c.request("proposal/rollback", { cwd, proposal: made?.seq ?? -1 });
  expect(existsSync(join(cwd, ".strive/memory.md"))).toBe(false);
  const events: Event[] = (await entries(c, learning)).map((e) => e.event);
  expect(events.map((e) => e.type)).toContain("proposalRolledBack");
});

/** A daemon, a project with one finished work session, and the project's learning session. */
async function project(script: ScriptedReply[]) {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-learn-"));
  const c = await connect();
  const work = (await c.request("session/create", { cwd })).id;
  await c.request("session/prompt", { id: work, text: "run the tests" });
  const worked = await until("the work turn", () => entries(c, work), ended(1));
  const seq = worked.find((e) => e.event.type === "userMessage")?.seq ?? 0;
  const learning = (await c.request("learning/open", { cwd })).id;

  return { c, cwd, work, seq, learning };
}

type Project = Awaited<ReturnType<typeof project>>;

/**
 * Learning run number `run`, in the host that ran the ones before it, which
 * proposes `content` as the whole memory: its proposalMade entry, once checked.
 */
async function learnOnce(p: Project, script: ScriptedReply[], run: number, content: string): Promise<Entry> {
  const callId = `p${run}`;

  const proposal = {
    artifact: { kind: "memory" },
    content,
    summary: "Remember how to run the tests",
    rationale: "The session had to be told how to run the tests.",
    evidence: [{ session: p.work, seqs: [p.seq], note: "the user asks for the tests" }],
    prediction: "Sessions that run the tests won't first fail for want of a display.",
  };

  script.push(
    { toolCalls: [{ id: callId, name: "propose_change", input: proposal }] },
    { text: "Proposed one memory change." },
  );
  await p.c.request("learning/run", { cwd: p.cwd });
  const learned = await until(`learning run ${run}`, () => entries(p.c, p.learning), ended(run));
  const made = learned.find((e) => e.event.type === "proposalMade" && e.event.callId === callId);

  if (made === undefined) throw new Error(`run ${run} made no proposal: ${JSON.stringify(learned.at(-1))}`);
  await until(
    `the checks of run ${run}`,
    () => status(p, made.seq),
    (s) => s !== "checking",
  );

  return made;
}

const status = async (p: Project, id: number) =>
  (await p.c.request("proposal/list", { cwd: p.cwd })).proposals.find((q) => q.id === id)?.status;

/** The text a proposal's recorded `before` names; undefined: none. */
async function before(p: Project, made: Entry): Promise<string | undefined> {
  if (made.event.type !== "proposalMade") throw new Error(`not a proposal: ${made.event.type}`);
  const digest = made.event.before;

  return digest === undefined ? undefined : (await p.c.request("blob/get", { digest })).text;
}

/** The memory each of the learning session's `contextLoaded` entries recorded, in order; undefined: none. */
async function memoriesShown(p: Project): Promise<(string | undefined)[]> {
  const loaded = (await entries(p.c, p.learning)).flatMap((e) =>
    e.event.type === "contextLoaded" ? [e.event.learned?.find((f) => f.path === ".strive/memory.md")] : [],
  );

  return Promise.all(
    loaded.map(async (f) => (f === undefined ? undefined : (await p.c.request("blob/get", { digest: f.digest })).text)),
  );
}

const SECOND = `${MEMORY}- Build with \`bun run build\` before the e2e tests: they drive the built app.\n`;

test("a second learning run in the same host proposes over the file the first run's accept wrote", async () => {
  const script: ScriptedReply[] = [{ text: "Done: the tests pass." }];
  const p = await project(script);
  const memory = join(p.cwd, ".strive/memory.md");

  const first = await learnOnce(p, script, 1, MEMORY);
  expect(await status(p, first.seq)).toBe("ready");
  await p.c.request("proposal/decide", { cwd: p.cwd, proposal: first.seq, decision: "accept" });
  expect(readFileSync(memory, "utf8")).toBe(MEMORY);

  // No restart between the runs: one host runs both.
  const second = await learnOnce(p, script, 2, SECOND);
  expect(JSON.stringify(fake?.requests.at(-1)?.system)).toContain("bun test src");
  expect(await before(p, second)).toBe(MEMORY);
  expect(await status(p, second.seq)).toBe("ready");
  await p.c.request("proposal/decide", { cwd: p.cwd, proposal: second.seq, decision: "accept" });
  expect(readFileSync(memory, "utf8")).toBe(SECOND);
  expect(await status(p, second.seq)).toBe("applied");

  // The journal says what each run was shown: no memory, then the first accept's.
  const shown = await memoriesShown(p);
  expect(shown.at(-1)).toBe(MEMORY);
  expect(shown.slice(0, -1)).toContain(undefined);
});

test("a learning run sees a hand edit made after the host's previous run", async () => {
  const script: ScriptedReply[] = [{ text: "Done: the tests pass." }];
  const p = await project(script);
  const memory = join(p.cwd, ".strive/memory.md");

  const first = await learnOnce(p, script, 1, MEMORY);
  await p.c.request("proposal/decide", { cwd: p.cwd, proposal: first.seq, decision: "reject" });

  const edited = "- Deploy with `make ship`, never by hand: it tags the release.\n";
  mkdirSync(join(p.cwd, ".strive"), { recursive: true });
  writeFileSync(memory, edited);

  const second = await learnOnce(p, script, 2, `${edited}${MEMORY}`);
  expect(JSON.stringify(fake?.requests.at(-1)?.system)).toContain("make ship");
  expect(await before(p, second)).toBe(edited);
  expect(await status(p, second.seq)).toBe("ready");
  await p.c.request("proposal/decide", { cwd: p.cwd, proposal: second.seq, decision: "accept" });
  expect(readFileSync(memory, "utf8")).toBe(`${edited}${MEMORY}`);
});
