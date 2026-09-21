import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readRecord, writeRecord } from "../experience-prototypes/scripts/records";
import type { Artwork } from "./protocol";

// Image delivery enrichment only. Never changes collection.jsonl or model evidence.
const here = import.meta.dir, collection = readRecord(resolve(here, "collection.jsonl")), works: Artwork[] = collection.result.works;
const auditPath = resolve(here, "image-source-events.jsonl");
const events: any[] = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let last = 0;
async function source(url: string) {
  const cached = events.find(e => e.url === url); if (cached) return cached.data;
  await Bun.sleep(Math.max(0, 3500 - (Date.now() - last))); last = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { "User-Agent": "JevVisualSearchResearch/1.0 (public artwork image provenance)", Accept: url.includes("query.wikidata.org") ? "application/sparql-results+json" : "application/json" } });
  if (response.status === 429) { const seconds = Number(response.headers.get("retry-after")); console.log(JSON.stringify({ host: new URL(url).hostname, status: 429, retry_after: response.headers.get("retry-after") })); await Bun.sleep(Math.max(60000, Number.isFinite(seconds) ? seconds * 1000 : 0)); return source(url); }
  const text = await response.text(); if (!response.ok) throw new Error(`Image metadata ${response.status} at ${new URL(url).hostname}`);
  const event = { fetched_at: new Date().toISOString(), url, response_sha256: sha(text), data: JSON.parse(text) };
  appendFileSync(auditPath, JSON.stringify(event) + "\n"); events.push(event); return event.data;
}
function api(params: Record<string, string>) { const u = new URL("https://commons.wikimedia.org/w/api.php"); Object.entries({ action: "query", format: "json", ...params }).forEach(([k, v]) => u.searchParams.set(k, v)); return u.href; }
const sparql = `SELECT ?artic ?item ?image WHERE { VALUES ?artic { ${works.map(w => `"${w.id}"`).join(" ")} } ?item wdt:P4610 ?artic; wdt:P18 ?image. }`;
const queryUrl = new URL("https://query.wikidata.org/sparql"); queryUrl.searchParams.set("query", sparql); queryUrl.searchParams.set("format", "json");
const bindings = (await source(queryUrl.href)).results.bindings;
type Candidate = { title: string; matched_by: string; match_source: string };
const candidates = new Map<number, Candidate[]>();
for (const row of bindings) {
  const id = Number(row.artic.value), title = "File:" + decodeURIComponent(row.image.value.split("Special:FilePath/")[1]);
  const list = candidates.get(id) ?? []; list.push({ title, matched_by: "Wikidata exact ARTIC artwork ID (P4610) and image (P18)", match_source: row.item.value.replace("http:", "https:") }); candidates.set(id, list);
}
const normalize = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
for (const work of works) {
  if (candidates.has(work.id)) continue;
  const url = api({ list: "exturlusage", euquery: `www.artic.edu/artworks/${work.id}`, eunamespace: "6", eulimit: "50" });
  if (!process.argv.includes("--expand") && !events.some(e => e.url === url)) continue;
  const data = await source(url), title = normalize(work.title);
  // A source link alone can be wrong. Require the museum title in the file name too.
  const matching = (data.query?.exturlusage ?? []).filter((p: any) => p.url.replace(/^http:/, "https:").replace(/\/$/, "") === work.sourceUrl && title.length >= 6 && normalize(p.title).includes(title));
  if (matching.length) candidates.set(work.id, matching.map((p: any) => ({ title: p.title, matched_by: "Exact museum artwork URL and normalized artwork title in Commons filename", match_source: work.sourceUrl })));
}
const titles = [...new Set([...candidates.values()].flatMap(rows => rows.map(row => row.title)))], pages: any[] = [];
for (let i = 0; i < titles.length; i += 8) {
  const data = await source(api({ titles: titles.slice(i, i + 8).join("|"), prop: "imageinfo", iiprop: "url|extmetadata|sha1|size", iiextmetadatafilter: "LicenseShortName|LicenseUrl", iiurlwidth: "600" }));
  pages.push(...Object.values(data.query?.pages ?? {}));
}
const mirrors = [];
for (const work of works) {
  for (const candidate of (candidates.get(work.id) ?? []).sort((a, b) => a.title.localeCompare(b.title))) {
    const page = pages.find(p => normalize(p.title) === normalize(candidate.title)), info = page?.imageinfo?.[0], license = info?.extmetadata?.LicenseShortName?.value;
    if (!info?.thumburl || !["Public domain", "CC0"].includes(license)) continue;
    mirrors.push({ artwork_id: work.id, image_url: info.thumburl, commons_page: info.descriptionurl, original_url: info.url, commons_file: page.title, license, image_sha1: info.sha1, ...candidate }); break;
  }
}
writeRecord(resolve(here, "image-mirrors.jsonl"), { manifest: { experiment: "visual-search-image-delivery", created: new Date().toISOString(), collection_sha256: sha(readFileSync(resolve(here, "collection.jsonl"), "utf8")) }, result: { method: "Separate delivery layer: public-domain Wikimedia images matched to frozen artwork IDs. Does not change any text scored by Jev.", museum_image_issue: "https://github.com/art-institute-of-chicago/api-data/issues/9", matched: mirrors.length, total: works.length, mirrors } });
console.log(JSON.stringify({ mirrored: mirrors.length, total: works.length, audit_requests: events.length }));
