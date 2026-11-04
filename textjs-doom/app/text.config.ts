import { defineConfig } from "@textjs/app";

export default defineConfig({
  title: "DOOM",
  viewport: { width: 160, height: 61, theme: "geistDark" },
  hints: [
    { keys: "↑ ↓ ← →", label: "move" },
    { keys: "ctrl", label: "fire" },
    { keys: "space", label: "use" },
  ],
  action: "rip and tear",
});
