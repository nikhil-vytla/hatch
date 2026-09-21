import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const base = new URL("../extension/", import.meta.url);
function fixture() {
  const data: any = {
    endpoint: "https://lab.example",
    apiKey: "caller-owned-key",
    token: "old-lab-token",
    source: "Email: demo@example.com",
    sourceUrl: "https://source.example/private?token=source-secret#fragment",
  };
  let listener: any, capture: any;
  const access: string[] = [],
    requests: any[] = [];
  const chrome = {
    runtime: {
      id: "extension-id",
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(fn: any) {
          listener = fn;
        },
      },
    },
    contextMenus: {
      create() {},
      onClicked: {
        addListener(fn: any) {
          capture = fn;
        },
      },
    },
    storage: {
      local: {
        async setAccessLevel(value: any) {
          access.push(value.accessLevel);
        },
        async get() {
          return { ...data };
        },
        async set(value: any) {
          Object.assign(data, value);
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys])
            delete data[key];
        },
      },
    },
    action: { setBadgeText() {} },
  };
  vm.runInNewContext(readFileSync(new URL("background.js", base), "utf8"), {
    chrome,
    URL,
    TextEncoder,
    fetch: async (url: any, init: any) => {
      requests.push({
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return Response.json({ answers: { field0: { value: "f0" } } });
    },
  });
  return {
    data,
    chrome,
    access,
    requests,
    capture: (...args: any[]) => capture(...args),
    suggest: (sender: any) =>
      new Promise<any>((resolve) =>
        listener(
          {
            type: "suggest",
            fields: [
              {
                id: "field0",
                label: "Email",
                type: "email",
                value: "not-needed",
              },
            ],
          },
          sender,
          resolve,
        ),
      ),
  };
}
test("companion strips URLs and extra field values, restricts storage, and uses the caller key", async () => {
  const f = fixture();
  const result = await f.suggest({
    id: "extension-id",
    tab: {
      url: "https://destination.example/reset?token=destination-secret#fragment",
    },
  });
  expect(f.access).toEqual(["TRUSTED_CONTEXTS"]);
  expect(f.data.token).toBeUndefined();
  expect(f.data.sourceUrl).toBe("https://source.example");
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].headers.Authorization).toBe("Bearer caller-owned-key");
  expect(JSON.stringify(f.requests[0].body)).not.toMatch(
    /source-secret|destination-secret|fragment|destination.example|source.example|not-needed/,
  );
  expect(result.sourceUrl).toBe("https://source.example");
  expect(result.suggestions[0].fact.value).toBe("demo@example.com");
  expect(JSON.stringify(result)).not.toContain("caller-owned-key");
  await f.capture(
    { menuItemId: "remember-selection", selectionText: "Name: Alex" },
    { url: "https://another.example/private?secret=yes#x" },
  );
  expect(f.data.sourceUrl).toBe("https://another.example");
});
test("untrusted senders cannot request stored facts", async () => {
  const f = fixture();
  expect(
    (await f.suggest({ id: "other-extension", tab: {} })).error,
  ).toBeDefined();
  expect((await f.suggest({ id: "extension-id" })).error).toBeDefined();
  expect(f.requests).toHaveLength(0);
});
test("disconnect removes the saved gateway key", async () => {
  const f = fixture(),
    elements: Record<string, any> = {};
  const element = (id: string) =>
    (elements[id] ??= { value: "", textContent: "" });
  const popup = readFileSync(new URL("popup.js", base), "utf8");
  await vm.runInNewContext(`(async () => { ${popup} })()`, {
    chrome: f.chrome,
    URL,
    document: { getElementById: element },
  });
  expect(element("apiKey").value).toBe("caller-owned-key");
  await element("disconnect").onclick();
  expect(f.data.apiKey).toBeUndefined();
  expect(f.data.endpoint).toBeUndefined();
  expect(element("apiKey").value).toBe("");
});
