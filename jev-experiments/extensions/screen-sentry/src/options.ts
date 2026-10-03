/** Options: the visitor's own AI Gateway key, kept in chrome.storage.local on this device. */
const input = document.getElementById("key") as HTMLInputElement;
const status = document.getElementById("status") as HTMLElement;

void chrome.storage.local.get("jevKey").then(({ jevKey }) => {
  input.value = jevKey ? "••••••••" : "";
});

(document.getElementById("save") as HTMLButtonElement).onclick = async () => {
  const v = input.value.trim();

  if (v && !v.startsWith("•")) await chrome.storage.local.set({ jevKey: v });

  status.textContent = "Saved on this device. It's only ever sent to ai-gateway.vercel.sh when you ask Jev.";
};

(document.getElementById("clear") as HTMLButtonElement).onclick = async () => {
  await chrome.storage.local.remove("jevKey");
  input.value = "";
  status.textContent = "Key removed.";
};
