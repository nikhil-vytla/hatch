import { isRepositoryPath } from "./revision";

/** Raw source bundled with this build; path is relative to the repository root. */
export type SourceFile = { text: string; path: string };
export type SourceMarkers = { start?: string; end?: string; after?: string };
export type SourceExcerpt = {
  text: string;
  startLine: number;
  endLine: number;
};

/** Keep literal source text. A missing or empty selection is explicitly unavailable. */
export function sourceExcerpt(
  source: SourceFile,
  markers: SourceMarkers = {},
): SourceExcerpt | null {
  if (markers.end === "") return null;
  const anchor =
    markers.after === undefined ? 0 : source.text.indexOf(markers.after);
  if (anchor < 0) return null;
  const begin =
    markers.start === undefined
      ? anchor
      : source.text.indexOf(markers.start, anchor);
  if (begin < 0) return null;
  const finish =
    markers.end === undefined
      ? source.text.length
      : source.text.indexOf(markers.end, begin + (markers.start?.length ?? 0));
  if (finish < 0) return null;
  const text = source.text.slice(begin, finish).trimEnd();
  if (!text) return null;
  const startLine = source.text.slice(0, begin).split("\n").length;
  return { text, startLine, endLine: startLine + text.split("\n").length - 1 };
}

export async function sourceSha256(source: SourceFile): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source.text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** General reading links follow the repository. Live code uses pinnedSource. */
export function repoSource(path: string): string | undefined {
  if (!isRepositoryPath(path)) return undefined;
  return `https://github.com/nikhil-vytla/hatch/blob/main/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function pinnedSource(path: string, commit?: string): string | undefined {
  if (!isRepositoryPath(path) || !commit || !/^[a-f0-9]{40}$/.test(commit))
    return undefined;
  return `https://github.com/nikhil-vytla/hatch/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export const sourceFileName = (source: SourceFile) =>
  isRepositoryPath(source.path) ? source.path.split("/").at(-1)! : "source.txt";
