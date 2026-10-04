/**
 * Every receipt for a Jev answer offers "Build this": its data carries the request (raw.request,
 * a log to load it from, or a live response whose request api.ts remembers). Receipts that
 * aren't for a Jev request, or whose code sits beside them, are listed with the reason.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

/** Receipts that don't carry a request themselves, by file and label or data, with why. */
const EXEMPT: { file: string; match: string; why: string }[] = [
  { file: "eyes-vs-state.tsx", match: "MLX-VLM", why: "the vision model's receipt, not a Jev request" },
  { file: "generated-ui.tsx", match: "composed", why: "a composition is a loop of requests json-render builds step by step, not one request" },
  { file: "win-over.tsx", match: 'label="Decided by"', why: "the BuildThis beside it shows the line's batched Jev call" },
];

/** What makes a receipt's data carry its request. */
const CARRIES = /request|loadRequest|fromLive(Batches)?\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);

    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

/** The text of each <Receipt ... data={...} /> in a file: its data expression with balanced braces. */
function receipts(text: string) {
  const out: { at: number; tag: string; data: string }[] = [];

  for (const m of text.matchAll(/<Receipt\b/g)) {
    const start = m.index!;
    const d = text.indexOf("data={", start);
    let depth = 0;
    let i = d + 5;

    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }

    out.push({ at: start, tag: text.slice(start, d), data: text.slice(d + 6, i) });
  }

  return out;
}

/** Whether an identifier the data names is built, somewhere in the file, from something carrying a request. */
function definedWithRequest(text: string, data: string) {
  return [...data.matchAll(/[A-Za-z_$][\w$]*/g)].some(([name]) =>
    [...text.matchAll(new RegExp(`(?:const|let|function)\\s+${name}\\b|\\b${name}\\s*[:=]\\s*`, "g"))].some((d) => CARRIES.test(text.slice(d.index!, d.index! + 1200))),
  );
}

describe("Build this coverage", () => {
  const scenes = files(SRC).filter((f) => /from "\.\.?\/receipt"/.test(readFileSync(f, "utf8")));

  test("finds the scenes with receipts", () => {
    expect(scenes.length).toBeGreaterThan(25);
  });

  for (const file of scenes) {
    const name = relative(SRC, file);
    const text = readFileSync(file, "utf8");

    test(`${name}: every Jev receipt carries its request`, () => {
      for (const r of receipts(text)) {
        const exempt = EXEMPT.find((e) => name.endsWith(e.file) && (r.tag + r.data).includes(e.match));

        if (exempt) continue;

        // A stored `.receipt` is only ever built by fromLive or fromLiveBatches, which keep the request.
        const ok = CARRIES.test(r.data) || definedWithRequest(text, r.data) || (/\.receipt$/.test(r.data.trim()) && /fromLive(Batches)?\(/.test(text));

        expect(ok ? "" : `${name}:${text.slice(0, r.at).split("\n").length} has no request for Build this: ${r.data.slice(0, 120)}`).toBe("");
      }
    });
  }

  test("the exemptions still match something", () => {
    for (const e of EXEMPT) expect(readFileSync(join(SRC, e.file), "utf8")).toContain(e.match);
  });

  test("the scenes without receipts that call Jev show Build this", () => {
    for (const f of ["handoff.tsx", "ocean-reef.tsx", "rumour-mill.tsx", "live-tetris.tsx", "win-over.tsx", "formats/prose-article.tsx", "arena/try-box.tsx"])
      expect(readFileSync(join(SRC, f), "utf8")).toContain("<BuildThis");
  });
});
