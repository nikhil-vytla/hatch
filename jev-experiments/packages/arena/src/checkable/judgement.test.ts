import { describe, expect, test } from "bun:test";
import { bankSchema } from "./items";
import bankJson from "./judgement-bank.json";
import { meets, orderItem } from "./order";
import { route, routeItem, rulePool } from "./route";

const latte = {
  name: "latte",
  milk: "whole milk" as const,
  caffeineMg: 130,
  sugar: 0 as const,
  syrup: "hazelnut syrup",
  price: 5,
  served: "hot" as const,
};

describe("order truth", () => {
  test("each requirement is checked against the drink's facts", () => {
    expect(meets(latte, { kind: "dairy", label: "" })).toBe(false);
    expect(meets({ ...latte, milk: "oat milk" }, { kind: "dairy", label: "" })).toBe(true);
    expect(meets(latte, { kind: "nuts", label: "" })).toBe(false);
    expect(meets(latte, { kind: "caffeine", max: 50, label: "" })).toBe(false);
    expect(meets(latte, { kind: "budget", max: 5, label: "" })).toBe(true);
    expect(meets(latte, { kind: "temperature", want: "iced", label: "" })).toBe(false);
    expect(meets(latte, { kind: "sweet", max: 0, label: "" })).toBe(true);
  });

  test("a single broken request at most, and meets_all agrees with it", () => {
    for (let seed = 1; seed < 200; seed++) {
      const item = orderItem(seed);

      if (!item) continue;
      expect(item.truth.meets_all).toBe(item.truth.breaks === "none");
    }
  });
});

describe("route truth", () => {
  const pool = rulePool(100);
  const byId = (id: string) => pool.filter((r) => r.id === id);

  test("the first rule that applies wins", () => {
    const hacked = { topic: "security" as const, amount: 300, upset: true };

    expect(route([...byId("billing"), ...byId("security")], hacked)).toBe("Billing");
    expect(route([...byId("security"), ...byId("billing")], hacked)).toBe("Security");
  });

  test("exactly the threshold is not over it; a calm outage falls through", () => {
    expect(route(byId("big-refund"), { topic: "refund", amount: 100, upset: false })).toBe(
      "Support",
    );
    expect(route(byId("big-refund"), { topic: "refund", amount: 101, upset: false })).toBe(
      "Billing",
    );
    expect(route(byId("upset-outage"), { topic: "outage", amount: null, upset: false })).toBe(
      "Support",
    );
  });

  test("today is exactly Security or On-call", () => {
    for (let seed = 1; seed < 100; seed++) {
      const { truth } = routeItem(seed);

      expect(truth.today).toBe(truth.team === "Security" || truth.team === "On-call");
    }
  });
});

describe("judgement bank", () => {
  test("is deterministic and matches the committed file", () => {
    const bank = bankSchema.parse(bankJson);

    expect(bank.items).toHaveLength(150);
    expect(routeItem(7)).toEqual(bank.items.find((i) => i.id === "route-7") ?? null);
    const order = bank.items.find((i) => i.kind === "order");

    expect(order && orderItem(order.seed)).toEqual(order ?? null);
  });
});
