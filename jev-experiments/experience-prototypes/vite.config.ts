import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { sourceRevisionPlugin } from "./scripts/source-revision";
const { buildId } = JSON.parse(readFileSync(new URL("./public/capability-build.json", import.meta.url), "utf8"));
if (typeof buildId !== "string" || !/^[a-f0-9]{64}$/.test(buildId)) throw new Error("Prepare the capability metadata before starting Vite.");
export default defineConfig({
  define: { __JEV_CAPABILITY_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [sourceRevisionPlugin(), react(), tailwind()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { proxy: { "/api": `http://127.0.0.1:${process.env.JEV_API_PORT ?? 8793}` } },
  build: { chunkSizeWarningLimit: 1100 },
});
