import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { webmInfo } from "./media-remux/webm-info";

for (const [stem, manifest] of [["try-on-demo", "recording.json"], ["spoken-try-on-demo", "spoken-recording.json"]]) {
  test(`${stem} has a finite duration, usable front-loaded cues and exact manifest identity`, () => {
    const bytes = readFileSync(new URL(`./assets/${stem}.webm`, import.meta.url));
    const meta = JSON.parse(readFileSync(new URL(`./${manifest}`, import.meta.url), "utf8"));
    const info = webmInfo(bytes);
    expect(Number.isFinite(info.durationSeconds)).toBe(true);
    expect(info.durationSeconds).toBeGreaterThan(29);
    expect(info.durationSeconds).toBeLessThan(31);
    expect(info.cuePoints).toBeGreaterThan(0);
    expect(info.cuePositionsValid).toBe(true);
    expect(info.cuesOffset!).toBeLessThan(info.firstClusterOffset!);
    expect(bytes.length).toBe(meta.videoBytes);
    expect(bytes.length).toBeLessThan(2_000_000);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.videoSha256);
    expect(info.durationSeconds).toBe(meta.containerDurationSeconds);
    expect(meta.actualRecordedSeconds).toBeGreaterThan(info.durationSeconds!);
    const evidence = JSON.parse(readFileSync(new URL("./media-remux/verification.json", import.meta.url), "utf8"));
    const row = evidence.artifacts.find((artifact: any) => artifact.file === `assets/${stem}.webm`);
    expect(row.after.sha256).toBe(meta.videoSha256);
    expect(row.before.sha256).toBe(meta.mediaPostprocessing.originalVideoSha256);
    expect(row.encodedPackets.unchanged).toBe(true);
    expect(row.encodedPackets.timestampsAndTimeBasesUnchanged).toBe(true);
    expect(bytes.includes(Buffer.from("V_VP8"))).toBe(true);
    expect(bytes.includes(Buffer.from("A_OPUS"))).toBe(stem.startsWith("spoken"));
  });
}
