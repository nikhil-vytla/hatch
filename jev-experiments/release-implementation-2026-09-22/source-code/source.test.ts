import { expect, spyOn, test } from "bun:test";
import { downloadSource } from "../../experience-prototypes/src/components/source-code/download";
import {
  repoSource,
  sourceExcerpt,
  sourceSha256,
} from "../../experience-prototypes/src/components/source-code/source";

test("line bounds locate a repeated instruction within the chosen function", () => {
  const source = {
    path: "src/engine.ts",
    text: "// header\nfunction first() {\n  act();\n}\nfunction second() {\n  act();\n  finish();\n}\n",
  };
  expect(
    sourceExcerpt(source, {
      after: "function second()",
      start: "  act();",
      end: "\n}",
    }),
  ).toEqual({ text: "  act();\n  finish();", startLine: 6, endLine: 7 });
  expect(
    sourceExcerpt(source, {
      start: "function first()",
      end: "\nfunction second()",
    }),
  ).toEqual({
    text: "function first() {\n  act();\n}",
    startLine: 2,
    endLine: 4,
  });
});

test("missing or inverted markers produce no excerpt instead of a crash or wrong function", () => {
  const source = {
    path: "src/engine.ts",
    text: "// before\nfunction current() {}\n// after\n",
  };
  for (const markers of [
    { start: "function deleted()" },
    { start: "function current()", end: "// missing" },
    { start: "function current()", end: "// before" },
    { after: "function deleted()", start: "function current()" },
    { start: "function current()", end: "" },
  ])
    expect(sourceExcerpt(source, markers)).toBeNull();
  expect(sourceExcerpt({ ...source, text: "\n\t" })).toBeNull();
});

test("full and terminal excerpts preserve meaningful whitespace and CRLF line positions", () => {
  const source = {
    path: "src/sample.ts",
    text: "// café\r\n  const x = 2;\r\n\r\n",
  };
  expect(sourceExcerpt(source)).toEqual({
    text: "// café\r\n  const x = 2;",
    startLine: 1,
    endLine: 2,
  });
  expect(sourceExcerpt(source, { start: "  const" })).toEqual({
    text: "  const x = 2;",
    startLine: 2,
    endLine: 2,
  });
});

test("source fingerprints describe bytes, independent of file name or selected excerpt", async () => {
  const source = { text: "abc", path: "src/first.ts" };
  expect(await sourceSha256(source)).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(await sourceSha256({ ...source, path: "src/renamed.ts" })).toBe(
    await sourceSha256(source),
  );
  expect(await sourceSha256({ ...source, text: "abc\n" })).not.toBe(
    await sourceSha256(source),
  );
});

test("the actual download helper saves raw UTF-8 bytes including BOM and line endings", async () => {
  const source = {
    path: "src/café.ts",
    text: "\uFEFF// café\r\nconst answer: number = 2;\r\n\r\n",
  };
  let saved: Blob | undefined;
  let clicked = false;
  const anchor = {
    href: "",
    download: "",
    click() {
      clicked = true;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        expect(tag).toBe("a");
        return anchor;
      },
    },
  });
  const create = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    saved = blob as Blob;
    return "blob:source-fixture";
  });
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    (callback: TimerHandler) => {
      (callback as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  );
  try {
    downloadSource(source);
    expect(clicked).toBe(true);
    expect(anchor.download).toBe("café.ts");
    expect(anchor.href).toBe("blob:source-fixture");
    expect(saved?.type.split(";")[0]).toBe("text/plain");
    expect(new Uint8Array(await saved!.arrayBuffer())).toEqual(
      new TextEncoder().encode(source.text),
    );
    expect(revoke).toHaveBeenCalledWith("blob:source-fixture");
  } finally {
    create.mockRestore();
    revoke.mockRestore();
    timer.mockRestore();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("repository links encode paths and reject absolute or escaping paths", () => {
  expect(repoSource("jev-experiments/source folder/a#b.ts")).toBe(
    "https://github.com/nikhil-vytla/hatch/blob/main/jev-experiments/source%20folder/a%23b.ts",
  );
  for (const path of [
    "/absolute/file.ts",
    "../file.ts",
    "src/../file.ts",
    "https://example.test/file.ts",
    "C:\\source.ts",
    "",
  ])
    expect(repoSource(path)).toBeUndefined();
});
