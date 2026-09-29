/**
 * Stores the large published research files gzipped, under their own names, and serves them
 * with `Content-Encoding: gzip` so browsers and scripts decompress them transparently. Every
 * build keeps a full copy of the site in Vercel's Deployment Storage; these JSON and JSONL
 * files are most of it and shrink about sixfold.
 *
 * The header rules in vercel.json decide which files: this plugin gzips exactly the files
 * whose URL path matches a rule that sets `Content-Encoding: gzip`, so the two cannot drift.
 * public/ is untouched; only dist/ changes, after every build-time reader has run.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin, PreviewServer } from "vite";

type Rule = { source: string; headers: { key: string; value: string }[] };

/** The URL paths vercel.json serves gzip-encoded, as anchored regular expressions. */
export function gzipRules(vercelJson: string): RegExp[] {
  const config: { headers?: Rule[] } = JSON.parse(vercelJson);

  return (config.headers ?? [])
    .filter((r) => r.headers.some((h) => h.key.toLowerCase() === "content-encoding" && h.value === "gzip"))
    .map((r) => new RegExp(`^${r.source}$`));
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Gzips, in place, every file under `dist` whose URL path matches a rule. Returns what it did. */
export function gzipPublished(dist: string, rules: RegExp[]) {
  let before = 0;
  let after = 0;
  let files = 0;

  for (const path of walk(dist)) {
    const url = `/${relative(dist, path).split(sep).join("/")}`;

    if (!rules.some((r) => r.test(url))) continue;

    const raw = readFileSync(path);

    // Already gzipped (a rebuilt dist, or a file that was stored compressed): leave it.
    if (raw[0] === 0x1f && raw[1] === 0x8b) continue;

    const gz = gzipSync(raw, { level: 9 });

    writeFileSync(path, gz);
    before += raw.length;
    after += gz.length;
    files++;
  }

  return { files, before, after };
}

/** Vite: gzip after the build, and serve the same headers from `vite preview`. */
export function gzipPublishedPlugin(vercelJsonPath: string): Plugin {
  const rules = gzipRules(readFileSync(vercelJsonPath, "utf8"));
  let outDir = "dist";

  return {
    name: "gzip-published",
    // Builds gzip the files; `vite preview` (which Vite does not count as a build) serves them.
    apply: (_, env) => env.command === "build" || env.isPreview === true,
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const r = gzipPublished(outDir, rules);

      if (r.files)
        console.log(`gzip-published: ${r.files} files, ${(r.before / 1e6).toFixed(1)} MB → ${(r.after / 1e6).toFixed(1)} MB`);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];

        if (rules.some((r) => r.test(url))) res.setHeader("Content-Encoding", "gzip");
        next();
      });
    },
  };
}
