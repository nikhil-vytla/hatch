/** The popup: what the sentry found on this tab, an on/off toggle, and an optional Jev check. */
type Flagged = { text: string; where: string; risk: number };

const $ = (id: string) => document.getElementById(id) as HTMLElement;

async function tab() {
  // Test hook: ?tab=<id> lets an automated check open the popup as a page for a given tab.
  const forced = Number(new URLSearchParams(location.search).get("tab"));

  if (forced) return chrome.tabs.get(forced);

  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });

  return t;
}

async function load() {
  const t = await tab();
  const { enabled = true } = await chrome.storage.local.get("enabled");

  ($("enabled") as HTMLInputElement).checked = enabled !== false;

  if (!t?.id) return;

  const stats: { scanned: number; flagged: Flagged[] } | undefined = await chrome.tabs.sendMessage(t.id, { type: "stats" }).catch(() => undefined);

  if (!stats) {
    $("summary").textContent = "The sentry can't read this page (browser pages and the Web Store are off limits).";
    return;
  }

  $("summary").textContent = `${stats.flagged.length} of ${stats.scanned} blocks look like instructions to an AI assistant.`;

  const list = $("list");

  list.replaceChildren(
    ...stats.flagged.map((f) => {
      const li = document.createElement("li");

      li.innerHTML = `<b>${Math.round(f.risk * 100)}%</b> <span class="where"></span> <span class="text"></span>`;
      (li.querySelector(".where") as HTMLElement).textContent = f.where;
      (li.querySelector(".text") as HTMLElement).textContent = f.text.slice(0, 140);

      return li;
    }),
  );

  $("ask").onclick = async () => {
    $("jev").textContent = "Asking Jev…";

    const r = await chrome.runtime.sendMessage({ type: "askJev", url: t.url, blocks: stats.flagged });

    $("jev").textContent =
      r?.error ?? `Jev's hijack risk for the first ${r.checked} of ${r.of}: ${r.risks.map((x: number) => `${Math.round(x * 100)}%`).join(", ")}`;
  };
}

($("enabled") as HTMLInputElement).onchange = async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  const t = await tab();

  await chrome.storage.local.set({ enabled });

  if (t?.id) await chrome.tabs.sendMessage(t.id, { type: "toggle", enabled }).catch(() => undefined);
};

void load();
