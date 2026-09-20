import { readFileSync } from "node:fs";
import { homedir } from "node:os";
if (!process.env.AI_GATEWAY_API_KEY) {
  const line = readFileSync(homedir() + "/.zshrc", "utf8")
    .split("\n")
    .find((l) => /^\s*(export\s+)?AI_GATEWAY_API_KEY\s*=/.test(l));
  if (line) {
    const v = line
      .replace(/^\s*(export\s+)?AI_GATEWAY_API_KEY\s*=\s*/, "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!/[$`;]/.test(v)) process.env.AI_GATEWAY_API_KEY = v;
  }
}
