import { defineConfig } from "vite";
export default defineConfig({
  server: {
    port: 5178,
    proxy: {
      "/api": "http://127.0.0.1:8792",
      "/results": "http://127.0.0.1:8792",
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
