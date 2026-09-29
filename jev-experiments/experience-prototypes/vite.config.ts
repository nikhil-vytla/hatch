import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { sourceRevisionPlugin } from "./scripts/source-revision";
import type { Plugin } from "vite";
import { gzipPublishedPlugin } from "./scripts/gzip-published";
// transformers.js loads the ONNX runtime from jsDelivr (checked in the built worker's network
// requests), so the 21.6 MB copy Vite would emit is never fetched; leaving it out keeps every
// deployment that much smaller.
const dropUnusedOnnxWasm = (): Plugin => ({
  name: "drop-unused-onnx-wasm",
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) if (/ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
  },
});
const { buildId } = JSON.parse(readFileSync(new URL("./public/capability-build.json", import.meta.url), "utf8"));
if (typeof buildId !== "string" || !/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Prepare the capability metadata before starting Vite.");
export default defineConfig({
  define: { __JEV_CAPABILITY_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    sourceRevisionPlugin(),
    react(),
    tailwind(),
    dropUnusedOnnxWasm(),
    gzipPublishedPlugin(new URL("./vercel.json", import.meta.url).pathname),
  ],
  worker: { plugins: () => [dropUnusedOnnxWasm()] },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { proxy: { "/api": `http://127.0.0.1:${process.env.JEV_API_PORT ?? 8793}` } },
  build: { chunkSizeWarningLimit: 1100 },
});
