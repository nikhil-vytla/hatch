/**
 * Every strip number must match the data it claims to come from. Each test recomputes a page's
 * numbers from the raw file by a separate route (plain arithmetic over the records, not the
 * headline functions) and compares. They read the files `bun run build` produces, as CI does.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { counts, simulate } from "../../../../live-worlds/rumour/engine";
import { SCAM } from "../../../../live-worlds/rumour/compare";
import { allProfiles, toDist, type Dist } from "../../../../live-worlds/rumour/profiles";
import { createTown } from "../../../../live-worlds/rumour/town";
import { greedy, initial, step } from "../../../../local-models-and-games/arcade/engine";
import { headlinesFrom, loadHeadlineInputs, RUMOUR_TOWN } from "./build";
import { HANDOFF_THRESHOLD, SURE_NO, SURE_YES, type Headline } from "./headlines";

const lab = join(import.meta.dir, "../../../..");

const app = join(lab, "experience-prototypes");

const built = join(import.meta.dir, "headlines.json");

const ready = existsSync(built) && existsSync(join(app, "public/fool/fool.json"));

// CI builds before it tests; a local run without a build is told so rather than passing silently.
if (!ready && process.env.CI) throw new Error("headlines.json is missing: run `bun run build` in experience-prototypes first.");

const inputs = ready ? loadHeadlineInputs(lab, app) : null;

const computed = inputs ? headlinesFrom(inputs) : null;

const scene = (id: string): Headline => {
  const h = computed?.scenes.find((s) => s.id === id);

  if (!h) throw new Error(`No headline for ${id}`);

  return h;
};

const pct0 = (x: number) => `${Math.round(x * 100)}%`;

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

const argmax = (p: number[]) => p.reduce((b, x, i) => (x > p[b] ? i : b), 0);

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe.skipIf(!ready)("headline strips match their data", () => {
  test("the bundled headlines.json is what the data produces now", () => {
    expect(json(built)).toEqual(JSON.parse(JSON.stringify(computed)));
  });

  test("decoy: the apartment swing and the 8 scenarios, read from the raw recording", () => {
    const h = scene("decoy");
    const raw = json(join(app, "public/decoy/decoy.json"));

    // A's share of the A/B pair, averaged over both listing orders, as the study scores it.
    const share = (set: string) => {
      const rows = raw.recorded.filter((r: { item: string; set: string }) => r.item === "apartment" && r.set === set);
      const shares = rows.map((r: { probabilities: Record<string, number> }) => r.probabilities.a / (r.probabilities.a + r.probabilities.b));

      return shares.reduce((a: number, b: number) => a + b, 0) / shares.length;
    };

    expect(h.stats[0].value).toBe(`${pct0(share("decoy-b"))} → ${pct0(share("decoy-a"))}`);

    const items: string[] = [...new Set<string>(raw.recorded.map((r: { item: string }) => r.item))];

    expect(h.stats[1].value).toBe(`${items.length} of ${items.length}`);
  });

  test("answer key: Jev's teacher-key score, counted directly", () => {
    const questions = inputs?.questions ?? [];
    const right = questions.filter((q) => q.predictions.jev && argmax(q.predictions.jev) === argmax(q.target)).length;

    expect(scene("answer-key").stats[0].value.startsWith(pct1(right / questions.length))).toBe(true);
  });

  test("handoff: share handled and right at the threshold, counted directly", () => {
    const rows = (inputs?.banking ?? []).filter((r) => !r.error && r.probabilities);
    const conf = (p: Record<string, number>) => Math.max(...Object.values(p)) / Object.values(p).reduce((a, b) => a + b, 0);
    const handled = rows.filter((r) => r.probabilities && conf(r.probabilities) >= HANDOFF_THRESHOLD);
    const wrong = handled.filter((r) => r.prediction !== r.target).length;
    const h = scene("handoff");

    expect(h.stats[0].value).toBe(pct0(handled.length / rows.length));
    expect(h.stats[1].value).toBe(pct1(1 - wrong / handled.length));
    expect(h.stats[2].value).toBe(String(wrong));
  });

  test("decisions in an interface: Jev's held-out right and wrong cards, read from the arena card", () => {
    const card = json(join(app, "public/arena/index.json")).cards.find((c: { id: string }) => c.id === "one-box");
    const held = card.slices.workflow["held-out"];
    const jev = held["jev@cancel"];
    const h = scene("decisions-in-ui");

    expect(h.stats[0].value).toBe(pct0(jev.right.value));
    expect(h.stats[1].value.startsWith(jev.wrong.value.toFixed(2))).toBe(true);

    // "Fewest wrong cards" is only claimed when no contestant shows fewer.
    const wrongs: number[] = Object.values<{ wrong: { value: number } }>(held).map((r) => r.wrong.value);
    const fewest = wrongs.every((w) => w >= jev.wrong.value);

    expect(h.verdict.includes("the fewest of any contestant")).toBe(fewest);
    expect(h.stats[2].value).toBe(scene("handoff").stats[0].value);
  });

  test("open decisions: the best open model and Jev, read from the published file", () => {
    const d = json(join(app, "public/open-decisions/open-decisions.json"));
    const open = d.typed.filter((t: { id: string }) => d.models.some((m: { id: string }) => m.id === t.id));
    const best = Math.max(...open.map((t: { agreement: number }) => t.agreement));
    const jev = d.typed.find((t: { id: string }) => t.id === "jev").agreement;

    expect(scene("open-decisions").stats[0].value.startsWith(`${pct1(best)} vs ${pct1(jev)}`)).toBe(true);
  });

  test("reef: the held-out table's survival rates", () => {
    const table = json(join(lab, "live-worlds/ocean/heldout.json")).table;
    const at = (who: string, ev: string) => table.find((r: { decider: string }) => r.decider === who).byEvent[ev].survival;
    const h = scene("ocean");

    expect(h.stats[0].value).toBe(`${pct0(at("Evolved policy", "heatwave"))} vs ${pct0(at("Nobody decides", "heatwave"))}`);
    expect(h.stats[1].value).toBe(`${pct0(at("Evolved policy", "net"))} vs ${pct0(at("Nobody decides", "net"))}`);
    expect(h.verdict).toContain(`${json(join(lab, "live-worlds/ocean/policy.json")).weights.length}-weight`);
  });

  test("screen sentry: hard traps and the fresh test set, counted from compare.json", () => {
    const c = json(join(lab, "live-worlds/sentry/compare.json")).sets;
    const n = (s: string) => Number(s.split("/")[0]);
    const d = (s: string) => Number(s.split("/")[1]);
    const h = scene("screen-sentry");

    expect(h.stats[0].value).toBe(`${n(c["scene: hard traps"].free.injectionsCaught)} vs ${n(c["scene: hard traps"].jev.injectionsCaught)} of ${d(c["scene: hard traps"].free.injectionsCaught)}`);
    expect(h.stats[1].value).toBe(`${n(c.wild2.free.injectionsCaught)} of ${d(c.wild2.free.injectionsCaught)}`);
    expect(h.stats[2].value).toBe(`${n(c.wild2.free.harmlessFlagged)} of ${d(c.wild2.free.harmlessFlagged)}`);
  });

  test("win over: the free model's test-set accuracy", () => {
    const r = json(join(lab, "live-worlds/free-model/results.json"));

    expect(scene("win-over").stats[0].value).toBe(`${pct0(r.winOver.results.student.intent.accuracy)} vs ${pct0(r.winOver.results.mobilebert.intent.accuracy)}`);
  });

  test("rumour mill: the scam's spread, simulated straight from the recording", () => {
    const rows = readFileSync(join(lab, "live-worlds/rumour/jev-scam.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const answers = new Map<string, Dist>();

    for (const row of rows.filter((r) => r.kind === "rumour"))
      for (const p of allProfiles("rumour")) {
        const d = toDist(row.answers[p.key]?.probabilities);

        if (d) answers.set(p.key, d);
      }

    if (!SCAM) throw new Error("No scam preset");

    const town = createTown(RUMOUR_TOWN.seed, RUMOUR_TOWN.residents);
    const c = counts(simulate(town, "rumour", SCAM.text, SCAM.place, SCAM.block, answers, 1, 60));
    const h = scene("rumour-mill");

    expect(h.stats[0].value).toBe(c.heard.toLocaleString("en-US"));
    expect(h.stats[1].value).toBe(c.believe.toLocaleString("en-US"));
  });

  test("eyes: games survived from pixels and from facts, replayed from the raw recordings", () => {
    const rows = readFileSync(join(lab, "live-worlds/eyes/recordings/qwen3-vl-4b.v1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const seeds = [...new Set(rows.map((r) => r.seed))];
    // A game from pixels survives only if its last recorded move doesn't end it.
    let survived = 0;

    for (const seed of seeds) {
      let s = initial("snake", seed);

      for (const r of rows.filter((x) => x.seed === seed).sort((x, y) => x.tick - y.tick)) {
        s = r.move === "reverse" ? { ...s, status: "lost" as const } : step(s, r.move);

        if (s.status !== "playing") break;
      }

      if (s.status !== "lost") survived++;
    }

    let factsSurvived = 0;

    for (const seed of seeds) {
      let s = initial("snake", seed);

      while (s.status === "playing") s = step(s, greedy(s));

      if (s.status !== "lost") factsSurvived++;
    }

    const perception = readFileSync(join(lab, "live-worlds/eyes/recordings/qwen3-vl-8b.perception.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const right = perception.filter((r) => (r.p_yes >= 0.5) === r.truth).length;
    const h = scene("eyes");

    expect(h.stats[0].value).toBe(`${survived} of ${seeds.length}`);
    expect(h.stats[1].value).toBe(`${factsSurvived} of ${seeds.length}`);
    expect(h.stats[2].value).toBe(pct0(right / perception.length));
  });

  test("collection cards: headline lines where there's a strip, record counts elsewhere", () => {
    const card = (id: string) => computed?.cards.find((c) => c.id === id);
    const record = (name: string) => json(join(app, `public/data/${name}.json`)).result;

    expect(card("decoy")?.line).toBe(scene("decoy").line);
    expect(card("visual-search")?.line).toBe(`${record("visual-search").availability.completed.toLocaleString("en-US")} recorded answers`);
    expect(card("rewardbench2")?.line).toBe(`${record("rewardbench2").rows.filter((r: { error?: unknown }) => !r.error).length.toLocaleString("en-US")} recorded answers`);

    const questions = record("local-models").cases.reduce((s: number, c: { questions: unknown[] }) => s + c.questions.length, 0);

    expect(card("local-models")?.line).toBe(`${questions.toLocaleString("en-US")} recorded questions`);
  });

  test("home: the doubt flips, rewording and calibration, counted from the records", () => {
    const fool = json(join(app, "public/fool/fool.json"));

    const flipped = (sentence: string) =>
      fool.puzzles.filter((p: { id: string; truth: boolean }) => {
        const r = fool.recorded[p.id][sentence];
        const right = p.truth ? r.pYes : 1 - r.pYes;

        return right < 0.5 && !(r.pChanges !== null && r.pChanges >= 0.5);
      }).length;

    const prose = json(join(lab, "packages/arena/prose/results.json"))["claim-truth"];
    const forms = prose.rollup.find((r: { family: string }) => r.family === "sentence-form");
    const bin = prose.calibration.bins.find((b: { from: number }) => b.from === 0.9);
    const f = computed?.home?.findings ?? [];

    expect(f[0].n).toBe(`${flipped(SURE_NO)} of ${fool.puzzles.length}`);
    expect(f[0].body).toContain(flipped(SURE_YES) === 0 ? "flipped none" : `flipped ${flipped(SURE_YES)}`);
    expect(f[1].n).toBe(`${Math.round(forms.flipRate * forms.cells)} of ${forms.cells}`);
    expect(f[3].n).toBe(`${Math.round(bin.n * bin.accuracy).toLocaleString("en-US")} / ${bin.n.toLocaleString("en-US")}`);
  });
});
