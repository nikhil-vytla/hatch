/** Load doom.wasm and the IWAD: over fetch in the browser, from disk under Bun/Node (`text run`). */
export async function loadAsset(name: string): Promise<Uint8Array> {
  if (typeof document !== "undefined") {
    const res = await fetch(`/${name}`);
    if (!res.ok) throw new Error(`GET /${name} -> ${res.status}${name.endsWith(".wad") ? " (run `bun run wad`)" : ""}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const fs = "node:fs/promises"; // hidden from the browser bundler
  const { readFile } = await import(/* @vite-ignore */ fs);
  const dir = (globalThis as any).process?.env?.DOOM_ASSETS ?? "public";
  return new Uint8Array(await readFile(`${dir}/${name}`));
}
