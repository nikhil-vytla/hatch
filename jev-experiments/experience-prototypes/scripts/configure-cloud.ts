import "./credentials";
import { spawnSync } from "node:child_process";
const values = {
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY!,
  LAB_ACCESS_TOKEN: process.env.LAB_ACCESS_TOKEN!,
};
for (const [name, value] of Object.entries(values)) {
  if (!value) throw new Error(`Missing ${name}`);
  const p = spawnSync(
    "bunx",
    [
      "--bun",
      "vercel",
      "env",
      "add",
      name,
      "production",
      "--sensitive",
      "--yes",
      "--force",
    ],
    { input: value, encoding: "utf8" },
  );
  let output = p.stdout + p.stderr;
  for (const secret of Object.values(values))
    output = output.replaceAll(secret, "[redacted]");
  console.log(output);
  if (p.status) throw new Error(`Could not configure ${name}`);
}
