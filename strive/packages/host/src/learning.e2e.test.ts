// Learning end to end: a work session, the learner the daemon starts for the
// project's learning session, its proposal, the daemon's checks, a person's
// accept, and the memory reaching the next session's model. Real daemon,
// real hosts, real gateway; a scripted model at the network boundary.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
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

  // What the learner saw of the work session is what it was told.
  const read = JSON.stringify(fake.requests.at(-1)?.messages);
  expect(read).toContain("run the tests");

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

test("a learner's watch, once accepted, is checked by the daemon against the next session's commands", async () => {
  const script: ScriptedReply[] = [{ text: "Done." }];
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-watch-"));
  const c = await connect();
  const work = (await c.request("session/create", { cwd })).id;
  await c.request("session/prompt", { id: work, text: "run the tests" });
  await until("the work turn", () => entries(c, work), ended(1));

  const watch = {
    when: { command: "bun test" },
    expect: { kind: "never", step: { command: "bun test", output: "no display" } },
  };

  const proposal = {
    artifact: { kind: "memory" },
    content: MEMORY,
    summary: "Remember how to run the tests",
    rationale: "The root test run needs a display.",
    evidence: [{ session: work, seqs: [1], note: "the session began here" }],
    prediction: "Sessions that run bun test won't fail for want of a display.",
    watch,
  };

  script.push(
    { toolCalls: [{ id: "l1", name: "propose_change", input: proposal }] },
    { text: "Proposed one memory bullet, with a watch." },
  );

  const learning = (await c.request("learning/open", { cwd })).id;
  await c.request("learning/run", { cwd });
  const learned = await until("the learner's turn", () => entries(c, learning), ended(1));
  const made = learned.find((e) => e.event.type === "proposalMade");
  expect(made?.event).toMatchObject({ type: "proposalMade", proposal: { watch } });

  // The tool the model was offered takes a watch, and its rules say how to write one.
  expect(JSON.stringify(fake.requests.at(-1)?.tools)).toContain('"watch"');
  expect(JSON.stringify(fake.requests.at(-1)?.system)).toContain("watch: the prediction as a check the daemon runs");

  const id = made?.seq ?? -1;
  await until(
    "the checks",
    () => c.request("proposal/list", { cwd }),
    (r) => r.proposals[0]?.status === "ready",
  );
  await c.request("proposal/decide", { cwd, proposal: id, decision: "accept" });

  // The next session's agent runs the tests, and they fail for want of a display.
  script.push(
    { toolCalls: [{ id: "b1", name: "bash", input: { command: "echo 'error: no display' >&2; exit 1; : bun test" } }] },
    { text: "The tests need a display." },
  );
  const next = (await c.request("session/create", { cwd })).id;
  await c.request("session/approvals", { id: next, mode: "fullAuto" });
  await c.request("session/prompt", { id: next, text: "run the tests again" });
  await until("the next work turn", () => entries(c, next), ended(1));

  const checked = await until(
    "the prediction's check",
    () => entries(c, learning),
    (es) => es.some((e) => e.event.type === "predictionChecked"),
  );

  expect(checked.find((e) => e.event.type === "predictionChecked")?.event).toMatchObject({
    type: "predictionChecked",
    proposal: id,
    session: next,
    outcome: "contradicted",
  });

  const listed = await c.request("proposal/list", { cwd });
  expect(listed.proposals[0]?.prediction).toMatchObject({ confirmed: 0, contradicted: 1, notHolding: false });
});
