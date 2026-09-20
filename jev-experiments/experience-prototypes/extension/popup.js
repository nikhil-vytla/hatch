const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);
const stored = await chrome.storage.local.get([
  "source",
  "sourceUrl",
  "memory",
  "useMemory",
  "endpoint",
  "token",
]);
for (const key of ["source", "memory", "endpoint", "token"])
  if (stored[key]) $(key).value = stored[key];
$("sourceUrl").textContent = stored.sourceUrl || "No page captured yet";
$("useMemory").checked = !!stored.useMemory;
async function active() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
$("capture").onclick = async () => {
  try {
    const tab = await active();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() || "",
    });
    if (!result.trim()) return status("Select text on the page first.");
    $("source").value = result.slice(0, 30000);
    $("sourceUrl").textContent = tab.url;
    await chrome.storage.local.set({
      source: $("source").value,
      sourceUrl: tab.url,
    });
    status("Selection captured. Open the destination page.");
  } catch (e) {
    status(e.message);
  }
};
$("saveNotes").onclick = async () => {
  await chrome.storage.local.set({
    source: $("source").value,
    memory: $("memory").value,
    useMemory: $("useMemory").checked,
  });
  status("Saved in this browser.");
};
$("connect").onclick = async () => {
  try {
    const endpoint = new URL($("endpoint").value).origin;
    if (
      !/^https:/.test(endpoint) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(endpoint)
    )
      throw new Error("Use HTTPS or localhost.");
    if (!(await chrome.permissions.request({ origins: [`${endpoint}/*`] })))
      return status("Connection permission was not granted.");
    await chrome.storage.local.set({
      endpoint,
      token: $("token").value.trim(),
    });
    status("Connected.");
  } catch (e) {
    status(e.message);
  }
};
async function suggest(mode) {
  try {
    await chrome.storage.local.set({
      source: $("source").value,
      memory: $("memory").value,
      useMemory: $("useMemory").checked,
    });
    const tab = await active();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, { type: "open-suggestions", mode });
    window.close();
  } catch (e) {
    status(e.message);
  }
}
$("field").onclick = () => suggest("field");
$("form").onclick = () => suggest("form");
$("clear").onclick = async () => {
  await chrome.storage.local.remove(["source", "sourceUrl", "memory"]);
  $("source").value = "";
  $("memory").value = "";
  $("sourceUrl").textContent = "Cleared";
  chrome.action.setBadgeText({ text: "" });
  status("Captured information and notes cleared.");
};
