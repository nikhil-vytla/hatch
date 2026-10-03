/** The tool-call bouncer on two small agent logs, one per format. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { check, grounded, judge, parseLog } from "../src/bouncer";
import type { Endpoint } from "../src/endpoints";

const fixture = (name: string) => parseLog(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")));
const kinds = (f: ReturnType<typeof check>) => f.map((x) => `${x.tool}.${x.argument}:${x.kind}`);

describe("OpenAI-format booking agent", () => {
  const log = fixture("openai-booking.json");
  const f = check(log);

  test("reads all three tool calls", () => expect(log.calls.map((c) => c.name)).toEqual(["search_restaurants", "book_table", "send_sms"]));

  test("flags the invented phone number and the made-up SMS recipient", () => {
    expect(kinds(f)).toContain("book_table.phone:ungrounded");
    expect(kinds(f)).toContain("send_sms.to:ungrounded");
  });

  test("schema: an enum violation and a tool that doesn't exist", () => {
    expect(kinds(f)).toContain("book_table.seating:not-in-enum");
    expect(kinds(f)).toContain("send_sms.:unknown-tool");
  });

  test("dates and times a model computed from 'tomorrow at 7:30pm' are info, not warnings", () => {
    expect(kinds(f)).toContain("book_table.date:derived?");
    expect(f.find((x) => x.argument === "date")!.severity).toBe("info");
  });

  test("values the agent saw are grounded", () => {
    expect(kinds(f).some((k) => k.startsWith("book_table.restaurant"))).toBe(false);
    expect(kinds(f).some((k) => k.startsWith("search_restaurants"))).toBe(false);
  });
});

describe("Anthropic-format refund agent", () => {
  const f = check(fixture("anthropic-refund.json"));

  test("a transposed order id and a wrong amount", () => {
    expect(kinds(f)).toContain("issue_refund.order_id:ungrounded");
    expect(kinds(f)).toContain("issue_refund.amount_gbp:ungrounded");
    expect(kinds(f).some((k) => k.startsWith("lookup_order"))).toBe(false);
  });
});

describe("the typed judge", () => {
  test("one yes/no per suspect argument; its answer sets P(grounded) and the severity", async () => {
    const log = fixture("anthropic-refund.json");
    const f = check(log);
    const asked: unknown[] = [];
    const ep: Endpoint = {
      label: "fake",
      usdPerMTok: 0,
      async ask(request) {
        asked.push(request);

        return { answers: { grounded: { type: "noul", value: 0.1, probabilities: null } }, latencyMs: 1, inputTokens: 1, costUsd: 0, servedBy: null, model: null };
      },
    };

    await judge(log, f, ep);
    expect(asked).toHaveLength(f.filter((x) => ["ungrounded", "derived?", "free text"].includes(x.kind)).length);
    expect(f.find((x) => x.argument === "order_id")!.pGrounded).toBe(0.1);
  });

  test("grounding ignores case, spacing and punctuation", () => {
    expect(grounded("+44 20 7420 9320", "call 44-20-7420-9320")).toBe(true);
    expect(grounded("HB-44871", "order HB-44817")).toBe(false);
  });
});
