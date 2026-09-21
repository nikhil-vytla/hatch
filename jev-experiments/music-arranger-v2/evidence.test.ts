import { expect, test } from "bun:test";
import { readRecord } from "../experience-prototypes/scripts/records";
import { validate } from "../experience-prototypes/server/gateway";
import { cases } from "./cases";
import { validateScore, makeCandidates, starterScore, stepPitch, inKey, TONICS, MODES } from "./engine";
const record = readRecord(new URL("./music-v2.jsonl", import.meta.url));
const sort = (events: any[]) => [...events].sort((a,b) => a.id.localeCompare(b.id));
test("published recordings cover all frozen briefs with complete inputs and chosen-event provenance", () => {
  expect(record.manifest.status).toBe("complete"); expect(record.result.rows.length).toBe(cases.length);
  for (const spec of cases) {
    const row = record.result.rows.find((r: any) => r.id === spec.id);
    expect(row.status).toBe("complete"); expect(row.brief).toBe(spec.brief); expect(validateScore(row.score)).toEqual([]);
    expect(validateScore(row.baselines.rule)).toEqual([]); expect(validateScore(row.baselines.random)).toEqual([]);
    const successful = row.calls.filter((c: any) => c.result); expect(successful.length).toBe(5);
    for (const call of successful) {
      validate(call.request); expect(call.result.model).toBe("typesafe-ai/jev");
      expect(call.result.attempts.at(-1).status).toBe(200);
      if (call.stage === "global") continue;
      const index = Number(call.stage.split("-")[1]) - 1;
      const selected = call.request.state.candidates.find((c: any) => c.id === call.result.answers.phrase.value);
      expect(selected).toBeDefined();
      const events = [...selected.events, ...(call.request.state.sharedAccompaniment ?? [])];
      expect(sort(events)).toEqual(sort(row.score.events.filter((e: any) => e.phrase === index)));
      expect(sort(call.request.state.previousPhraseEvents)).toEqual(sort(row.score.events.filter((e: any) => e.phrase === index - 1)));
      expect(row.score.phrases[index].source).toBe("jev");
    }
  }
});
test("published counts describe the retained choices, including contour failures", () => {
  const extra = record.result.rows.filter((r: any) => r.requestedContour);
  const matches = extra.reduce((n: number,r: any)=>n+r.score.phrases.filter((p:any)=>p.contour===r.requestedContour).length,0);
  expect(matches).toBe(record.result.metrics.explicit_contour_matches);
  expect(extra.length * 4).toBe(record.result.metrics.explicit_contour_phrases);
  expect(record.result.human_preference).toBeNull();
});
test("pitch edits remain in key at the register edges", () => {
  for (const tonic of Object.keys(TONICS)) for (const mode of Object.keys(MODES) as (keyof typeof MODES)[]) {
    const score = starterScore("bounds", {tonic,mode,palette:"acoustic",progression:"home",bpm:108});
    for (const initial of [makeCandidates(score,0)[0].events.find(e=>e.track==="melody")!.midi!]) for (const direction of [-1,1]) {
      let pitch=initial; for (let i=0;i<30;i++) { pitch=stepPitch(score.settings,pitch,direction); expect(inKey(score.settings,pitch)).toBe(true); expect(pitch).toBeGreaterThanOrEqual(55); expect(pitch).toBeLessThanOrEqual(88); }
    }
  }
});
test("matched option probes change presentation while preserving musical candidate content", () => {
  const probes = readRecord(new URL("./option-order.jsonl", import.meta.url));
  expect(probes.manifest.status).toBe("complete"); expect(probes.result.rows).toHaveLength(8);
  const musical = (row: any) => row.request.state.candidates.map(({ id, ...c }: any) => c).sort((a: any,b: any)=>a.contour.localeCompare(b.contour));
  const context = (row: any) => { const { candidates, ...state } = row.request.state; return state; };
  for (const row of probes.result.rows) {
    validate(row.request); expect(row.result).toBeDefined();
    expect(musical(row)).toEqual(musical(probes.result.rows[0]));
    expect(context(row)).toEqual(context(probes.result.rows[0]));
    expect(Object.values(row.request.questions.phrase.criteria).sort()).toEqual(Object.values(probes.result.rows[0].request.questions.phrase.criteria).sort());
  }
});
