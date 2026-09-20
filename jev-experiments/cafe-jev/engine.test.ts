import { describe, expect, test } from "bun:test";
import {
  FIELDS,
  MENU,
  INGREDIENTS,
  RECIPE_CATALOG,
  CUSTOMERS,
  CONTRACT_VERSION,
  candidates,
  constraintErrors,
  emptyPreferences,
  facts,
  ingredients,
  interpret,
  inventoryFor,
  isCurrent,
  matches,
  modelQuestions,
  price,
  publicState,
  recipeErrors,
  recipeId,
  relaxations,
  scoreCustomer,
  setPreference,
  usefulQuestions,
  type Field,
  type ModelResponse,
  type Preferences,
  type Recipe,
} from "./engine";
import { CASES, partialCases, makeCase } from "./cases";

const defaultStock = inventoryFor(11);
const p = (values: Partial<Record<Field, string>>) =>
  makeCase("test", "test", "fixture", values).expected;
function oracleRecipe(r: Recipe, values: Record<string, string | undefined>) {
  // Independently stated facts for the finite four-field projection. Do not use
  // the production matches() or facts() implementation for this oracle.
  const attrs: Record<string, string> = {
    temperature: r.temperature,
    caffeine: ["espresso", "brew"].includes(r.family) ? "yes" : "no",
    dairy: r.milk === "dairy" ? "yes" : "no",
    sweet: r.sweetness === "none" ? "no" : "yes",
  };
  return Object.entries(values).every(([f, v]) => attrs[f] === v);
}
describe("recipe and preference invariants", () => {
  test("catalog enumerates only legal, uniquely named recipes", () => {
    const allStock = Object.fromEntries(
      Object.keys(INGREDIENTS).map((k) => [k, 10]),
    ) as typeof defaultStock;
    expect(RECIPE_CATALOG).toHaveLength(304);
    expect(new Set(RECIPE_CATALOG.map(recipeId)).size).toBe(304);
    for (const r of RECIPE_CATALOG) {
      expect(recipeErrors(r, allStock)).toEqual([]);
      expect(price(r)).toBeGreaterThanOrEqual(250);
      expect(price(r)).toBeLessThanOrEqual(675);
      expect(ingredients(r).every((i) => Object.hasOwn(INGREDIENTS, i))).toBe(
        true,
      );
    }
    expect(candidates(emptyPreferences(), defaultStock)).toHaveLength(228);
  });
  test("all 81 partial states match an independent four-attribute oracle", () => {
    expect(partialCases).toHaveLength(81);
    let noMatch = 0;
    for (const c of partialCases) {
      const values = Object.fromEntries(
        FIELDS.filter((f) => c.expected[f].status === "required").map((f) => [
          f,
          c.expected[f].value!,
        ]),
      );
      const expected = RECIPE_CATALOG.filter(
        (r) => r.milk !== "soy" && oracleRecipe(r, values),
      )
        .map(recipeId)
        .sort();
      const actual = candidates(c.expected, c.input.inventory)
        .map(recipeId)
        .sort();
      expect(actual).toEqual(expected);
      if (!actual.length) noMatch++;
    }
    expect(noMatch).toBe(3);
  });
  test("prices, stock, unsupported recipes and hard requirements block confirmation", () => {
    const r: Recipe = {
      family: "espresso",
      temperature: "hot",
      milk: "oat",
      sweetness: "light",
      size: "large",
      shots: 2,
      syrup: "vanilla",
    };
    expect(price(r)).toBe(595);
    expect(
      constraintErrors(r, p({ budget: "required_500" }), defaultStock),
    ).toContain("Does not meet budget: $5 maximum");
    expect(recipeErrors(r, inventoryFor(15))).toContain("Oat milk is sold out");
    expect(
      recipeErrors({ ...r, family: "lemonade" }, defaultStock).length,
    ).toBeGreaterThan(0);
    expect(recipeErrors({ ...r, shots: 999 }, defaultStock)).toContain(
      "Unsupported shot count",
    );
    expect(recipeErrors({ ...r, sweetness: "none" }, defaultStock)).toContain(
      "Vanilla requires a supported, sweetened recipe",
    );
    expect(
      candidates(p({ budget: "required_unsupported" }), defaultStock),
    ).toEqual([]);
  });
  test("creaminess, dairy, coffee flavor and caffeine stay separate", () => {
    const r = RECIPE_CATALOG.find(
      (r) => r.family === "cocoa" && r.milk === "oat",
    )!;
    expect(facts(r)).toMatchObject({
      creamy: "yes",
      dairy: "no",
      coffee: "no",
      caffeine: 0,
    });
    expect(
      candidates(
        p({ coffee: "required_yes", caffeine: "required_no" }),
        defaultStock,
      ),
    ).toEqual([]);
    expect(
      candidates(
        p({ creamy: "required_yes", dairy: "required_no" }),
        defaultStock,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      facts(
        RECIPE_CATALOG.find((r) => r.family === "brew" && r.size === "large")!,
      ).caffeine,
    ).toBe(126);
  });
  test("soft preferences rank recipes without excluding otherwise legal orders", () => {
    const preferences = p({
      temperature: "preferred_cold",
      dairy: "required_no",
    });
    const legal = candidates(preferences, defaultStock);
    expect(legal[0].temperature).toBe("cold");
    expect(legal.some((r) => r.temperature === "hot")).toBe(true);
    expect(legal.some((r) => r.milk === "dairy")).toBe(false);
  });
  test("useful questions split candidates and never ask known fields", () => {
    for (const c of partialCases) {
      const legal = candidates(c.expected, c.input.inventory);
      for (const field of usefulQuestions(c.expected, legal)) {
        expect(c.expected[field].status).toBe("unknown");
        const values = new Set(
          legal.map((r) =>
            field === "caffeine" ? facts(r).caffeine > 0 : facts(r)[field],
          ),
        );
        expect(values.size).toBeGreaterThan(1);
      }
    }
  });
  test("conflicts must resolve; minimal one-field relaxations are factual", () => {
    const conflict = p({ temperature: "conflicting" });
    expect(candidates(conflict, defaultStock)).toEqual([]);
    expect(usefulQuestions(conflict, [])).toEqual(["temperature"]);
    const impossible = p({ creamy: "required_yes", dairy: "required_no" });
    const stock = inventoryFor(15);
    expect(candidates(impossible, stock)).toHaveLength(0);
    expect(
      relaxations(impossible, stock)
        .map((r) => r.field)
        .sort(),
    ).toEqual(["creamy", "dairy"]);
  });
});
describe("model boundaries and replay", () => {
  function response(
    preferences: Preferences,
    family = "tea",
    question = "done",
  ): ModelResponse {
    return {
      answers: Object.fromEntries([
        ...FIELDS.flatMap((f) => [
          [
            f,
            {
              value:
                preferences[f].status === "unknown" ||
                preferences[f].status === "conflicting"
                  ? preferences[f].status
                  : `${preferences[f].status}_${preferences[f].value}`,
            },
          ],
          [
            `${f}_source`,
            { value: preferences[f].status === "unknown" ? "none" : "1" },
          ],
        ]),
        ["family", { value: family }],
        ["question", { value: question }],
      ]),
    };
  }
  test("raw incompatible suggestions remain rejected, not silently corrected", () => {
    const c = CASES.find((c) => c.id === "negation")!;
    const raw = response(c.expected, "lemonade");
    const decision = interpret(raw, c.input);
    expect(decision.feasible.length).toBeGreaterThan(0);
    expect(decision.suggested).toBeNull();
    expect(decision.errors.some((e) => e.includes("lemonade"))).toBe(true);
    expect(raw.answers.family.value).toBe("lemonade");
  });
  test("missing evidence blocks unsupported extraction", () => {
    const c = partialCases[2];
    const raw = response(c.expected);
    raw.answers.temperature_source.value = "12";
    const interpreted = interpret(raw, c.input);
    expect(interpreted.preferences.temperature.status).toBe("conflicting");
    expect(interpreted.feasible).toHaveLength(0);
  });
  test("authoritative choices survive omission and explicit releases survive old text", () => {
    const c = makeCase(
      "manual",
      "test",
      ["Serve it hot.", "I require cold.", "I no longer care about dairy."],
      {},
    );
    const cold = setPreference(
      emptyPreferences(),
      "temperature",
      "cold",
      c.input.transcript[1],
    );
    c.input.explicit.temperature = cold.temperature;
    c.input.explicit.dairy = {
      status: "unknown",
      value: null,
      sourceTurn: 3,
      evidence: c.input.transcript[2].text,
    };
    const raw = response(
      p({ temperature: "required_hot", dairy: "required_yes" }),
    );
    const decision = interpret(raw, c.input);
    expect(decision.preferences.temperature.value).toBe("cold");
    expect(decision.preferences.dairy.status).toBe("unknown");
  });
  test("request edit, manual choice, undo and customer switch invalidate older requests", () => {
    const start = { session: 3, revision: 4 };
    expect(isCurrent(start, { ...start })).toBe(true);
    for (const action of [
      "draft edit",
      "manual menu choice",
      "undo",
      "recipe revision",
    ]) {
      const newer = { ...start, revision: start.revision + 1 };
      expect(isCurrent(start, newer), action).toBe(false);
    }
    expect(isCurrent(start, { session: 4, revision: 4 })).toBe(false);
  });
  test("identical decisions replay to identical recipe and private goal outcome", () => {
    function replay() {
      const customer = CUSTOMERS[0],
        stock = inventoryFor(customer.seed);
      let preferences = emptyPreferences();
      Object.entries(customer.answers).forEach(([f, v], i) => {
        preferences = setPreference(preferences, f as Field, v!, {
          id: i + 1,
          text: `Explicit ${f}`,
          kind: "choice",
        });
      });
      const recipe = candidates(preferences, stock)[0];
      return {
        recipe,
        price: price(recipe),
        outcome: scoreCustomer(customer, recipe, stock),
      };
    }
    expect(replay()).toEqual(replay());
    expect(replay().outcome.success).toBe(true);
    const unavailable = CUSTOMERS[2];
    expect(
      scoreCustomer(
        unavailable,
        RECIPE_CATALOG[0],
        inventoryFor(unavailable.seed),
      ).goalFeasible,
    ).toBe(false);
  });
  test("public requests never contain private goals, expected labels or case answers", () => {
    const customer = CUSTOMERS[0];
    const state = publicState({
      transcript: [{ id: 1, text: customer.opening, kind: "customer" }],
      inventory: inventoryFor(customer.seed),
      explicit: {},
    });
    expect(state.contractVersion).toBe(CONTRACT_VERSION);
    for (const key of [
      "goal",
      "answers",
      "expected",
      "preferredFamily",
      "customer",
    ])
      expect(Object.hasOwn(state, key)).toBe(false);
    expect(Object.keys(modelQuestions())).toHaveLength(16);
    expect(state.menu).toBe(MENU);
  });
});
