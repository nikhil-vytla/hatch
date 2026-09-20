import { describe, expect, test } from "bun:test";
import {
  CATALOG,
  INITIAL_OUTFIT,
  applyPatch,
  currentTicket,
  demoOutfits,
  editQuestions,
  editState,
  fullPrompt,
  interpretEdit,
  outfitErrors,
} from "./engine";
import { readRecord } from "../experience-prototypes/scripts/records";
const response = (values: any) => ({
  answers: Object.fromEntries(
    Object.keys(editQuestions()).map((k) => [
      k,
      { value: values[k] ?? (k === "action" ? "apply" : "keep") },
    ]),
  ),
});
describe("canonical wardrobe", () => {
  test("cumulative changes keep jacket and referent is glasses", () => {
    const states = demoOutfits();
    expect(states.map((s) => s.after.jacket)).toEqual([
      "denim",
      "denim",
      "denim",
      "denim",
    ]);
    expect(states[2].after.glassesColor).toBe("pink");
    expect(states[3].after.glassesSize).toBe("large");
    expect(states[3].after.fit).toBe("regular");
    expect(states[3].after.focus).toBe("glasses");
  });
  test("redundant unchanged values never steal focus", () => {
    const dressed = demoOutfits()[0].after;
    expect(
      applyPatch(dressed, { jacket: "denim", glasses: "wayfarer" }).focus,
    ).toBe("glasses");
  });
  test("catalog colors cannot be invented; patch is atomic", () => {
    expect(() =>
      applyPatch(INITIAL_OUTFIT, { jacket: "bomber", jacketColor: "navy" }),
    ).toThrow();
    expect(INITIAL_OUTFIT.jacket).toBe("none");
    expect(() =>
      applyPatch(INITIAL_OUTFIT, { glassesSize: "large" }),
    ).toThrow();
    expect(() =>
      applyPatch(INITIAL_OUTFIT, { focus: "glasses" } as any),
    ).toThrow();
  });
  test("all catalog defaults and permitted colors produce legal states", () => {
    for (const i of CATALOG)
      for (const color of i.colors) {
        const patch =
          i.slot === "jacket"
            ? { jacket: i.id, jacketColor: color }
            : { glasses: i.id, glassesColor: color };
        expect(outfitErrors(applyPatch(INITIAL_OUTFIT, patch as any))).toEqual(
          [],
        );
      }
  });
  test("unsupported and clarification actions do not mutate outfit", () => {
    for (const action of ["clarify", "unsupported"])
      expect(
        interpretEdit(INITIAL_OUTFIT, response({ action, jacket: "denim" }))
          .outfit,
      ).toEqual(INITIAL_OUTFIT);
  });
  test("out-of-domain model answer is rejected", () => {
    expect(
      interpretEdit(INITIAL_OUTFIT, response({ jacket: "invisible" })).action,
    ).toBe("rejected");
    expect(
      interpretEdit(INITIAL_OUTFIT, response({ action: "purchase" })).action,
    ).toBe("rejected");
  });
  test("full prompt carries all cumulative items, no body resize", () => {
    const text = fullPrompt(demoOutfits()[3].after);
    expect(text).toContain("navy denim jacket");
    expect(text).toContain("pink wayfarer sunglasses");
    expect(text).toContain("large frames");
    expect(text).toContain("regular fit");
    expect(text).toContain("Preserve");
  });
  test("request revision/session invalidates old results", () => {
    expect(
      currentTicket({ session: 1, revision: 2 }, { session: 1, revision: 3 }),
    ).toBe(false);
    expect(
      currentTicket({ session: 1, revision: 2 }, { session: 2, revision: 2 }),
    ).toBe(false);
  });
  test("Jev input contains only command, outfit and catalog metadata", () => {
    const data = editState(INITIAL_OUTFIT, "A jacket, please");
    expect(Object.keys(data).sort()).toEqual([
      "canonicalOutfit",
      "newestCommand",
      "outfit",
      "privacy",
      "version",
      "wardrobe",
    ]);
    expect(JSON.stringify(data)).not.toContain("data:image");
    expect(data.wardrobe.every((i) => !("path" in i))).toBe(true);
  });
  test("preserves all declared baseline evidence including failures", () => {
    const baseline = readRecord(
      new URL("./wardrobe-v1.jsonl", import.meta.url),
    );
    expect(baseline.result.rows).toHaveLength(12);
    expect(baseline.result.rows.filter((r: any) => r.score.exact)).toHaveLength(
      9,
    );
    expect(baseline.result.providerFailures.length).toBeGreaterThan(0);
  });
});
test("pronoun scope keeps glasses edits from changing the jacket; raw result remains inspectable", () => {
  const before = demoOutfits()[1].after,
    raw = response({ glassesColor: "pink", jacketColor: "pink" });
  expect(interpretEdit(before, raw).outfit.jacketColor).toBe("pink");
  const guarded = interpretEdit(before, raw, "Make them pink.");
  expect(guarded.outfit.jacketColor).toBe("navy");
  expect(guarded.outfit.glassesColor).toBe("pink");
  expect(guarded.reason).toContain("jacketColor");
  expect(raw.answers.jacketColor.value).toBe("pink");
});
test("explicit named target overrides pronoun focus", () => {
  const before = demoOutfits()[1].after;
  expect(
    interpretEdit(
      before,
      response({ jacketColor: "pink" }),
      "Make the jacket pink.",
    ).outfit.jacketColor,
  ).toBe("pink");
});
test("spoken pipeline is a contiguous replay of actual Jev responses for exact transcripts", () => {
  const pipeline = JSON.parse(
    require("node:fs").readFileSync(
      new URL("./spoken-pipeline.json", import.meta.url),
      "utf8",
    ),
  );
  const fixture = readRecord(new URL("./wardrobe.jsonl", import.meta.url));
  let state = INITIAL_OUTFIT;
  for (const turn of pipeline.turns) {
    const row = fixture.result.rows.find(
      (r: any) => r.id === turn.reusedJevCaseId,
    );
    expect(turn.before).toEqual(state);
    expect(turn.text).toBe(row.text);
    expect(turn.rawResponse).toEqual(row.response);
    expect(turn.after).toEqual(
      interpretEdit(state, turn.rawResponse, turn.text).outfit,
    );
    state = turn.after;
  }
  expect(state.jacketColor).toBe("navy");
  expect(state.glassesColor).toBe("pink");
  expect(state.glassesSize).toBe("large");
});
test("spoken recording and authored control remain separate genuine media artifacts", () => {
  const fs = require("node:fs");
  for (const name of ["try-on-demo", "spoken-try-on-demo"]) {
    const bytes = fs.readFileSync(
      new URL(`./assets/${name}.webm`, import.meta.url),
    );
    expect(bytes.byteLength).toBeGreaterThan(100000);
    expect(bytes.byteLength).toBeLessThan(2000000);
    expect(bytes.includes(Buffer.from("V_VP8"))).toBe(true);
    if (name.startsWith("spoken"))
      expect(bytes.includes(Buffer.from("A_OPUS"))).toBe(true);
  }
  const meta = JSON.parse(
    fs.readFileSync(
      new URL("./spoken-recording.json", import.meta.url),
      "utf8",
    ),
  );
  expect(meta.status).toBe("complete");
  expect(meta.actualRecordedSeconds).toBeGreaterThan(29);
  expect(meta.speechIncluded).toBe(true);
});
test("changing both garment slots clears an ambiguous future pronoun referent", () => {
  const before = demoOutfits()[1].after;
  expect(
    applyPatch(before, { jacketColor: "pink", glassesColor: "amber" }).focus,
  ).toBe("none");
});
