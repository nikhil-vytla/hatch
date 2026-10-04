/**
 * Generated UI's "Build this" shows the first request "Compose a new interface" sends. Runs the
 * server's composer against a stub gateway and checks that the body it posts is exactly the
 * request the scene shows, for each domain. No request leaves the machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { compose } from "../server/compose";
import { gatewayBody, GATEWAY_URL } from "./build-this-snippets";
import { firstCompositionRequest, type ComposeBody } from "./composition-request";

const PROMPTS: ComposeBody[] = [
  { domain: "settings", prompt: "Create account settings with name, email, notifications, and a save button." },
  { domain: "apartments", prompt: "Compare all three apartments. Show rent, commute, budget, and a shortlist button for each." },
  { domain: "event", prompt: "Create an event planning form with name, location, guests, dietary preference, and save." },
  { domain: "settings", prompt: "Quotes \"inside\", a\nnewline and naïve “curly” text" },
];

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** What the server posts to the gateway when composing `body`; the stub answers "unavailable", which ends the build. */
async function posted(body: ComposeBody) {
  const sent: { url: string; body: unknown }[] = [];

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    sent.push({ url, body: request });
    const keys = Object.keys(request.questions.next.criteria);

    return Response.json({
      answers: {
        next: {
          type: "choice",
          choice: "unavailable",
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === "unavailable" ? 1 : 0])),
        },
      },
    });
  }) as typeof fetch;

  const events = [];

  for await (const e of compose(body, new AbortController().signal, "stub-key")) events.push(e);

  return { sent, last: events.at(-1) };
}

describe("Generated UI: Build this", () => {
  for (const body of PROMPTS)
    test(`${body.domain}, "${body.prompt.slice(0, 30)}": the request shown is the server's first call`, async () => {
      const shown = await firstCompositionRequest(body);
      const { sent, last } = await posted(body);

      expect(shown).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe(GATEWAY_URL);
      expect(sent[0].body).toEqual(JSON.parse(JSON.stringify(gatewayBody(shown as never))));
      expect(last).toMatchObject({ type: "complete", stopReason: "unavailable" });
    });

  test("nothing is sent while the request is built", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls++;

      return Response.json({});
    }) as unknown as typeof fetch;
    await firstCompositionRequest(PROMPTS[0]);
    expect(calls).toBe(0);
  });
});
