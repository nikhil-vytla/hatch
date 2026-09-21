// Local recording only. Never import this module from the app or deployed API.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
export function localFalKey() {
  // The user identified .zshrc as the authoritative credential source. This
  // environment had an older inherited FAL_KEY, so prefer the literal file value.
  const existing = process.env.FAL_KEY ?? process.env.FAL_API_KEY;
  const lines = readFileSync(`${homedir()}/.zshrc`, "utf8").split("\n");
  for (const name of ["FAL_KEY", "FAL_API_KEY"]) {
    const line = lines.find((l) =>
      new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l),
    );
    if (!line) continue;
    const value = line
      .replace(new RegExp(`^\\s*(export\\s+)?${name}\\s*=\\s*`), "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (value && !/[$`;\s]/.test(value)) return value;
  }
  if (existing) return existing;
  throw new Error(
    "Set FAL_KEY or FAL_API_KEY locally to record the synthetic presenter.",
  );
}
