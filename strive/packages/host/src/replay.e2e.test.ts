// The replay gate end to end (ADR-0018): a work session whose check went red
// to green, a proposal, the judge, then the task run again by the real host,
// in scratch copies, with and without the proposal. Real daemon, hosts,
// gateway and sandbox; a scripted model at the network boundary.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type Entry, type Event, type ProposalState, StriveClient } from "@strive/protocol";
import {
  type DaemonSettings,
  FakeAnthropic,
  type Json,
  type ModelRequest,
  type ScriptedReply,
  startDaemon,
  type TestDaemon,
} from "@strive/testkit";

const HOST = `bun ${resolve(import.meta.dir, "main.ts")}`;

const STRIVE = resolve(import.meta.dir, "../../../target/debug/strive");

setDefaultTimeout(120_000);

let daemon: TestDaemon | undefined;

let fake: FakeAnthropic | undefined;

let clients: StriveClient[] = [];

afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  daemon?.dispose();
  fake?.stop();
});

async function connect(name = "person") {
  const { client } = await StriveClient.connect(daemon!.socket, { name, version: "0" });
  clients.push(client);

  return client;
}

async function until<T>(what: string, get: () => Promise<T>, done: (v: T) => boolean, ms = 90_000): Promise<T> {
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

const ended = (es: Entry[]) => es.some((e) => e.event.type === "turnEnded");

/** What the memory proposal says; the scripted replay agent looks for it. */
const MARKER = "Create fixed.txt before running the check.";

const CRITERIA = ["supported", "generalizes", "novel", "safe", "checkable"];

function verdict(pass: boolean): ScriptedReply {
  const criteria = Object.fromEntries(CRITERIA.map((c) => [c, { pass, reason: `${c}: the judge's reason` }]));

  return {
    toolCalls: [
      {
        id: "v1",
        name: "record_verdict",
        input: { criteria, verdict: pass ? "pass" : "fail", summary: "The judge's summary." },
      },
    ],
  };
}

function isToolResult(block: Json): block is { [key: string]: Json } {
  return block !== null && typeof block === "object" && !Array.isArray(block) && block.type === "tool_result";
}

/** Whether the request answers a tool call: the agent's second step. */
function afterTool(request: ModelRequest): boolean {
  const last = request.messages.at(-1)?.content;

  return Array.isArray(last) && last.some(isToolResult);
}

type Setup = {
  settings?: DaemonSettings;
  /** The replayed agent's first reply, given its system prompt (which holds the memory, if any). */
  replay?: (system: string) => ScriptedReply;
  judgePasses?: boolean;
  /** Whether a work session ran the check red to green. */
  minable?: boolean;
  /** The task's check command, given the project's directory. */
  check?: (project: string) => string;
  /** The task's checkpoint has `.strive` as a symlink to this directory; the project doesn't, by the time of the proposal. */
  linkedStrive?: string;
};

type World = { c: StriveClient; project: string; learning: string; id: number; task?: string };

/**
 * A project with a check that fails until `fixed.txt` exists; a work session
 * where the agent ran it red to green (the task); another the proposal
 * cites; and a memory proposal recorded as the learner.
 */
async function world(s: Setup): Promise<World> {
  const work: ScriptedReply[] = [];

  fake = new FakeAnthropic((request) => {
    if (request.tool_choice?.name === "record_verdict") return verdict(s.judgePasses ?? true);

    const system = JSON.stringify(request.system ?? "");

    if (system.includes("strive-replay-")) {
      if (afterTool(request)) return { text: "Done." };

      return s.replay?.(system) ?? { text: "Nothing to do." };
    }

    return work.shift() ?? { text: "(the work script has no more replies)" };
  }).start();

  daemon = startDaemon(
    { STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST },
    { model: "claude-haiku-4-5", judgeModel: "claude-haiku-4-5", ...s.settings },
  );
  const project = realpathSync(mkdtempSync("/tmp/strv-replay-proj-"));
  writeFileSync(join(project, "check.sh"), "test -f fixed.txt\n");
  const c = await connect();

  let task: string | undefined;

  if (s.minable ?? true) {
    // As agents often do, the check names the project: replayed, it must
    // run in the scratch copy, where fixed.txt may be missing, not here.
    const check = s.check?.(project) ?? `cd ${project} && sh check.sh`;

    work.push(
      { toolCalls: [{ id: "b1", name: "bash", input: { command: check } }] },
      { toolCalls: [{ id: "w1", name: "write", input: { path: "fixed.txt", content: "fixed\n" } }] },
      { toolCalls: [{ id: "b2", name: "bash", input: { command: check } }] },
      { text: "The check passes now." },
    );
    if (s.linkedStrive) symlinkSync(s.linkedStrive, join(project, ".strive"));
    task = (await c.request("session/create", { cwd: project })).id;
    await c.request("session/approvals", { id: task, mode: "fullAuto" });
    await c.request("session/prompt", { id: task, text: "make the check pass" });
    await until("the task's turn", () => entries(c, task!), ended);
    if (s.linkedStrive) unlinkSync(join(project, ".strive"));
  }

  work.push({ text: "Hello." });
  const cited = (await c.request("session/create", { cwd: project })).id;
  const prompt = await c.request("session/prompt", { id: cited, text: "say hello" });
  await until("the cited session's turn", () => entries(c, cited), ended);

  // The learner, played by this test: the learning session's host.
  const learning = (await c.request("learning/open", { cwd: project })).id;
  const host = await connect("strive-host");
  await host.request("host/register", { id: learning });

  const proposal = {
    artifact: { kind: "memory" as const },
    content: `- ${MARKER}\n`,
    summary: "Create fixed.txt first",
    rationale: "The check needs fixed.txt.",
    evidence: [{ session: cited, seqs: [prompt.seq], note: "the user's request" }],
    prediction: "Sessions that run the check create fixed.txt first.",
  };

  const made = await host.request("host/record", { id: learning, event: { type: "proposalMade", proposal } });

  return { c, project, learning, id: made.seq, task };
}

async function settledProposal(w: World): Promise<ProposalState> {
  const listed = await until(
    "the checks",
    () => w.c.request("proposal/list", { cwd: w.project }),
    (r) => r.proposals.some((p) => p.id === w.id && p.status !== "checking"),
  );

  const p = listed.proposals.find((p) => p.id === w.id);

  if (!p) throw new Error(`no proposal #${w.id}`);

  return p;
}

const gate = (p: ProposalState, name: string) => p.gates.find((g) => g.gate === name);

async function events(w: World): Promise<Entry[]> {
  return entries(w.c, w.learning);
}

type Finished = Extract<Event, { type: "replayFinished" }>;

function finished(es: Entry[]): Finished | undefined {
  for (const e of es) if (e.event.type === "replayFinished") return e.event;

  return undefined;
}

test("a memory that leads the agent to fix the task passes replay, after the judge, and is shown in review", async () => {
  const w = await world({
    replay: (system) =>
      system.includes(MARKER)
        ? { toolCalls: [{ id: "r1", name: "write", input: { path: "fixed.txt", content: "x\n" } }] }
        : { text: "The check looks fine to me." },
  });

  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("pass");
  const detail = gate(p, "replay")?.detail ?? "";
  expect(detail.split("\n")[0]).toBe("with the change 3/3 passed, without 0/3; 1 task");
  expect(detail).toContain(`session ${w.task} #`);
  expect(detail).toContain(`\`cd ${w.project} && sh check.sh\`: with 3/3, without 0/3`);
  expect(p.status).toBe("ready");

  // The order: static, the judge, then the replay's hold, its end, its verdict.
  const es = await events(w);
  const seqOf = (pred: (e: Event) => boolean) => es.find((e) => pred(e.event))?.seq ?? -1;

  const order = [
    seqOf((e) => e.type === "gateFinished" && e.gate === "static"),
    seqOf((e) => e.type === "gateFinished" && e.gate === "judge"),
    seqOf((e) => e.type === "replayStarted"),
    seqOf((e) => e.type === "replayFinished"),
    seqOf((e) => e.type === "gateFinished" && e.gate === "replay"),
  ];

  expect(order.every((s) => s > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));

  // Each run is a replay session on record, kept out of work-session lists.
  const runs = finished(es)?.runs ?? [];
  expect(runs.map((r) => [r.withChange, r.passed])).toEqual([
    [false, false],
    [true, true],
    [false, false],
    [true, true],
    [false, false],
    [true, true],
  ]);
  const replays = (await w.c.request("session/list", { kind: "replay" })).sessions.map((s) => s.id);
  expect(replays.sort()).toEqual(runs.map((r) => r.session).sort());
  const work = (await w.c.request("session/list", {})).sessions.map((s) => s.id);
  expect(work.some((id) => replays.includes(id))).toBe(false);
  const run = await entries(w.c, runs[1]?.session ?? "");
  expect(run.find((e) => e.event.type === "userMessage")?.event).toEqual({
    type: "userMessage",
    text: "make the check pass",
  });
  expect(run.some((e) => e.event.type === "effectStarted" && e.event.callId === "replay-check")).toBe(true);

  // The runs' cost is charged to the learning session in place of the hold.
  expect(finished(es)?.costUsdMicros).toBeGreaterThan(0);

  // `strive review` shows the replay's detail.
  const review = Bun.spawnSync([STRIVE, "review", String(w.id)], { cwd: w.project, env: daemon!.env });
  const out = review.stdout.toString();
  expect(out).toContain("replay  passed   with the change 3/3 passed, without 0/3; 1 task");
  expect(out).toContain("sh check.sh`: with 3/3, without 0/3");
});

test("a memory that leads the agent away from the fix fails replay", async () => {
  const w = await world({
    settings: { replay: { runs: 1 } },
    replay: (system) =>
      system.includes(MARKER)
        ? { text: "The memory says there's nothing to fix." }
        : { toolCalls: [{ id: "r1", name: "write", input: { path: "fixed.txt", content: "x\n" } }] },
  });

  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("fail");
  expect(gate(p, "replay")?.detail.split("\n")[0]).toBe("failed: with the change 0/1 passed, without 1/1; 1 task");
  expect(p.status).toBe("failed");
});

test("with no task a machine can check, replay is skipped and says why", async () => {
  const w = await world({ minable: false });
  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("skipped");
  expect(gate(p, "replay")?.detail).toContain("no past task could be replayed");
  expect(p.status).toBe("ready");
  expect((await events(w)).some((e) => e.event.type === "replayStarted")).toBe(false);
});

test("a task whose check names a path outside the project isn't mined", async () => {
  const w = await world({ check: (project) => `cd ${project} && sh check.sh && test -d /tmp` });
  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("skipped");
  expect(gate(p, "replay")?.detail).toContain("no past task could be replayed");
  expect(gate(p, "replay")?.detail).toContain("names /tmp, outside the project");
  expect((await events(w)).some((e) => e.event.type === "replayStarted")).toBe(false);
});

test("a judge's fail means no replay is run", async () => {
  const w = await world({ judgePasses: false });
  const p = await settledProposal(w);

  expect(gate(p, "judge")?.verdict).toBe("fail");
  expect(gate(p, "replay")).toMatchObject({ verdict: "skipped", detail: "not run: the judge failed it" });
  expect((await w.c.request("session/list", { kind: "replay" })).sessions).toEqual([]);
});

test("a cap the learning session's budget can't hold is refused before anything runs", async () => {
  const w = await world({ settings: { replay: { budgetUsd: 50 } } });
  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("skipped");
  expect(gate(p, "replay")?.detail).toBe(
    'not run: the replay may spend up to $50.0000 ("replay": {"budgetUsd"} in ~/.strive/settings.json), but only $5.0000 of the learning session\'s $5.0000 budget is left',
  );
  expect((await events(w)).some((e) => e.event.type === "replayStarted")).toBe(false);
  expect((await w.c.request("session/list", { kind: "replay" })).sessions).toEqual([]);
});

test("a cap too small for the agent's calls stops the replay at the first refusal", async () => {
  const w = await world({ settings: { replay: { budgetUsd: 0.01 } } });
  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("skipped");
  expect(gate(p, "replay")?.detail).toContain("the replay's cap of $0.0100 ran out after 1 runs");
  const done = finished(await events(w));
  expect(done?.runs.length).toBe(1);
  expect(done?.costUsdMicros).toBe(0);
});

test("a replayed agent can't reach the project: its writes there are refused and its commands can't", async () => {
  let project = "";

  const w = await world({
    settings: { replay: { runs: 1 } },
    replay: (): ScriptedReply => ({
      toolCalls: [
        { id: "e1", name: "write", input: { path: join(project, "escaped-write.txt"), content: "x" } },
        { id: "e2", name: "bash", input: { command: `echo x > ${join(project, "escaped-bash.txt")}` } },
      ],
    }),
  });

  project = w.project;
  const p = await settledProposal(w);

  expect(existsSync(join(w.project, "escaped-write.txt"))).toBe(false);
  expect(existsSync(join(w.project, "escaped-bash.txt"))).toBe(false);
  expect(readFileSync(join(w.project, "check.sh"), "utf8")).toBe("test -f fixed.txt\n");
  // Neither side passed, so replay couldn't tell.
  expect(gate(p, "replay")?.detail.startsWith("inconclusive: every run failed")).toBe(true);

  const run = await entries(w.c, finished(await events(w))?.runs[0]?.session ?? "");

  const outcome = (callId: string) => {
    const started = run.find((e) => e.event.type === "effectStarted" && e.event.callId === callId)?.event;
    const effect = started?.type === "effectStarted" ? started.effect : -1;

    for (const e of run) if (e.event.type === "effectFinished" && e.event.effect === effect) return e.event.outcome;

    return undefined;
  };

  expect(outcome("e1")).toMatchObject({ kind: "refused" });
  const bash = outcome("e2");
  expect(bash?.kind === "done" && bash.exitCode !== undefined && bash.exitCode !== 0).toBe(true);
});

test("a task whose checkpoint has .strive linked outside the copy is set aside, and nothing there is touched", async () => {
  const outside = realpathSync(mkdtempSync("/tmp/strv-replay-outside-"));
  mkdirSync(join(outside, "skills/keep"), { recursive: true });
  writeFileSync(join(outside, "memory.md"), "outside\n");
  writeFileSync(join(outside, "skills/keep/SKILL.md"), "keep\n");

  const w = await world({ linkedStrive: outside, settings: { replay: { runs: 1 } } });
  const p = await settledProposal(w);

  expect(readFileSync(join(outside, "memory.md"), "utf8")).toBe("outside\n");
  expect(readFileSync(join(outside, "skills/keep/SKILL.md"), "utf8")).toBe("keep\n");
  expect(readdirSync(outside).sort()).toEqual(["memory.md", "skills"]);
  expect(gate(p, "replay")?.verdict).toBe("skipped");
  expect(gate(p, "replay")?.detail).toContain(".strive is a symlink");
  expect(gate(p, "replay")?.detail).toContain(`session ${w.task} #`);
});

// `gated` (ADR-0020): the daemon accepts only a proposal whose every check passed.

const GATED = { learning: { mode: "gated" } };

const FIX: ScriptedReply = { toolCalls: [{ id: "r1", name: "write", input: { path: "fixed.txt", content: "x\n" } }] };

/** The replayed agent fixes the task only when the memory tells it how. */
const helped = (system: string): ScriptedReply =>
  system.includes(MARKER) ? FIX : { text: "The check looks fine to me." };

const decisions = async (w: World) =>
  (await events(w)).flatMap((e) => (e.event.type === "proposalDecided" ? [e.event] : []));

const review = (w: World, ...args: string[]) =>
  Bun.spawnSync([STRIVE, "review", ...args], { cwd: w.project, env: daemon!.env }).stdout.toString();

test("under gated, a proposal whose static, judge and replay checks all passed is accepted by the gate, and a person can roll it back", async () => {
  const w = await world({ settings: { ...GATED, replay: { runs: 1 } }, replay: helped });
  const p = await settledProposal(w);
  const memory = join(w.project, ".strive/memory.md");

  expect(p.gates.map((g) => g.verdict)).toEqual(["pass", "pass", "pass"]);
  expect(p.status).toBe("applied");
  expect(p.automatic).toBe("gate");
  expect(readFileSync(memory, "utf8")).toBe(`- ${MARKER}\n`);
  expect(await decisions(w)).toEqual([
    { type: "proposalDecided", proposal: w.id, decision: "accept", by: "gate", automatic: "gate" },
  ]);

  expect(review(w)).toContain(`#${w.id}`);
  expect(
    review(w)
      .split("\n")
      .find((l) => l.startsWith(`#${w.id} `)),
  ).toEndWith("[accepted automatically]");
  expect(review(w, String(w.id))).toContain("decided     accepted automatically: every check passed");

  const back = Bun.spawnSync([STRIVE, "review", String(w.id), "rollback"], { cwd: w.project, env: daemon!.env });
  expect(back.stdout.toString()).toContain(`rolled back #${w.id}: removed .strive/memory.md`);
  expect(existsSync(memory)).toBe(false);
  const after = (await w.c.request("proposal/list", { cwd: w.project })).proposals.find((q) => q.id === w.id);
  expect(after?.status).toBe("rolledBack");
});

test("under gated, a change that made no difference in replay is inconclusive and left for a person", async () => {
  // The agent fixes the task with or without the memory.
  const w = await world({ settings: { ...GATED, replay: { runs: 1 } }, replay: () => FIX });
  const p = await settledProposal(w);

  expect(gate(p, "replay")?.verdict).toBe("skipped");
  expect(gate(p, "replay")?.detail.split("\n")[0]).toBe(
    "inconclusive: the change made no difference, with the change 1/1 passed, without 1/1; 1 task",
  );
  expect(p.status).toBe("ready");
  expect(await decisions(w)).toEqual([]);
  expect(existsSync(join(w.project, ".strive/memory.md"))).toBe(false);
});

test("under gated, a proposal the judge skipped is left for a person, even when replay passed", async () => {
  // The judge runs only on Anthropic models, so it's skipped; replay runs on Haiku.
  const w = await world({
    settings: { ...GATED, judgeModel: "gpt-4.1-mini", replay: { runs: 1, model: "claude-haiku-4-5" } },
    replay: helped,
  });

  const p = await settledProposal(w);

  expect(p.gates.map((g) => g.verdict)).toEqual(["pass", "skipped", "pass"]);
  expect(p.status).toBe("ready");
  expect(p.automatic).toBeUndefined();
  expect(await decisions(w)).toEqual([]);
  expect(existsSync(join(w.project, ".strive/memory.md"))).toBe(false);
});

test("under gated, a proposal whose replay was skipped is left for a person", async () => {
  // Replay off; the task session is still there for the judge to hold out.
  const w = await world({ settings: { ...GATED, replay: { budgetUsd: 0 } } });
  const p = await settledProposal(w);

  expect(p.gates.map((g) => g.verdict)).toEqual(["pass", "pass", "skipped"]);
  expect(gate(p, "replay")?.detail).toContain("replay is off");
  expect(p.status).toBe("ready");
  expect(p.automatic).toBeUndefined();
  expect(await decisions(w)).toEqual([]);
  expect(existsSync(join(w.project, ".strive/memory.md"))).toBe(false);
});

test("under gated, a proposal whose replay failed is left for a person", async () => {
  const replayFails = await world({
    settings: { ...GATED, replay: { runs: 1 } },
    replay: (system) => (system.includes(MARKER) ? { text: "Nothing to fix." } : FIX),
  });

  const p = await settledProposal(replayFails);

  expect(p.gates.map((g) => g.verdict)).toEqual(["pass", "pass", "fail"]);
  expect(p.status).toBe("failed");
  expect(await decisions(replayFails)).toEqual([]);
  expect(existsSync(join(replayFails.project, ".strive/memory.md"))).toBe(false);
});

test("under gated, a proposal the judge failed is left for a person", async () => {
  const w = await world({ settings: GATED, judgePasses: false });
  const p = await settledProposal(w);

  expect(p.gates.map((g) => g.verdict)).toEqual(["pass", "fail", "skipped"]);
  expect(p.status).toBe("failed");
  expect(await decisions(w)).toEqual([]);
});
