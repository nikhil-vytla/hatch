(() => {
  if (window.__jevPasteInstalled) return;
  window.__jevPasteInstalled = true;
  const allowed = (el) =>
    el &&
    el.matches("input,textarea,select") &&
    !el.disabled &&
    !el.readOnly &&
    ![
      "password",
      "hidden",
      "file",
      "checkbox",
      "radio",
      "submit",
      "button",
      "reset",
      "image",
    ].includes(el.type) &&
    el.getClientRects().length;
  const label = (el) =>
    el.getAttribute("aria-label") ||
    [...(el.labels || [])].map((x) => x.textContent.trim()).join(" ") ||
    el.placeholder ||
    el.name ||
    el.id ||
    el.type;
  const setValue = (el, value) => {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  let lastFocused = document.activeElement;
  document.addEventListener("focusin", (e) => {
    if (allowed(e.target)) lastFocused = e.target;
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "open-suggestions") return;
    const focused = allowed(document.activeElement)
      ? document.activeElement
      : lastFocused;
    const scope = focused?.form || document;
    const elements = (
      message.mode === "field"
        ? [focused]
        : [...scope.querySelectorAll("input,textarea,select")]
    )
      .filter(allowed)
      .slice(0, 24);
    document.getElementById("jev-paste-companion")?.remove();
    const host = document.createElement("div");
    host.id = "jev-paste-companion";
    host.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647";
    document.documentElement.append(host);
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ":host{color-scheme:light dark}section{width:min(360px,90vw);max-height:78vh;overflow:auto;background:light-dark(#f7f8f2,#232b25);color:light-dark(#26392a,#f1f4ed);font:14px/1.5 system-ui;padding:20px;box-shadow:0 12px 60px #0004;border:1px solid #83958370;border-radius:14px}h2{font-size:21px;margin:0 0 8px}button{font:inherit;cursor:pointer;border:1px solid #83958370;padding:6px 10px;border-radius:5px;margin:5px 4px 0 0;background:transparent;color:inherit}article{border-top:1px solid #83958350;padding:12px 0}b,small{display:block}small{opacity:.7}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.close{float:right}";
    root.append(style);
    const section = document.createElement("section");
    section.setAttribute("role", "dialog");
    section.setAttribute("aria-label", "Jev paste suggestions");
    root.append(section);
    const button = (text, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.onclick = fn;
      return b;
    };
    const close = button("Close", () => host.remove());
    close.className = "close";
    section.append(close);
    const heading = document.createElement("h2");
    heading.textContent = "Paste what belongs";
    section.append(heading);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = elements.length
      ? "Finding the right source facts…"
      : "Focus an editable field first, then try again.";
    section.append(status);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") host.remove();
    });
    if (!elements.length) return;
    const fields = elements.map((el, i) => ({
      id: `field${i}`,
      label: label(el),
      type: el.type,
      options:
        el.tagName === "SELECT"
          ? [...el.options].map((o) => o.text)
          : undefined,
    }));
    const originals = elements.map((el) => el.value),
      accepted = [];
    chrome.runtime
      .sendMessage({ type: "suggest", fields })
      .then((result) => {
        if (result.error) {
          status.textContent = result.error;
          return;
        }
        status.textContent =
          "Review each value before accepting. No form will be submitted.";
        const source = document.createElement("small");
        source.textContent =
          "Source: " + (result.sourceUrl || "Captured selection");
        section.append(source);
        const undo = button("Undo accepted values", () => {
          for (const item of accepted.splice(0).reverse()) {
            if (item.el.value === item.applied) setValue(item.el, item.before);
          }
          status.textContent =
            "Accepted values undone. Later manual edits were preserved.";
        });
        section.append(undo);
        for (const suggestion of result.suggestions) {
          const i = fields.findIndex((f) => f.id === suggestion.id),
            el = elements[i],
            fact = suggestion.fact;
          const article = document.createElement("article"),
            title = document.createElement("b"),
            value = document.createElement("p");
          title.textContent = suggestion.label;
          value.textContent = fact?.value || "No supported value found.";
          article.append(title, value);
          if (fact) {
            const attribution = document.createElement("small");
            attribution.textContent = "From " + fact.label;
            article.append(attribution);
            const accept = button(
              originals[i] ? "Replace existing value" : "Accept value",
              () => {
                if (!el.isConnected || el.value !== originals[i]) {
                  status.textContent =
                    "This field changed. Ask for a fresh suggestion.";
                  return;
                }
                let next = fact.value;
                if (el.tagName === "SELECT") {
                  const option = [...el.options].find(
                    (o) =>
                      o.value === next ||
                      o.text.trim().toLowerCase() === next.toLowerCase(),
                  );
                  if (!option) {
                    status.textContent =
                      "No exact matching option. Choose this field manually.";
                    return;
                  }
                  next = option.value;
                }
                setValue(el, next);
                if (el.value !== next) {
                  setValue(el, originals[i]);
                  status.textContent =
                    "The field needs a different format. Fill it manually.";
                  return;
                }
                accepted.push({ el, before: originals[i], applied: next });
                accept.disabled = true;
                accept.textContent = "Accepted";
                status.textContent =
                  "Value filled. Review the destination before submitting it yourself.";
              },
            );
            article.append(accept);
          }
          section.append(article);
        }
        close.focus();
      })
      .catch((error) => (status.textContent = error.message));
  });
})();
