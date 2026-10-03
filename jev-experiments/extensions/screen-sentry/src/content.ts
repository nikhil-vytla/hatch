/**
 * PROTOTYPE. Screen sentry's content script: walks the page's text blocks (including hidden text,
 * HTML comments and image alt text), scores each with the bundled free classifier, and outlines
 * the ones that read like instructions to an AI assistant. Nothing leaves the page.
 */
import { RISK_THRESHOLD, score, type Block, type Weights, type Where } from "../../../live-worlds/sentry/model";
import weights from "../../../live-worlds/sentry/weights.json";

const W = weights as Weights;

type Found = Block & { risk: number; el?: Element; node?: Comment };

const BLOCK_TAGS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dd,dt,label,span,div,a,small";

function whereOf(el: Element): Where {
  const s = getComputedStyle(el);

  if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return "hidden";

  if (el.getAttribute("aria-hidden") === "true") return "aria-hidden";

  const r = el.getBoundingClientRect();

  if (r.right < 0 || r.bottom < 0 || r.left > innerWidth * 3) return "offscreen";

  if (parseFloat(s.fontSize) < 6) return "tiny";

  // Text the same colour as its background reads as invisible to a person.
  if (s.color === effectiveBackground(el)) return "hidden";

  return parseFloat(s.fontSize) < 10 ? "tiny" : "visible";
}

function effectiveBackground(el: Element | null): string {
  while (el) {
    const bg = getComputedStyle(el).backgroundColor;

    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;

    el = el.parentElement;
  }

  return "rgb(255, 255, 255)";
}

/** Leaf-ish elements with their own text, plus comments and alt text. */
function collect(): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();

  for (const el of document.body.querySelectorAll(BLOCK_TAGS)) {
    if (el.closest("[data-screen-sentry]")) continue;

    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();

    if (own.length < 4 || seen.has(own)) continue;

    seen.add(own);

    const b: Block = { text: own.slice(0, 600), where: whereOf(el) };

    out.push({ ...b, risk: score(W, b).risk, el });
  }

  for (const img of document.querySelectorAll("img[alt]")) {
    const alt = img.getAttribute("alt")?.trim() ?? "";

    if (alt.length < 4) continue;

    const b: Block = { text: alt, where: "alt" };

    out.push({ ...b, risk: score(W, b).risk, el: img });
  }

  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").trim();

    if (text.length < 4) continue;

    const b: Block = { text: text.slice(0, 600), where: "comment" };

    out.push({ ...b, risk: score(W, b).risk, node: n as Comment });
  }

  return out;
}

let found: Found[] = [];

function mark(enabled: boolean) {
  for (const el of document.querySelectorAll("[data-screen-sentry-flag]")) {
    el.removeAttribute("data-screen-sentry-flag");
    (el as HTMLElement).style.removeProperty("outline");
    (el as HTMLElement).style.removeProperty("outline-offset");
    el.removeAttribute("title");
  }

  for (const el of document.querySelectorAll("[data-screen-sentry]")) el.remove();

  if (!enabled) return;

  for (const f of found) {
    if (f.risk < RISK_THRESHOLD) continue;

    // A comment has no box of its own: mark where it sits with a small badge instead.
    if (f.node?.parentNode) {
      const badge = document.createElement("span");

      badge.setAttribute("data-screen-sentry", "comment");
      badge.textContent = `⚠ Screen sentry: hidden comment, ${Math.round(f.risk * 100)}% likely aimed at an AI assistant`;
      badge.title = f.text.slice(0, 200);
      badge.style.cssText = "display:inline-block;font:700 12px system-ui;background:#f0532d;color:#fff;border-radius:999px;padding:2px 8px;margin:4px 0";
      f.node.parentNode.insertBefore(badge, f.node);
      continue;
    }

    if (!(f.el instanceof HTMLElement)) continue;

    f.el.setAttribute("data-screen-sentry-flag", f.where);
    f.el.style.setProperty("outline", "3px dashed #f0532d", "important");
    f.el.style.setProperty("outline-offset", "2px", "important");
    f.el.title = `Screen sentry: ${Math.round(f.risk * 100)}% likely an instruction aimed at an AI assistant (${f.where}). "${f.text.slice(0, 120)}"`;
  }
}

async function scan() {
  found = collect();

  const { enabled = true } = await chrome.storage.local.get("enabled");

  mark(enabled !== false);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "stats")
    reply({
      scanned: found.length,
      flagged: found.filter((f) => f.risk >= RISK_THRESHOLD).map(({ text, where, risk }) => ({ text, where, risk })),
    });

  if (msg?.type === "toggle") void chrome.storage.local.set({ enabled: msg.enabled }).then(() => mark(msg.enabled));

  return false;
});

void scan();
